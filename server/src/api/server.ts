import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';
import { listEvents, createEvent, type ConfigManager } from '../config/manager.js';
import { loadCourse } from '../engine/course.js';
import type { Forwarder } from '../ingest/forwarder.js';
import type { FirebaseHub } from '../outputs/hub.js';
import { resolveRace } from '../config/schema.js';
import { SimEngine, type SimTrackerCfg } from '../sim/engine.js';
import { AuthService, hashPassword } from './auth.js';
import { TunnelManager } from './tunnel.js';

export interface AppHolder {
  app: App;
  /** Rebuild engines/publishers from an edited config (setup UI saves). */
  rebuild: (json: unknown) => void;
  readonly manager: ConfigManager;
  eventsDir: string;
  hub: FirebaseHub;
  forwarder: Forwarder;
  /** Switch the running server to another event file in eventsDir. */
  activateEvent: (file: string) => void;
}

/**
 * REST for operator commands + socket.io for live streaming to the admin UI.
 * Serves the built admin UI (admin-ui/dist) when present, so operators reach
 * the console at http://<server>:<port>/ with nothing else running.
 */
export function startApi(holder: AppHolder, port: number): { httpServer: http.Server; io: SocketIOServer } {
  // Routes capture `app` once, but the holder swaps App instances on config
  // edits/event activation — so resolve every access against the current
  // instance, and bind methods to it so `this` mutations land on the real App.
  const app = new Proxy({} as App, {
    get: (_t, prop) => {
      const current = holder.app as unknown as Record<string | symbol, unknown>;
      const v = current[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(holder.app) : v;
    },
    set: (_t, prop, value) => {
      (holder.app as unknown as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  }) as App;
  const ex = express();
  ex.use(express.json({ limit: '5mb' }));

  const uiDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../admin-ui/dist');
  if (fs.existsSync(path.join(uiDist, 'index.html'))) {
    ex.use(express.static(uiDist));
    // The link to hand viewers: /watch opens straight into PIN entry + view-only.
    ex.get('/watch', (_req, res) => res.sendFile(path.join(uiDist, 'index.html')));
    console.log(`[api] serving admin UI from ${uiDist}`);
  } else {
    console.log('[api] no admin-ui build found — run "npm run build -w admin-ui" to serve the console here');
  }

  const httpServer = http.createServer(ex);
  const io = new SocketIOServer(httpServer, { cors: { origin: true } });
  const auth = new AuthService(app.store);

  io.use((socket, next) => {
    // Machine feeds (e.g. the NYC split-time source) authenticate with the
    // ingest token: socket.io `auth: { token }` or `?token=` on the query.
    const t = (socket.handshake.auth as Record<string, unknown> | undefined)?.token ?? socket.handshake.query?.token;
    if (typeof t === 'string' && auth.ingestTokenValid(t)) {
      socket.data.ingest = true;
      return next();
    }
    const user = auth.check(auth.tokenFromRequest(socket.handshake));
    if (!user) return next(new Error('not authenticated'));
    socket.data.role = user.role;
    next();
  });
  io.on('connection', (socket) => {
    if (socket.data.ingest) {
      console.log('[splits] external feed connected');
      socket.on('disconnect', () => console.log('[splits] external feed disconnected'));
    } else {
      socket.emit('snapshot', app.snapshot());
    }
    // Legacy NYC event name and payload: { tracker, distance, raceTime }.
    // Accepted from the ingest token or any staff/admin session.
    socket.on('raceTimeUpdate', (data) => {
      if (socket.data.ingest || (socket.data.role && socket.data.role !== 'viewer')) {
        app.onSimulatedDistance(data ?? {});
      }
    });
  });

  // --- unauthenticated: first-run bootstrap ---
  // No default credentials exist by design. On a fresh server (zero users)
  // the login screen offers creating the first admin account; the endpoint
  // hard-locks the moment any user exists.
  ex.get('/api/setup-needed', (_req, res) => {
    res.json({ needed: app.store.countUsers() === 0 });
  });

  ex.post('/api/first-admin', (req, res) => {
    if (app.store.countUsers() > 0) {
      return void res.status(403).json({ ok: false, error: 'Setup is already complete' });
    }
    const { username, password } = req.body ?? {};
    if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
      return void res.status(400).json({ ok: false, error: 'Username: 2–32 letters, digits, dot, dash, underscore' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return void res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    }
    app.store.addUser(username, hashPassword(password), 'admin');
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    const token = auth.login(username, password, ip)!;
    res.setHeader('Set-Cookie', auth.cookie(token));
    res.json({ ok: true, username, role: 'admin' });
  });

  // --- unauthenticated: login/logout/me ---
  ex.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    const token = typeof username === 'string' && typeof password === 'string'
      ? auth.login(username, password, ip)
      : null;
    if (!token) return void res.status(401).json({ ok: false, error: 'invalid credentials' });
    res.setHeader('Set-Cookie', auth.cookie(token));
    res.json({ ok: true, username });
  });

  ex.post('/api/viewer-login', (req, res) => {
    const { pin } = req.body ?? {};
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    if (!auth.viewerPinEnabled()) {
      return void res.status(404).json({ ok: false, error: 'Viewer access is not enabled for this server' });
    }
    const token = typeof pin === 'string' ? auth.loginViewer(pin, ip) : null;
    if (!token) return void res.status(401).json({ ok: false, error: 'invalid PIN' });
    res.setHeader('Set-Cookie', auth.cookie(token));
    res.json({ ok: true, username: 'viewer', role: 'viewer' });
  });

  ex.get('/api/viewer-enabled', (_req, res) => {
    res.json({ enabled: auth.viewerPinEnabled() });
  });

  // REST alternative for the split feed: X-Ingest-Token header (or an
  // operator session). Same payload as the socket event.
  ex.post('/api/splits', (req, res) => {
    const headerToken = req.headers['x-ingest-token'];
    const viaToken = typeof headerToken === 'string' && auth.ingestTokenValid(headerToken);
    const ctx = viaToken ? null : auth.check(auth.tokenFromRequest(req));
    if (!viaToken && (!ctx || ctx.role === 'viewer')) {
      return void res.status(401).json({ ok: false, error: 'ingest token or operator session required' });
    }
    const updates = Array.isArray(req.body) ? req.body : [req.body];
    for (const u of updates) app.onSimulatedDistance(u ?? {});
    res.json({ ok: true, accepted: updates.length });
  });

  ex.post('/api/logout', (req, res) => {
    auth.logout(auth.tokenFromRequest(req));
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  ex.get('/api/me', (req, res) => {
    const ctx = auth.check(auth.tokenFromRequest(req));
    if (!ctx) return void res.status(401).json({ ok: false });
    res.json({ ok: true, username: ctx.username, role: ctx.role });
  });

  // --- everything below requires a logged-in operator ---
  ex.use('/api', auth.middleware);

  ex.get('/api/state', (_req, res) => {
    res.json(app.snapshot());
  });

  ex.get('/api/races/:raceId/course', (req, res) => {
    const engine = app.engines.get(req.params.raceId);
    if (!engine) return void res.status(404).json({ error: 'unknown race' });
    res.json({ line: engine.course.line, length: engine.course.length, units: engine.course.units });
  });

  ex.get('/api/devices', (_req, res) => {
    res.json(app.store.devices());
  });

  type OpRequest = express.Request & { operator?: string };
  const act = (fn: (req: OpRequest) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, result: fn(req as OpRequest) ?? null });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

  ex.post(
    '/api/races/:raceId/lifecycle',
    act((req) => app.lifecycle(req.params.raceId as string, req.body.action, req.body.atMs, req.operator)),
  );

  ex.post(
    '/api/races/:raceId/roles/:roleKey/active',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setActive(req.params.roleKey as string, req.body.imei, req.operator);
      io.emit('race', app.raceSnapshot(req.params.raceId as string));
    }),
  );

  ex.post(
    '/api/races/:raceId/roles/:roleKey/source',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setSource(req.params.roleKey as string, req.body.source, (req as OpRequest).operator);
      io.emit('race', app.raceSnapshot(req.params.raceId as string));
    }),
  );

  ex.post(
    '/api/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setWindow(req.params.imei as string, req.body.start, req.body.end, !!req.body.latch, req.operator);
    }),
  );

  ex.delete(
    '/api/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.releaseClamp(req.params.imei as string, req.operator);
    }),
  );

  // --- viewer PIN (operator-managed; middleware blocks viewers from non-GET) ---

  ex.put(
    '/api/viewer-pin',
    auth.adminOnly,
    act((req) => {
      const { pin } = req.body ?? {};
      if (pin === null) {
        auth.setViewerPin(null);
        return;
      }
      if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
        throw new Error('PIN must be 4–12 digits');
      }
      auth.setViewerPin(pin);
    }),
  );

  // --- operator accounts ---

  ex.get('/api/users', auth.adminOnly, (_req, res) => {
    res.json(app.store.listUsers());
  });

  ex.post(
    '/api/users',
    auth.adminOnly,
    act((req) => {
      const { username, password } = req.body ?? {};
      if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
        throw new Error('Username: 2–32 letters, digits, dot, dash, underscore');
      }
      if (typeof password !== 'string' || password.length < 8) {
        throw new Error('Password must be at least 8 characters');
      }
      const role = req.body.role === 'admin' ? 'admin' : 'staff';
      // Demoting the last admin would lock everyone out of setup.
      const existing = app.store.getUser(username);
      if (existing?.role === 'admin' && role !== 'admin' && app.store.countAdmins() <= 1) {
        throw new Error('Cannot demote the last admin');
      }
      app.store.addUser(username, hashPassword(password), role);
    }),
  );

  ex.delete(
    '/api/users/:username',
    auth.adminOnly,
    act((req: express.Request & { operator?: string }) => {
      const username = req.params.username as string;
      if (username === req.operator) throw new Error('You cannot remove the account you are signed in with');
      const target = app.store.getUser(username);
      if (!target) throw new Error('Unknown user');
      if (target.role === 'admin' && app.store.countAdmins() <= 1) {
        throw new Error('Cannot remove the last admin');
      }
      app.store.deleteUser(username);
    }),
  );

  // --- fleet registry ---

  ex.get('/api/fleet', (_req, res) => {
    res.json(app.store.listFleet());
  });

  ex.post(
    '/api/fleet',
    auth.adminOnly,
    act((req) => {
      const { imei, label, model, hasBattery, notes, retired } = req.body ?? {};
      if (!/^\d{15}$/.test(imei ?? '')) throw new Error('IMEI must be 15 digits');
      if (!label || typeof label !== 'string') throw new Error('Label is required');
      app.store.upsertFleet({ imei, label, model, hasBattery: hasBattery !== false, notes, retired: !!retired });
    }),
  );

  ex.delete(
    '/api/fleet/:imei',
    auth.adminOnly,
    act((req) => {
      if (!app.store.deleteFleet(req.params.imei as string)) throw new Error('Unknown tracker');
    }),
  );

  ex.post(
    '/api/publishing',
    act((req) => {
      app.setPublishing(!!req.body.enabled, (req as OpRequest).operator);
    }),
  );

  // --- live ping forwarding (mirror raw tracker frames to other systems) ---

  ex.get('/api/forwards', auth.adminOnly, (_req, res) => {
    res.json(holder.forwarder.status());
  });

  ex.put(
    '/api/forwards',
    auth.adminOnly,
    act((req) => {
      const targets = req.body?.targets;
      if (!Array.isArray(targets)) throw new Error('targets array required');
      holder.forwarder.setTargets(
        targets.map((t: Record<string, unknown>) => ({
          host: String(t.host ?? '').trim(),
          port: Number(t.port),
          enabled: !!t.enabled,
        })),
      );
      return holder.forwarder.status();
    }),
  );

  // --- split feed token management ---

  ex.get('/api/ingest-token', auth.adminOnly, (_req, res) => {
    res.json({ token: auth.ingestToken() ?? null });
  });

  ex.post('/api/ingest-token', auth.adminOnly, (_req, res) => {
    res.json({ ok: true, token: auth.regenerateIngestToken() });
  });

  // --- simulation: export package + run the sim engine against our own listener ---

  let sim: SimEngine | null = null;

  ex.get('/api/export', auth.adminOnly, (_req, res) => {
    const raw = holder.manager.raw;
    const resolved = holder.manager.resolved();
    const courses: Record<string, [number, number][]> = {};
    for (let i = 0; i < resolved.races.length; i++) {
      const rawFile = raw.races[i].course;
      if (!courses[rawFile]) {
        courses[rawFile] = loadCourse(resolved.races[i].course, 'miles').line.geometry.coordinates as [number, number][];
      }
    }
    res.setHeader('Content-Disposition', `attachment; filename="${raw.id}-sim.json"`);
    res.json({ kind: 'ptt-sim-package', exportedAt: new Date().toISOString(), config: raw, courses });
  });

  ex.get('/api/sim', auth.adminOnly, (_req, res) => {
    res.json(sim ? sim.status() : { running: false, trackers: [] });
  });

  ex.post('/api/sim/start', auth.adminOnly, (req, res) => {
    try {
      if (sim?.running) throw new Error('A simulation is already running — stop it first');
      const { raceId, timescale, intervalS, jitterM, paces, extraTargets } = req.body ?? {};
      const engine = app.engines.get(String(raceId));
      if (!engine) throw new Error('unknown race');
      const race = engine.race;
      const { trackers, roles } = resolveRace(holder.manager.resolved(), race);
      const paceMap: Record<string, number> = typeof paces === 'object' && paces ? paces : {};
      const defaultPace = 12;
      const sims: SimTrackerCfg[] = [];
      let roleIdx = 0;
      for (const role of roles) {
        role.trackers.forEach((imei, i) => {
          if (sims.some((s) => s.imei === imei)) return;
          const t = trackers.find((x) => x.imei === imei)!;
          sims.push({
            imei,
            label: t.label,
            paceMph: Number(paceMap[imei]) > 0 ? Number(paceMap[imei]) : defaultPace * (1 - roleIdx * 0.03),
            startOffsetMi: -i * 0.02,
          });
        });
        roleIdx++;
      }
      const port = holder.manager.resolved().listeners[0]?.port ?? 1000;
      // Extra targets: "host:port, host:port" — the same pings also go to
      // other systems (legacy stack, partner ingest) for side-by-side tests.
      const targets = [{ host: '127.0.0.1', port }];
      if (typeof extraTargets === 'string' && extraTargets.trim()) {
        for (const part of extraTargets.split(',')) {
          const m = part.trim().match(/^(.+):(\d+)$/);
          if (!m) throw new Error(`Extra target "${part.trim()}" must be host:port`);
          targets.push({ host: m[1], port: Number(m[2]) });
        }
      }
      sim = new SimEngine(
        {
          targets,
          courseCoords: engine.course.line.geometry.coordinates as [number, number][],
          trackers: sims,
          intervalS: Math.max(1, Number(intervalS) || holder.manager.raw.reportIntervalS || 10),
          timescale: Math.min(240, Math.max(1, Number(timescale) || 10)),
          jitterM: Math.min(100, Math.max(0, Number(jitterM ?? 8))),
        },
        {
          onProgress: (p) => io.emit('sim', p),
          onEnd: (reason) => {
            io.emit('sim', { ...(sim?.status() ?? {}), running: false, endReason: reason });
          },
        },
      );
      sim
        .start()
        .then(() => res.json({ ok: true, result: sim!.status() }))
        .catch((err: Error) => {
          sim = null;
          res.status(400).json({ ok: false, error: err.message });
        });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  ex.post('/api/sim/stop', auth.adminOnly, (_req, res) => {
    sim?.stop('stopped by operator');
    res.json({ ok: true });
  });

  // --- firebase connections: registry, status test, open data browser ---

  ex.get('/api/firebase', auth.adminOnly, (_req, res) => {
    res.json(holder.hub.list());
  });

  ex.post(
    '/api/firebase',
    auth.adminOnly,
    act((req) => {
      const { name, databaseURL, serviceAccount } = req.body ?? {};
      if (typeof name !== 'string' || typeof databaseURL !== 'string' || typeof serviceAccount !== 'object' || !serviceAccount) {
        throw new Error('name, databaseURL, and serviceAccount JSON are required');
      }
      holder.hub.saveConnection(name, databaseURL, serviceAccount);
    }),
  );

  ex.delete(
    '/api/firebase/:name',
    auth.adminOnly,
    act((req) => {
      const name = req.params.name as string;
      const inUse = holder.manager.raw.firebase.some((t) => t.connection === name);
      if (inUse) throw new Error(`Connection "${name}" is used by the active event — remove it from the event first`);
      holder.hub.deleteConnection(name);
    }),
  );

  ex.post('/api/firebase/:name/test', auth.adminOnly, (req, res) => {
    holder.hub
      .test(req.params.name as string)
      .then((result) => res.json(result))
      .catch((err: Error) => res.json({ ok: false, error: err.message }));
  });

  ex.get('/api/firebase/:name/data', auth.adminOnly, (req, res) => {
    holder.hub
      .read(req.params.name as string, String(req.query.path ?? ''))
      .then((value) => res.json({ ok: true, value }))
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  ex.put('/api/firebase/:name/data', auth.adminOnly, (req, res) => {
    const { path: refPath, value, method } = req.body ?? {};
    const m = method === 'update' || method === 'delete' ? method : 'set';
    holder.hub
      .write(req.params.name as string, String(refPath ?? ''), value, m)
      .then(() => {
        app.store.recordPublish(null, `manual:${req.params.name}`, String(refPath), m === 'delete' ? null : value);
        res.json({ ok: true });
      })
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  // --- remote access (ngrok tunnel for the console) ---

  const tunnel = new TunnelManager(app.store, port);
  if (app.store.getSetting('ngrok-enabled') === '1') {
    tunnel.start().catch((err) => console.error('[tunnel] startup failed:', err));
  }

  ex.get('/api/tunnel', auth.adminOnly, (_req, res) => {
    res.json(tunnel.status());
  });

  ex.put('/api/tunnel', auth.adminOnly, (req, res) => {
    const { enabled, domain, authtoken } = req.body ?? {};
    tunnel
      .apply({
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        domain: typeof domain === 'string' ? domain : undefined,
        authtoken: typeof authtoken === 'string' ? authtoken : undefined,
      })
      .then((status) => res.json({ ok: true, result: status }))
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  // --- setup: event config + courses ---

  const guardIdle = () => {
    for (const engine of app.engines.values()) {
      if (engine.status === 'armed' || engine.status === 'live') {
        throw new Error(`Race "${engine.race.id}" is ${engine.status} — finish or reset it before editing setup`);
      }
    }
  };

  // --- event library ---

  ex.get('/api/events', (_req, res) => {
    res.json({ active: holder.manager.raw.id, events: listEvents(holder.eventsDir) });
  });

  ex.post(
    '/api/events',
    auth.adminOnly,
    act((req) => {
      const { id, name, meetId, copyFromFile } = req.body ?? {};
      if (!name || typeof name !== 'string') throw new Error('Event name is required');
      return { file: createEvent(holder.eventsDir, { id: id || name, name, meetId: Number(meetId) || 0, copyFromFile }) };
    }),
  );

  ex.post(
    '/api/events/:file/activate',
    auth.adminOnly,
    act((req) => {
      guardIdle();
      const file = req.params.file as string;
      const listing = listEvents(holder.eventsDir).find((e) => e.file === file);
      if (!listing) throw new Error(`Unknown event file: ${file}`);
      if (listing.error) throw new Error(`Event file is invalid: ${listing.error}`);
      holder.activateEvent(file);
      io.emit('snapshot', holder.app.snapshot());
    }),
  );

  ex.get('/api/config', (_req, res) => {
    res.json(holder.manager.raw);
  });

  ex.put(
    '/api/config',
    auth.adminOnly,
    act((req) => {
      guardIdle();
      holder.rebuild(req.body);
      io.emit('snapshot', holder.app.snapshot());
    }),
  );

  ex.get('/api/courses', (_req, res) => {
    res.json(holder.manager.listCourses());
  });

  ex.post(
    '/api/courses/:name',
    auth.adminOnly,
    express.text({ type: () => true, limit: '25mb' }),
    act((req) => {
      if (typeof req.body !== 'string' || req.body.length === 0) throw new Error('Empty upload');
      return holder.manager.saveCourse(req.params.name as string, req.body);
    }),
  );

  httpServer.listen(port, () => {
    console.log(`[api] http + socket.io on :${port}`);
  });
  return { httpServer, io };
}

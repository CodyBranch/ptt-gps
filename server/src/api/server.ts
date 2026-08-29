import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';
import { listEvents, createEvent, eventRosters, listCoursesIn, saveCourseIn, type ConfigManager } from '../config/manager.js';
import { loadCourse } from '../engine/course.js';
import type { Forwarder } from '../ingest/forwarder.js';
import type { FixGate } from '../ingest/hygiene.js';
import type { FirebaseHub } from '../outputs/hub.js';
import type { Store } from '../state/store.js';
import { resolveRace } from '../config/schema.js';
import { SimEngine, type SimTrackerCfg } from '../sim/engine.js';
import { AuthService, hashPassword, type Role } from './auth.js';
import { TunnelManager } from './tunnel.js';

/** Everything the API needs from the multi-event runtime in index.ts. */
export interface ServerContext {
  store: Store;
  hub: FirebaseHub;
  forwarder: Forwarder;
  eventsDir: string;
  apps: Map<string, App>;
  managers: Map<string, ConfigManager>;
  gate: FixGate;
  lastSeen: Map<string, number>;
  setPublishing: (eventId: string, enabled: boolean, by?: string) => void;
  loadEvent: (file: string) => App;
  unloadEvent: (eventId: string) => void;
  rebuildEvent: (eventId: string, json: unknown) => void;
  snapshotAll: () => unknown;
  snapshotFor: (eventId: string) => unknown;
  onSimulatedDistance: (data: Record<string, unknown>) => void;
}

export function startApi(ctx: ServerContext, port: number): { httpServer: http.Server; io: SocketIOServer; broadcast: (event: string, payload: unknown) => void } {
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
  const auth = new AuthService(ctx.store);

  /** Event-tagged payloads go to full-access clients and that event's scoped
   *  viewers; untagged (global) payloads go to everyone. */
  const broadcast = (event: string, payload: unknown): void => {
    const eid = (payload as { eventId?: unknown } | undefined)?.eventId;
    if (typeof eid === 'string') io.to('all-events').to(`ev:${eid}`).emit(event, payload);
    else io.emit(event, payload);
  };
  const broadcastSnapshot = (): void => {
    io.to('all-events').emit('snapshot', ctx.snapshotAll());
    for (const id of ctx.apps.keys()) io.to(`ev:${id}`).emit('snapshot', ctx.snapshotFor(id));
  };

  io.use((socket, next) => {
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
  io.use((socket, next) => {
    // room membership drives which live updates each client receives
    if (socket.data.ingest) return next();
    const c = auth.check(auth.tokenFromRequest(socket.handshake));
    socket.data.eventScope = c?.eventScope;
    next();
  });
  io.on('connection', (socket) => {
    if (socket.data.ingest) {
      console.log('[splits] external feed connected');
      socket.on('disconnect', () => console.log('[splits] external feed disconnected'));
    } else if (typeof socket.data.eventScope === 'string') {
      socket.join(`ev:${socket.data.eventScope}`);
      socket.emit('snapshot', ctx.snapshotFor(socket.data.eventScope));
    } else {
      socket.join('all-events');
      socket.emit('snapshot', ctx.snapshotAll());
    }
    // Legacy NYC split feed: raceTimeUpdate { tracker, distance, raceTime }.
    socket.on('raceTimeUpdate', (data) => {
      if (socket.data.ingest || (socket.data.role && socket.data.role !== 'viewer')) {
        ctx.onSimulatedDistance(data ?? {});
      }
    });
  });

  // --- unauthenticated: first-run bootstrap ---
  ex.get('/api/setup-needed', (_req, res) => {
    res.json({ needed: ctx.store.countUsers() === 0 });
  });

  ex.post('/api/first-admin', (req, res) => {
    if (ctx.store.countUsers() > 0) {
      return void res.status(403).json({ ok: false, error: 'Setup is already complete' });
    }
    const { username, password } = req.body ?? {};
    if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
      return void res.status(400).json({ ok: false, error: 'Username: 2–32 letters, digits, dot, dash, underscore' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return void res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
    }
    ctx.store.addUser(username, hashPassword(password), 'admin');
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    const token = auth.login(username, password, ip)!;
    res.setHeader('Set-Cookie', auth.cookie(token));
    res.json({ ok: true, username, role: 'admin' });
  });

  // --- unauthenticated: login/logout/me + split feed ingest ---
  ex.post('/api/login', (req, res) => {
    const { username, password } = req.body ?? {};
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    const token =
      typeof username === 'string' && typeof password === 'string' ? auth.login(username, password, ip) : null;
    if (!token) return void res.status(401).json({ ok: false, error: 'invalid credentials' });
    const role = ctx.store.getUser(username)?.role === 'admin' ? 'admin' : 'staff';
    res.setHeader('Set-Cookie', auth.cookie(token));
    res.json({ ok: true, username, role });
  });

  ex.post('/api/viewer-login', (req, res) => {
    const { pin } = req.body ?? {};
    const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
    if (!auth.anyViewerPinEnabled()) {
      return void res.status(404).json({ ok: false, error: 'Viewer access is not enabled for this server' });
    }
    const result = typeof pin === 'string' ? auth.loginViewer(pin, ip) : null;
    if (!result) return void res.status(401).json({ ok: false, error: 'invalid PIN' });
    res.setHeader('Set-Cookie', auth.cookie(result.token));
    res.json({ ok: true, username: 'viewer', role: 'viewer', eventScope: result.eventScope ?? null });
  });

  ex.get('/api/viewer-enabled', (_req, res) => {
    res.json({ enabled: auth.anyViewerPinEnabled() });
  });

  ex.post('/api/splits', (req, res) => {
    const headerToken = req.headers['x-ingest-token'];
    const viaToken = typeof headerToken === 'string' && auth.ingestTokenValid(headerToken);
    const c = viaToken ? null : auth.check(auth.tokenFromRequest(req));
    if (!viaToken && (!c || c.role === 'viewer')) {
      return void res.status(401).json({ ok: false, error: 'ingest token or operator session required' });
    }
    const updates = Array.isArray(req.body) ? req.body : [req.body];
    for (const u of updates) ctx.onSimulatedDistance(u ?? {});
    res.json({ ok: true, accepted: updates.length });
  });

  ex.post('/api/logout', (req, res) => {
    auth.logout(auth.tokenFromRequest(req));
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  ex.get('/api/me', (req, res) => {
    const c = auth.check(auth.tokenFromRequest(req));
    if (!c) return void res.status(401).json({ ok: false });
    res.json({ ok: true, username: c.username, role: c.role, eventScope: c.eventScope ?? null });
  });

  // --- everything below requires a logged-in operator ---
  ex.use('/api', auth.middleware);

  type OpRequest = express.Request & { operator?: string; role?: Role };
  const act = (fn: (req: OpRequest) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, result: fn(req as OpRequest) ?? null });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

  const eventApp = (req: express.Request): App => {
    const app = ctx.apps.get(req.params.eventId as string);
    if (!app) throw new Error(`Event "${req.params.eventId}" is not active`);
    return app;
  };
  const eventManager = (req: express.Request): ConfigManager => {
    const m = ctx.managers.get(req.params.eventId as string);
    if (!m) throw new Error(`Event "${req.params.eventId}" is not active`);
    return m;
  };

  ex.get('/api/state', (req, res) => {
    const scope = (req as OpRequest & { eventScope?: string }).eventScope;
    res.json(scope !== undefined ? ctx.snapshotFor(scope) : ctx.snapshotAll());
  });

  ex.get('/api/devices', (_req, res) => {
    res.json(ctx.store.devices());
  });

  // --- race operations (event-scoped) ---

  ex.get('/api/events/:eventId/races/:raceId/course', (req, res) => {
    try {
      const engine = eventApp(req).engines.get(req.params.raceId as string);
      if (!engine) return void res.status(404).json({ error: 'unknown race' });
      res.json({ line: engine.course.line, length: engine.course.length, units: engine.course.units });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  ex.post(
    '/api/events/:eventId/races/:raceId/lifecycle',
    act((req) => eventApp(req).lifecycle(req.params.raceId as string, req.body.action, req.body.atMs, req.operator)),
  );

  ex.post(
    '/api/events/:eventId/races/:raceId/roles/:roleKey/active',
    act((req) => {
      const app = eventApp(req);
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setActive(req.params.roleKey as string, req.body.imei, req.operator);
      broadcast('race', app.raceSnapshot(req.params.raceId as string));
    }),
  );

  ex.post(
    '/api/events/:eventId/races/:raceId/roles/:roleKey/source',
    act((req) => {
      const app = eventApp(req);
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setSource(req.params.roleKey as string, req.body.source, req.operator);
      broadcast('race', app.raceSnapshot(req.params.raceId as string));
    }),
  );

  ex.post(
    '/api/events/:eventId/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = eventApp(req).engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setWindow(req.params.imei as string, req.body.start, req.body.end, !!req.body.latch, req.operator);
    }),
  );

  ex.delete(
    '/api/events/:eventId/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = eventApp(req).engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.releaseClamp(req.params.imei as string, req.operator);
    }),
  );

  ex.post(
    '/api/events/:eventId/publishing',
    act((req) => {
      ctx.setPublishing(req.params.eventId as string, !!req.body.enabled, (req as OpRequest).operator);
    }),
  );

  // --- event library ---

  ex.get('/api/events', (_req, res) => {
    res.json({ loaded: [...ctx.apps.keys()], events: listEvents(ctx.eventsDir) });
  });

  ex.post(
    '/api/events',
    auth.adminOnly,
    act((req: OpRequest) => {
      const { id, name, meetId, startDate, endDate, copyFromFile } = req.body ?? {};
      if (!name || typeof name !== 'string') throw new Error('Event name is required');
      const file = createEvent(ctx.eventsDir, { id: id || name, name, meetId: Number(meetId) || 0, copyFromFile });
      // dates are plain fields — patch them into the new file
      if (startDate || endDate) {
        const p = path.join(ctx.eventsDir, file);
        const json = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (typeof startDate === 'string' && startDate) json.startDate = startDate;
        if (typeof endDate === 'string' && endDate) json.endDate = endDate;
        fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
      }
      const roster = eventRosters(ctx.eventsDir).find((r) => r.file === file);
      for (const imei of roster?.imeis ?? []) {
        ctx.store.recordAssignment(imei, roster!.id, roster!.name, 'added', req.operator);
      }
      return { file };
    }),
  );

  ex.post(
    '/api/events/:file/load',
    auth.adminOnly,
    act((req) => {
      const file = req.params.file as string;
      const listing = listEvents(ctx.eventsDir).find((e) => e.file === file);
      if (!listing) throw new Error(`Unknown event file: ${file}`);
      if (listing.error) throw new Error(`Event file is invalid: ${listing.error}`);
      ctx.loadEvent(file);
      broadcastSnapshot();
    }),
  );

  ex.post(
    '/api/events/:eventId/unload',
    auth.adminOnly,
    act((req) => {
      ctx.unloadEvent(req.params.eventId as string);
      broadcastSnapshot();
    }),
  );

  // --- event setup (config editing, event-scoped) ---

  ex.get('/api/events/:eventId/config', (req, res) => {
    try {
      res.json(eventManager(req).raw);
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  ex.put(
    '/api/events/:eventId/config',
    auth.adminOnly,
    act((req: OpRequest) => {
      const app = eventApp(req);
      if (app.hasActiveRaces()) throw new Error('A race is armed or live — finish or reset it before editing setup');
      const manager = eventManager(req);
      const before = new Set(manager.raw.trackers.map((t) => t.imei));
      ctx.rebuildEvent(req.params.eventId as string, req.body);
      const raw = [...ctx.managers.values()].find((m) => m.raw.id === (req.body as { id?: string })?.id)?.raw ?? manager.raw;
      const after = new Set(raw.trackers.map((t) => t.imei));
      for (const imei of after) {
        if (!before.has(imei)) ctx.store.recordAssignment(imei, raw.id, raw.name, 'added', req.operator);
      }
      for (const imei of before) {
        if (!after.has(imei)) ctx.store.recordAssignment(imei, raw.id, raw.name, 'removed', req.operator);
      }
      broadcastSnapshot();
    }),
  );

  ex.get('/api/events/:eventId/export', auth.adminOnly, (req, res) => {
    try {
      const manager = eventManager(req);
      const raw = manager.raw;
      const resolved = manager.resolved();
      const courses: Record<string, [number, number][]> = {};
      for (let i = 0; i < resolved.races.length; i++) {
        const rawFile = raw.races[i].course;
        if (!courses[rawFile]) {
          courses[rawFile] = loadCourse(resolved.races[i].course, 'miles').line.geometry.coordinates as [number, number][];
        }
      }
      res.setHeader('Content-Disposition', `attachment; filename="${raw.id}-sim.json"`);
      res.json({ kind: 'ptt-sim-package', exportedAt: new Date().toISOString(), config: raw, courses });
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  // --- courses (shared across events) ---

  ex.get('/api/courses', (_req, res) => {
    res.json(listCoursesIn(ctx.eventsDir));
  });

  ex.post(
    '/api/courses/:name',
    auth.adminOnly,
    express.text({ type: () => true, limit: '25mb' }),
    act((req) => {
      if (typeof req.body !== 'string' || req.body.length === 0) throw new Error('Empty upload');
      return saveCourseIn(ctx.eventsDir, req.params.name as string, req.body);
    }),
  );

  // --- operator accounts ---

  ex.get('/api/users', auth.adminOnly, (_req, res) => {
    res.json(ctx.store.listUsers());
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
      const existing = ctx.store.getUser(username);
      if (existing?.role === 'admin' && role !== 'admin' && ctx.store.countAdmins() <= 1) {
        throw new Error('Cannot demote the last admin');
      }
      ctx.store.addUser(username, hashPassword(password), role);
    }),
  );

  ex.delete(
    '/api/users/:username',
    auth.adminOnly,
    act((req: OpRequest) => {
      const username = req.params.username as string;
      if (username === req.operator) throw new Error('You cannot remove the account you are signed in with');
      const target = ctx.store.getUser(username);
      if (!target) throw new Error('Unknown user');
      if (target.role === 'admin' && ctx.store.countAdmins() <= 1) {
        throw new Error('Cannot remove the last admin');
      }
      ctx.store.deleteUser(username);
    }),
  );

  ex.get('/api/events/:eventId/viewer-pin', (req, res) => {
    res.json({ enabled: auth.viewerPinEnabled(req.params.eventId as string) });
  });

  ex.put(
    '/api/events/:eventId/viewer-pin',
    auth.adminOnly,
    act((req) => {
      const { pin } = req.body ?? {};
      if (pin === null) {
        auth.setViewerPin(null, req.params.eventId as string);
        return;
      }
      if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
        throw new Error('PIN must be 4-12 digits');
      }
      auth.setViewerPin(pin, req.params.eventId as string);
    }),
  );

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

  // --- device owners ---

  ex.get('/api/owners', (_req, res) => {
    res.json(ctx.store.listOwners());
  });

  ex.post(
    '/api/owners',
    auth.adminOnly,
    act((req) => ctx.store.addOwner(String(req.body?.name ?? ''))),
  );

  ex.delete(
    '/api/owners/:id',
    auth.adminOnly,
    act((req) => {
      ctx.store.deleteOwner(Number(req.params.id));
    }),
  );

  // --- fleet registry ---

  ex.get('/api/fleet', (_req, res) => {
    const rosters = eventRosters(ctx.eventsDir);
    const loaded = new Set(ctx.apps.keys());
    const issueCounts = ctx.store.openIssueCounts();
    const rows = (ctx.store.listFleet() as Array<Record<string, unknown>>).map((f) => ({
      ...f,
      events: rosters
        .filter((r) => r.imeis.includes(f.imei as string))
        .map((r) => ({ id: r.id, name: r.name, active: loaded.has(r.id) })),
      openIssues: issueCounts.get(f.imei as string) ?? 0,
    }));
    res.json(rows);
  });

  ex.get('/api/fleet/:imei/history', (req, res) => {
    res.json({
      assignments: ctx.store.listAssignments(req.params.imei as string),
      issues: ctx.store.listIssues(req.params.imei as string),
    });
  });

  ex.post(
    '/api/fleet/:imei/issues',
    act((req: OpRequest) => {
      const id = ctx.store.addIssue(
        req.params.imei as string,
        String(req.body?.text ?? ''),
        String(req.body?.severity ?? 'issue'),
        req.operator,
      );
      return { id };
    }),
  );

  ex.post(
    '/api/fleet/issues/:id/resolve',
    act((req: OpRequest) => {
      ctx.store.resolveIssue(Number(req.params.id), req.operator);
    }),
  );

  ex.post(
    '/api/fleet',
    auth.adminOnly,
    act((req) => {
      const { imei, label, model, hasBattery, notes, ownerId, retired } = req.body ?? {};
      if (!/^\d{15}$/.test(imei ?? '')) throw new Error('IMEI must be 15 digits');
      if (!label || typeof label !== 'string') throw new Error('Label is required');
      ctx.store.upsertFleet({
        imei,
        label,
        model,
        hasBattery: hasBattery !== false,
        notes,
        ownerId: ownerId == null ? null : Number(ownerId),
        retired: !!retired,
      });
    }),
  );

  ex.delete(
    '/api/fleet/:imei',
    auth.adminOnly,
    act((req) => {
      if (!ctx.store.deleteFleet(req.params.imei as string)) throw new Error('Unknown tracker');
    }),
  );

  // --- firebase connections ---

  ex.get('/api/firebase', auth.adminOnly, (_req, res) => {
    res.json(ctx.hub.list());
  });

  ex.post(
    '/api/firebase',
    auth.adminOnly,
    act((req) => {
      const { name, databaseURL, serviceAccount } = req.body ?? {};
      if (typeof name !== 'string' || typeof databaseURL !== 'string' || typeof serviceAccount !== 'object' || !serviceAccount) {
        throw new Error('name, databaseURL, and serviceAccount JSON are required');
      }
      ctx.hub.saveConnection(name, databaseURL, serviceAccount);
    }),
  );

  ex.delete(
    '/api/firebase/:name',
    auth.adminOnly,
    act((req) => {
      const name = req.params.name as string;
      for (const m of ctx.managers.values()) {
        if (m.raw.firebase.some((t) => t.connection === name)) {
          throw new Error(`Connection "${name}" is used by active event "${m.raw.id}" — remove it from the event first`);
        }
      }
      ctx.hub.deleteConnection(name);
    }),
  );

  ex.post('/api/firebase/:name/test', auth.adminOnly, (req, res) => {
    ctx.hub
      .test(req.params.name as string)
      .then((result) => res.json(result))
      .catch((err: Error) => res.json({ ok: false, error: err.message }));
  });

  ex.get('/api/firebase/:name/data', auth.adminOnly, (req, res) => {
    ctx.hub
      .read(req.params.name as string, String(req.query.path ?? ''))
      .then((value) => res.json({ ok: true, value }))
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  ex.put('/api/firebase/:name/data', auth.adminOnly, (req, res) => {
    const { path: refPath, value, method } = req.body ?? {};
    const m = method === 'update' || method === 'delete' ? method : 'set';
    ctx.hub
      .write(req.params.name as string, String(refPath ?? ''), value, m)
      .then(() => {
        ctx.store.recordPublish(null, `manual:${req.params.name}`, String(refPath), m === 'delete' ? null : value);
        res.json({ ok: true });
      })
      .catch((err: Error) => res.status(400).json({ ok: false, error: err.message }));
  });

  // --- live ping forwarding ---

  ex.get('/api/forwards', auth.adminOnly, (_req, res) => {
    res.json(ctx.forwarder.status());
  });

  ex.put(
    '/api/forwards',
    auth.adminOnly,
    act((req) => {
      const targets = req.body?.targets;
      if (!Array.isArray(targets)) throw new Error('targets array required');
      ctx.forwarder.setTargets(
        targets.map((t: Record<string, unknown>) => ({
          host: String(t.host ?? '').trim(),
          port: Number(t.port),
          enabled: !!t.enabled,
        })),
      );
      return ctx.forwarder.status();
    }),
  );

  // --- split feed token ---

  ex.get('/api/ingest-token', auth.adminOnly, (_req, res) => {
    res.json({ token: auth.ingestToken() ?? null });
  });

  ex.post('/api/ingest-token', auth.adminOnly, (_req, res) => {
    res.json({ ok: true, token: auth.regenerateIngestToken() });
  });

  // --- simulation ---

  let sim: SimEngine | null = null;

  ex.get('/api/sim', auth.adminOnly, (_req, res) => {
    res.json(sim ? sim.status() : { running: false, trackers: [], targets: [] });
  });

  ex.post('/api/sim/start', auth.adminOnly, (req, res) => {
    try {
      if (sim?.running) throw new Error('A simulation is already running — stop it first');
      const { eventId, raceId, timescale, intervalS, jitterM, paces, extraTargets } = req.body ?? {};
      const app = ctx.apps.get(String(eventId));
      const manager = ctx.managers.get(String(eventId));
      if (!app || !manager) throw new Error(`Event "${eventId}" is not active`);
      const engine = app.engines.get(String(raceId));
      if (!engine) throw new Error('unknown race');
      const { trackers, roles } = resolveRace(manager.resolved(), engine.race);
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
      const port = manager.resolved().listeners[0]?.port ?? 1000;
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
          intervalS: Math.max(1, Number(intervalS) || manager.raw.reportIntervalS || 10),
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

  // --- remote access (ngrok) ---

  const tunnel = new TunnelManager(ctx.store, port);
  if (ctx.store.getSetting('ngrok-enabled') === '1') {
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

  httpServer.listen(port, () => {
    console.log(`[api] http + socket.io on :${port}`);
  });
  return { httpServer, io, broadcast };
}

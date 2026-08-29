import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';
import { listEvents, createEvent, type ConfigManager } from '../config/manager.js';
import { AuthService, hashPassword } from './auth.js';

export interface AppHolder {
  app: App;
  /** Rebuild engines/publishers from an edited config (setup UI saves). */
  rebuild: (json: unknown) => void;
  readonly manager: ConfigManager;
  eventsDir: string;
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
    console.log(`[api] serving admin UI from ${uiDist}`);
  } else {
    console.log('[api] no admin-ui build found — run "npm run build -w admin-ui" to serve the console here');
  }

  const httpServer = http.createServer(ex);
  const io = new SocketIOServer(httpServer, { cors: { origin: true } });
  const auth = new AuthService(app.store);

  io.use((socket, next) => {
    const user = auth.check(auth.tokenFromRequest(socket.handshake));
    if (!user) return next(new Error('not authenticated'));
    next();
  });
  io.on('connection', (socket) => {
    socket.emit('snapshot', app.snapshot());
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

  ex.get('/api/users', (_req, res) => {
    res.json(app.store.listUsers());
  });

  ex.post(
    '/api/users',
    act((req) => {
      const { username, password } = req.body ?? {};
      if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
        throw new Error('Username: 2–32 letters, digits, dot, dash, underscore');
      }
      if (typeof password !== 'string' || password.length < 8) {
        throw new Error('Password must be at least 8 characters');
      }
      app.store.addUser(username, hashPassword(password));
    }),
  );

  ex.delete(
    '/api/users/:username',
    act((req: express.Request & { operator?: string }) => {
      const username = req.params.username as string;
      if (username === req.operator) throw new Error('You cannot remove the account you are signed in with');
      const remaining = app.store.listUsers().filter((u) => u.username !== username);
      if (remaining.length === 0) throw new Error('Cannot remove the last user');
      if (!app.store.deleteUser(username)) throw new Error('Unknown user');
    }),
  );

  // --- fleet registry ---

  ex.get('/api/fleet', (_req, res) => {
    res.json(app.store.listFleet());
  });

  ex.post(
    '/api/fleet',
    act((req) => {
      const { imei, label, model, hasBattery, notes, retired } = req.body ?? {};
      if (!/^\d{15}$/.test(imei ?? '')) throw new Error('IMEI must be 15 digits');
      if (!label || typeof label !== 'string') throw new Error('Label is required');
      app.store.upsertFleet({ imei, label, model, hasBattery: hasBattery !== false, notes, retired: !!retired });
    }),
  );

  ex.delete(
    '/api/fleet/:imei',
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
    act((req) => {
      const { id, name, meetId, copyFromFile } = req.body ?? {};
      if (!name || typeof name !== 'string') throw new Error('Event name is required');
      return { file: createEvent(holder.eventsDir, { id: id || name, name, meetId: Number(meetId) || 0, copyFromFile }) };
    }),
  );

  ex.post(
    '/api/events/:file/activate',
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

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';
import type { ConfigManager } from '../config/manager.js';
import { AuthService } from './auth.js';

export interface AppHolder {
  app: App;
  /** Rebuild engines/publishers from an edited config (setup UI saves). */
  rebuild: (json: unknown) => void;
  manager: ConfigManager;
}

/**
 * REST for operator commands + socket.io for live streaming to the admin UI.
 * Serves the built admin UI (admin-ui/dist) when present, so operators reach
 * the console at http://<server>:<port>/ with nothing else running.
 */
export function startApi(holder: AppHolder, port: number): { httpServer: http.Server; io: SocketIOServer } {
  const app = new Proxy({} as App, {
    get: (_t, prop) => (holder.app as unknown as Record<string | symbol, unknown>)[prop],
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

  ex.post('/api/logout', (req, res) => {
    auth.logout(auth.tokenFromRequest(req));
    res.setHeader('Set-Cookie', auth.clearCookie());
    res.json({ ok: true });
  });

  ex.get('/api/me', (req, res) => {
    const user = auth.check(auth.tokenFromRequest(req));
    if (!user) return void res.status(401).json({ ok: false });
    res.json({ ok: true, username: user });
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

  // --- setup: event config + courses ---

  const guardIdle = () => {
    for (const engine of app.engines.values()) {
      if (engine.status === 'armed' || engine.status === 'live') {
        throw new Error(`Race "${engine.race.id}" is ${engine.status} — finish or reset it before editing setup`);
      }
    }
  };

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

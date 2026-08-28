import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';

/**
 * REST for operator commands + socket.io for live streaming to the admin UI.
 * Serves the built admin UI (admin-ui/dist) when present, so operators reach
 * the console at http://<server>:<port>/ with nothing else running.
 */
export function startApi(app: App, port: number): { httpServer: http.Server; io: SocketIOServer } {
  const ex = express();
  ex.use(express.json());

  const uiDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../admin-ui/dist');
  if (fs.existsSync(path.join(uiDist, 'index.html'))) {
    ex.use(express.static(uiDist));
    console.log(`[api] serving admin UI from ${uiDist}`);
  } else {
    console.log('[api] no admin-ui build found — run "npm run build -w admin-ui" to serve the console here');
  }

  const httpServer = http.createServer(ex);
  const io = new SocketIOServer(httpServer, { cors: { origin: true } });

  io.on('connection', (socket) => {
    socket.emit('snapshot', app.snapshot());
  });

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

  const act = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, result: fn(req) ?? null });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

  ex.post(
    '/api/races/:raceId/lifecycle',
    act((req) => app.lifecycle(req.params.raceId as string, req.body.action, req.body.atMs)),
  );

  ex.post(
    '/api/races/:raceId/roles/:roleKey/active',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setActive(req.params.roleKey as string, req.body.imei);
      io.emit('race', app.raceSnapshot(req.params.raceId as string));
    }),
  );

  ex.post(
    '/api/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setWindow(req.params.imei as string, req.body.start, req.body.end, !!req.body.latch);
    }),
  );

  ex.delete(
    '/api/races/:raceId/trackers/:imei/window',
    act((req) => {
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.releaseClamp(req.params.imei as string);
    }),
  );

  httpServer.listen(port, () => {
    console.log(`[api] http + socket.io on :${port}`);
  });
  return { httpServer, io };
}

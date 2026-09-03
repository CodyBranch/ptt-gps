import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { App } from '../app.js';
import {
  listEvents,
  createEvent,
  eventRosters,
  listCoursesIn,
  saveCourseIn,
  courseUsage,
  renameCourseIn,
  deleteCourseIn,
  readCourseIn,
  ConfigManager,
} from '../config/manager.js';
import { loadCourse, placeMarkers, locateOnCourse } from '../engine/course.js';
import type { Forwarder } from '../ingest/forwarder.js';
import type { FixGate } from '../ingest/hygiene.js';
import type { FirebaseHub } from '../outputs/hub.js';
import type { Store } from '../state/store.js';
import { resolveRace } from '../config/schema.js';
import * as turf from '@turf/turf';
import { SimEngine, type SimTrackerCfg } from '../sim/engine.js';
import type { DecoderPoller } from '../decoders/poller.js';
import { AuthService, hashPassword, type Role } from './auth.js';
import { TunnelManager } from './tunnel.js';
import { DeployManager } from '../deploy/manager.js';
import { attachFeed } from './feed.js';

/** Everything the API needs from the multi-event runtime in index.ts. */
export interface ServerContext {
  store: Store;
  hub: FirebaseHub;
  forwarder: Forwarder;
  eventsDir: string;
  /** Where the database lives; deploy status is written beside it. */
  dataDir: string;
  apps: Map<string, App>;
  managers: Map<string, ConfigManager>;
  gate: FixGate;
  lastSeen: Map<string, number>;
  setPublishing: (eventId: string, enabled: boolean, by?: string) => void;
  loadEvent: (file: string) => App;
  unloadEvent: (eventId: string) => void;
  rebuildEvent: (eventId: string, json: unknown) => void;
  updateEvent: (eventId: string, json: unknown) => void;
  decoders: DecoderPoller;
  moveTracker: (eventId: string, imei: string, vehicleKey: string, by?: string) => void;
  snapshotAll: () => unknown;
  snapshotFor: (eventId: string) => unknown;
  onSimulatedDistance: (data: Record<string, unknown>) => void;
}

export function startApi(
  ctx: ServerContext,
  port: number,
): {
  httpServer: http.Server;
  io: SocketIOServer;
  broadcast: (event: string, payload: unknown) => void;
  emitRaw: (raw: string | Buffer, source: string, ip: string) => void;
} {
  const ex = express();
  ex.use(express.json({ limit: '5mb' }));

  /**
   * What this build calls itself, so the console can say whether the server it
   * is talking to is the one that was deployed. Walked up from this module
   * rather than hard-coded, so it is right whether running from source or dist.
   */
  const serverVersion = (() => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const p = path.join(dir, 'package.json');
      if (fs.existsSync(p)) {
        try {
          return String(JSON.parse(fs.readFileSync(p, 'utf8')).version ?? 'unknown');
        } catch {
          break;
        }
      }
      dir = path.dirname(dir);
    }
    return 'unknown';
  })();
  console.log(`[api] server version ${serverVersion}`);

  const uiDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../admin-ui/dist');
  if (fs.existsSync(path.join(uiDist, 'index.html'))) {
    ex.use(express.static(uiDist));
    // The console keeps its place in the URL (/fleet, /event/<id>/setup, the
    // /watch viewer link), so a refresh or a shared link lands where it says.
    // Everything that is not an API call or a real file is the SPA shell.
    ex.get(/^\/(?!api\/).*/, (req, res, next) => {
      if (req.method !== 'GET' || req.headers.accept?.includes('application/json')) return next();
      res.sendFile(path.join(uiDist, 'index.html'));
    });
    console.log(`[api] serving admin UI from ${uiDist}`);
  } else {
    console.log('[api] no admin-ui build found — run "npm run build -w admin-ui" to serve the console here');
  }

  const httpServer = http.createServer(ex);
  const io = new SocketIOServer(httpServer, { cors: { origin: true } });
  const auth = new AuthService(ctx.store);

  /**
   * The external live feed. It hangs off the same server on its own namespace
   * with its own token and its own payload contract - see docs/live-feed.md.
   */
  const feed = attachFeed(io, ctx, auth);

  /** Event-tagged payloads go to full-access clients and that event's scoped
   *  viewers; untagged (global) payloads go to everyone. */
  const broadcast = (event: string, payload: unknown): void => {
    const eid = (payload as { eventId?: unknown } | undefined)?.eventId;
    if (typeof eid === 'string') io.to('all-events').to(`ev:${eid}`).emit(event, payload);
    else io.emit(event, payload);
    // Every engine update in the system passes through here, so this is the
    // one place the feed has to hook to stay in step with the console.
    if (typeof eid === 'string') feed.publish(eid);
  };
  /**
   * Raw wire traffic, sent only to consoles that asked for it.
   *
   * Every frame from every tracker is a lot of chatter to push at every
   * connected browser on the off-chance someone is debugging, so the log view
   * subscribes and unsubscribes as it opens and closes.
   */
  const RAW_ROOM = 'raw-wire';
  /** IMEIs are 15 digits; pulling one out here makes "everything from this
   *  device" an indexed lookup without parsing the frame. */
  const imeiOf = (text: string): string | undefined => text.match(/\b(\d{15})\b/)?.[1];

  const emitRaw = (raw: string | Buffer, source: string, ip: string): void => {
    const binary = Buffer.isBuffer(raw);
    const text = binary
      ? // binary frames are unreadable as text — hex is what you compare
        // against the protocol doc
        (raw as Buffer).toString('hex').replace(/(..)/g, '$1 ').trim()
      : (raw as string).trim();
    const frame = {
      tMs: Date.now(),
      source,
      ip,
      binary,
      bytes: binary ? (raw as Buffer).length : Buffer.byteLength(raw as string),
      imei: binary ? undefined : imeiOf(text),
      text,
    };
    // Recorded whether or not anyone is watching: the reason to look is almost
    // always something that already happened.
    ctx.store.queueWireFrame(frame);
    const room = io.sockets.adapter.rooms.get(RAW_ROOM);
    if (room && room.size > 0) io.to(RAW_ROOM).emit('raw', frame);
  };

  // Frames buffer between writes; flush steadily so history is current, and
  // prune on a slower beat so the table stays a debugging aid, not an archive.
  const wireFlush = setInterval(() => ctx.store.flushWireFrames(), 1000);
  const wirePrune = setInterval(() => ctx.store.pruneWireFrames(), 10 * 60_000);
  wireFlush.unref?.();
  wirePrune.unref?.();

  const broadcastSnapshot = (): void => {
    io.to('all-events').emit('snapshot', ctx.snapshotAll());
    for (const id of ctx.apps.keys()) io.to(`ev:${id}`).emit('snapshot', ctx.snapshotFor(id));
    // Loading, unloading or reconfiguring an event changes what the feed can
    // offer, not just what a race says.
    feed.publishAll();
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
    // Wire log subscription — operators only, and never a viewer PIN session.
    socket.on('raw:subscribe', () => {
      if (socket.data.ingest || socket.data.role === 'viewer') return;
      socket.join(RAW_ROOM);
    });
    socket.on('raw:unsubscribe', () => socket.leave(RAW_ROOM));

    // Legacy NYC split feed: raceTimeUpdate { tracker, distance, raceTime }.
    socket.on('raceTimeUpdate', (data) => {
      if (socket.data.ingest || (socket.data.role && socket.data.role !== 'viewer')) {
        ctx.onSimulatedDistance(data ?? {});
      }
    });
  });

  /**
   * Health, for the deploy script and anything watching the box.
   *
   * Loopback only: it names the version and says whether a race is running,
   * which is exactly what a deployer needs and not something to hand out over
   * the tunnel. Anything off-box gets the same 401 as any other API call.
   */
  /** Shared by /api/health and the deploy interlock, which must agree. */
  const raceCounts = (): { armed: number; live: number } => {
    let armed = 0;
    let live = 0;
    for (const app of ctx.apps.values()) {
      for (const e of app.engines.values()) {
        if (e.status === 'armed') armed++;
        else if (e.status === 'live') live++;
      }
    }
    return { armed, live };
  };

  ex.get('/api/health', (req, res) => {
    const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '');
    if (ip !== '127.0.0.1' && ip !== '::1') {
      return void res.status(401).json({ ok: false, error: 'health is loopback-only' });
    }
    const { armed, live } = raceCounts();
    res.json({
      ok: true,
      version: serverVersion,
      uptimeS: Math.round(process.uptime()),
      events: ctx.apps.size,
      races: { armed, live },
      /** The deploy script's interlock: never restart mid-race. */
      safeToRestart: armed === 0 && live === 0,
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
    res.json({
      ok: true,
      username: c.username,
      role: c.role,
      eventScope: c.eventScope ?? null,
      version: serverVersion,
    });
  });

  // --- everything below requires a logged-in operator ---
  ex.use('/api', auth.middleware);

  // --- deploying from the console ---
  // The manager owns the awkward part: the work has to outlive this process,
  // because deploying restarts it.
  const deployRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const deploy = new DeployManager(deployRoot, ctx.dataDir);

  ex.get('/api/deploy', auth.adminOnly, async (_req, res) => {
    // A deploy that never started should say so, not sit on the page forever.
    deploy.reapAbandoned();
    const [info, { armed, live }] = [await deploy.check(), raceCounts()];
    res.json({
      ok: true,
      version: serverVersion,
      update: info,
      status: deploy.readStatus(),
      running: deploy.inProgress(),
      races: { armed, live },
      safeToRestart: armed === 0 && live === 0,
    });
  });

  ex.post('/api/deploy/check', auth.adminOnly, async (_req, res) => {
    deploy.invalidate();
    res.json({ ok: true, update: await deploy.check() });
  });

  ex.post('/api/deploy/start', auth.adminOnly, async (req, res) => {
    const force = req.body?.force === true;
    const by = auth.check(auth.tokenFromRequest(req))?.username ?? 'unknown';
    try {
      const info = await deploy.check(30_000);
      if (info.error) throw new Error(info.error);
      if (!info.commits.length) throw new Error('nothing to deploy');
      if (info.blockedBy.length) {
        throw new Error(`local code changes on this machine: ${info.blockedBy.join('; ')}`);
      }

      // The same interlock the script enforces, checked here so the console
      // can refuse with a useful message instead of the deploy dying later.
      const { armed, live } = raceCounts();
      if ((armed || live) && !force) {
        throw new Error(`a race is armed or live (armed ${armed}, live ${live})`);
      }

      deploy.start({ force, by });
      console.log(`[deploy] started by ${by}${force ? ' (forced)' : ''}`);
      res.json({ ok: true, status: deploy.readStatus() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });


  type OpRequest = express.Request & { operator?: string; role?: Role };
  const act = (fn: (req: OpRequest) => unknown) => (req: express.Request, res: express.Response) => {
    try {
      res.json({ ok: true, result: fn(req as OpRequest) ?? null });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  };

  /** Store key for a course: engines hold resolved absolute paths. */
  const courseKey = (coursePath: string): string => `courses/${path.basename(coursePath)}`;

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

  /**
   * Config access for any event on disk, running or not — next weekend's meet
   * gets built and checked over during the week, and having to activate it
   * (starting engines and binding listeners) just to edit it is the wrong
   * trade. An inactive event is edited straight through its file; a running one
   * still goes through its live manager so the engines rebuild.
   */
  const configFor = (eventId: string): { manager: ConfigManager; active: boolean } => {
    const loaded = ctx.managers.get(eventId);
    if (loaded) return { manager: loaded, active: true };
    const found = listEvents(ctx.eventsDir).find((e) => e.id === eventId && !e.error);
    if (!found) throw new Error(`Unknown event "${eventId}"`);
    return { manager: new ConfigManager(path.join(ctx.eventsDir, found.file)), active: false };
  };

  // Self-service password change (any signed-in operator; viewers have no password)
  ex.post(
    '/api/me/password',
    act((req: OpRequest) => {
      if (req.role === 'viewer') throw new Error('Viewer sessions have no password');
      const { currentPassword, newPassword } = req.body ?? {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        throw new Error('currentPassword and newPassword are required');
      }
      auth.changePassword(req.operator!, currentPassword, newPassword, auth.tokenFromRequest(req)!);
    }),
  );

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
      const { course, race } = engine;
      // Markers belong to the course (shared across every event that uses it)
      // and are positioned on the line server-side so clients just draw them.
      const markers = placeMarkers(course, ctx.store.courseMarkers(courseKey(race.course)));
      res.json({ line: course.line, length: course.length, units: course.units, markers });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  ex.post(
    '/api/events/:eventId/races/:raceId/lifecycle',
    act((req) => eventApp(req).lifecycle(req.params.raceId as string, req.body.action, req.body.atMs, req.operator)),
  );

  /**
   * Move a tracker onto another vehicle mid-race — the fix for one bolted to
   * the wrong bike. Empty vehicle detaches it from all of them.
   */
  ex.post(
    '/api/events/:eventId/trackers/:imei/vehicle',
    act((req: OpRequest) => {
      ctx.moveTracker(
        req.params.eventId as string,
        req.params.imei as string,
        String(req.body?.vehicle ?? ''),
        req.operator,
      );
      broadcastSnapshot();
    }),
  );

  /** Hand a role to a different vehicle — the coverage swap, not a failover. */
  ex.post(
    '/api/events/:eventId/races/:raceId/roles/:roleKey/vehicle',
    act((req) => {
      const app = eventApp(req);
      const engine = app.engines.get(req.params.raceId as string);
      if (!engine) throw new Error('unknown race');
      engine.setVehicle(req.params.roleKey as string, String(req.body?.vehicle ?? ''), req.operator);
      broadcast('race', app.raceSnapshot(req.params.raceId as string));
    }),
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
      const { manager, active } = configFor(req.params.eventId as string);
      res.json({ ...manager.raw, _active: active });
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  ex.put(
    '/api/events/:eventId/config',
    auth.adminOnly,
    act((req: OpRequest) => {
      const eventId = req.params.eventId as string;
      const { manager, active } = configFor(eventId);
      const before = new Set(manager.raw.trackers.map((t) => t.imei));
      // Editing a file that no engine is reading needs no rebuild.
      // the UI round-trips the read-only _active flag; it is not part of the config
      const body = { ...(req.body as Record<string, unknown>) };
      delete body._active;
      // Running races keep their engines; the rest is rebuilt as before.
      if (active) ctx.updateEvent(eventId, body);
      else manager.update(body);
      const raw = active
        ? ([...ctx.managers.values()].find((m) => m.raw.id === (req.body as { id?: string })?.id)?.raw ?? manager.raw)
        : manager.raw;
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

  /**
   * The course library: geometry from disk, metadata from SQLite, and every
   * (event, race) that points at each file. One course is reused across many
   * events over the years, so usage travels with the listing.
   */
  ex.get('/api/courses', (_req, res) => {
    const usage = courseUsage(ctx.eventsDir);
    const meta = ctx.store.courseMeta();
    const loaded = new Set([...ctx.apps.keys()]);
    res.json(
      listCoursesIn(ctx.eventsDir).map((c) => {
        if (!meta.has(c.file)) ctx.store.noteCourseSeen(c.file);
        const m = meta.get(c.file);
        const uses = usage.get(c.file) ?? [];
        const mk = ctx.store.courseMarkers(c.file);
        return {
          ...c,
          label: m?.label ?? null,
          notes: m?.notes ?? null,
          archived: m?.archived === 1,
          createdMs: m?.created_ms ?? null,
          autoMarkers: mk.auto,
          markerUnits: mk.units,
          markers: mk.markers,
          uses,
          eventCount: new Set(uses.map((u) => u.eventId)).size,
          inActiveEvent: uses.some((u) => loaded.has(u.eventId)),
        };
      }),
    );
  });

  /** GeoJSON for the course library preview map. */
  ex.get('/api/courses/:file/geometry', (req, res) => {
    try {
      const file = `courses/${path.basename(req.params.file as string)}`;
      const course = loadCourse(path.join(ctx.eventsDir, file), 'miles');
      res.json({ line: course.line, lengthMi: course.length });
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  /** Markers as configured on the course, placed on the line. */
  ex.get('/api/courses/:file/markers', (req, res) => {
    try {
      const file = `courses/${path.basename(req.params.file as string)}`;
      const course = loadCourse(path.join(ctx.eventsDir, file), 'miles');
      const cfg = ctx.store.courseMarkers(file);
      res.json({ ...cfg, placed: placeMarkers(course, cfg), lengthMi: course.length });
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  ex.put(
    '/api/courses/:file/markers',
    auth.adminOnly,
    act((req) => {
      const file = `courses/${path.basename(req.params.file as string)}`;
      const { auto, units, markers } = req.body ?? {};
      ctx.store.setCourseMarkers(file, {
        auto: typeof auto === 'boolean' ? auto : undefined,
        units: units === 'miles' || units === 'kilometers' ? units : undefined,
        markers: Array.isArray(markers) ? markers : undefined,
      });
      return ctx.store.courseMarkers(file);
    }),
  );

  /** Click-to-place: where along the course is this point? */
  ex.post(
    '/api/courses/:file/locate',
    auth.adminOnly,
    act((req) => {
      const file = `courses/${path.basename(req.params.file as string)}`;
      const { lat, lon } = req.body ?? {};
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('lat and lon are required');
      const units = ctx.store.courseMarkers(file).units;
      return locateOnCourse(loadCourse(path.join(ctx.eventsDir, file), units), Number(lat), Number(lon));
    }),
  );

  ex.get('/api/courses/:file/download', auth.adminOnly, (req, res) => {
    try {
      const name = path.basename(req.params.file as string);
      res.type('application/vnd.google-earth.kml+xml')
        .set('Content-Disposition', `attachment; filename="${name}"`)
        .send(readCourseIn(ctx.eventsDir, `courses/${name}`));
    } catch (err) {
      res.status(404).json({ ok: false, error: (err as Error).message });
    }
  });

  ex.post(
    '/api/courses/:name',
    auth.adminOnly,
    express.text({ type: () => true, limit: '25mb' }),
    act((req) => {
      if (typeof req.body !== 'string' || req.body.length === 0) throw new Error('Empty upload');
      const replace = req.query.replace === '1';
      const saved = saveCourseIn(ctx.eventsDir, req.params.name as string, req.body, { replace });
      ctx.store.noteCourseSeen(saved.file, req.operator);
      return saved;
    }),
  );

  ex.put(
    '/api/courses/:file',
    auth.adminOnly,
    act((req) => {
      const file = `courses/${path.basename(req.params.file as string)}`;
      const { label, notes, archived } = req.body ?? {};
      ctx.store.updateCourseMeta(file, {
        label: typeof label === 'string' ? label.trim() : undefined,
        notes: typeof notes === 'string' ? notes.trim() : undefined,
        archived: typeof archived === 'boolean' ? archived : undefined,
      });
      return { file };
    }),
  );

  ex.post(
    '/api/courses/:file/rename',
    auth.adminOnly,
    act((req) => {
      const from = `courses/${path.basename(req.params.file as string)}`;
      const to = String(req.body?.to ?? '');
      // Rewriting a loaded event's config underneath its running engines would
      // desync them; make the operator deactivate first.
      const uses = courseUsage(ctx.eventsDir).get(from) ?? [];
      const live = uses.filter((u) => ctx.apps.has(u.eventId)).map((u) => u.eventName);
      if (live.length > 0) {
        throw new Error(`Deactivate ${[...new Set(live)].join(', ')} before renaming this course`);
      }
      const result = renameCourseIn(ctx.eventsDir, from, to);
      ctx.store.renameCourseMeta(from, result.file);
      return result;
    }),
  );

  ex.delete(
    '/api/courses/:file',
    auth.adminOnly,
    act((req) => {
      const file = `courses/${path.basename(req.params.file as string)}`;
      deleteCourseIn(ctx.eventsDir, file); // refuses while any event references it
      ctx.store.deleteCourseMeta(file);
      return { file };
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

  /**
   * Put a meet away, or take it back out.
   *
   * Events file themselves once their end date passes, but that needs an end
   * date and a date that has passed — a meet that ran late, or was never given
   * dates, would sit in the list forever. Completing deactivates it on the way
   * out, since a running event is not a finished one; the usual interlock still
   * refuses while a race is armed or live.
   */
  ex.post(
    '/api/events/:eventId/complete',
    auth.adminOnly,
    act((req: OpRequest) => {
      const eventId = req.params.eventId as string;
      const done = req.body?.completed !== false;
      const { manager } = configFor(eventId);
      if (done && ctx.apps.has(eventId)) ctx.unloadEvent(eventId);
      const raw = JSON.parse(JSON.stringify(manager.raw)) as Record<string, unknown>;
      if (done) raw.completedAt = new Date().toISOString().slice(0, 10);
      else delete raw.completedAt;
      manager.update(raw);
      return { completedAt: raw.completedAt ?? null };
    }),
  );

  // --- decoders (RaceResult timing boxes) --------------------------------

  ex.get('/api/decoders', (_req, res) => {
    res.json({ ok: true, decoders: ctx.store.listDecoders(), status: ctx.decoders.status() });
  });

  /** Settings never hand the API key back — only whether one is held. */
  ex.get('/api/decoders/settings', auth.adminOnly, (_req, res) => {
    res.json({ ok: true, status: ctx.decoders.status(), hasKey: !!ctx.decoders.readConfig()?.apiKey });
  });

  ex.put(
    '/api/decoders/settings',
    auth.adminOnly,
    act((req: OpRequest) => {
      const b = req.body as { customerId?: number; apiKey?: string; intervalS?: number; enabled?: boolean };
      if (!b?.customerId) throw new Error('A customer ID is required');
      ctx.decoders.saveConfig({
        customerId: Number(b.customerId),
        apiKey: b.apiKey,
        intervalS: Number(b.intervalS),
        enabled: b.enabled !== false,
      });
      return ctx.decoders.status();
    }),
  );

  ex.post('/api/decoders/disconnect', auth.adminOnly, (_req, res) => {
    ctx.decoders.clearConfig();
    res.json({ ok: true });
  });

  /** Try credentials without saving them — the same shape as the Firebase test. */
  ex.post('/api/decoders/test', auth.adminOnly, async (req, res) => {
    try {
      const b = req.body as { customerId?: number; apiKey?: string };
      if (!b?.customerId) throw new Error('A customer ID is required');
      const r = await ctx.decoders.test({ customerId: Number(b.customerId), apiKey: b.apiKey });
      res.json({ ok: true, ...r });
    } catch (err) {
      res.status(400).json({ ok: false, error: (err as Error).message });
    }
  });

  /** Hide or restore one device — see Store.setDecoderHidden. */
  ex.post(
    '/api/decoders/:deviceId/hidden',
    act((req: OpRequest) => {
      ctx.store.setDecoderHidden(req.params.deviceId as string, req.body?.hidden !== false);
      broadcast('decoders', ctx.store.listDecoders());
    }),
  );

  ex.post('/api/decoders/poll', auth.adminOnly, async (_req, res) => {
    await ctx.decoders.pollOnce();
    res.json({ ok: true, decoders: ctx.store.listDecoders(), status: ctx.decoders.status() });
  });

  /** Past wire traffic. Paged newest-first on `before` so scrolling back is
   *  stable while new frames keep arriving. */
  ex.get('/api/wire/history', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
    res.json({
      ok: true,
      frames: ctx.store.wireHistory({
        limit: num(q.limit),
        before: num(q.before),
        since: num(q.since),
        until: num(q.until),
        source: q.source,
        imei: q.imei,
        q: q.q,
      }),
      sources: ctx.store.wireSources(),
      stats: ctx.store.wireStats(),
    });
  });

  ex.post('/api/wire/clear', auth.adminOnly, (_req, res) => {
    ctx.store.clearWireFrames();
    res.json({ ok: true });
  });

  ex.get('/api/fleet', (_req, res) => {
    const rosters = eventRosters(ctx.eventsDir);
    const loaded = new Set(ctx.apps.keys());
    const issueCounts = ctx.store.openIssueCounts();
    // A device that ran a meet three years ago is not "in" that event any more.
    // Only what is running or still to come counts; past assignments live in the
    // device's history, which is where you go looking for them.
    const today = new Date().toISOString().slice(0, 10);
    const current = rosters.filter((r) => loaded.has(r.id) || !r.endDate || r.endDate >= today);
    const rows = (ctx.store.listFleet() as Array<Record<string, unknown>>).map((f) => {
      const mine = rosters.filter((r) => r.imeis.includes(f.imei as string));
      return {
        ...f,
        events: current
          .filter((r) => r.imeis.includes(f.imei as string))
          .map((r) => ({ id: r.id, name: r.name, active: loaded.has(r.id) })),
        /** How many finished events also used it — the history dialog has the detail. */
        pastEvents: mine.length - current.filter((r) => r.imeis.includes(f.imei as string)).length,
        openIssues: issueCounts.get(f.imei as string) ?? 0,
      };
    });
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

  // --- live feed token (outbound: other software reading races) ---

  ex.get('/api/feed-token', auth.adminOnly, (_req, res) => {
    res.json({ token: auth.feedToken() ?? null });
  });

  ex.post('/api/feed-token', auth.adminOnly, (_req, res) => {
    res.json({ ok: true, token: auth.regenerateFeedToken() });
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

  // Without a handler a failed bind throws a bare stack trace, which under a
  // service manager means an unreadable log and a restart loop. The common
  // case by far is a second copy of the server, so say that.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[api] port ${port} is already in use - another copy of the server is ` +
          `probably running. Stop it, or pass --api-port.`,
      );
    } else {
      console.error(`[api] could not listen on :${port}:`, err.message);
    }
    process.exit(1);
  });

  httpServer.listen(port, () => {
    console.log(`[api] http + socket.io on :${port}`);
  });
  return { httpServer, io, broadcast, emitRaw };
}

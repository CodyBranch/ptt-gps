import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ConfigManager, listEvents, migrateRaceMarkersToCourses, migrateRolesToVehicles } from './config/manager.js';
import { App } from './app.js';
import { Forwarder } from './ingest/forwarder.js';
import { FixGate } from './ingest/hygiene.js';
import { DecoderPoller } from './decoders/poller.js';
import type { Fix, Telemetry } from './ingest/types.js';
import { FirebaseHub } from './outputs/hub.js';
import { Store } from './state/store.js';
import { startApi, type ServerContext } from './api/server.js';
import { startListener } from './ingest/source.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// --- events directory ---

const eventArg = arg('event');
const eventsDir = path.resolve(
  arg('events-dir') ??
    (eventArg ? path.dirname(eventArg) : fs.existsSync('../events') ? '../events' : 'events'),
);
if (!fs.existsSync(eventsDir)) {
  console.error(`Events directory not found: ${eventsDir} (use --events-dir or --event)`);
  process.exit(1);
}

const store = new Store(arg('db', 'data/ptt.db')!);
const hub = new FirebaseHub(store, path.dirname(path.resolve(arg('db', 'data/ptt.db')!)));
const forwarder = new Forwarder(store);

// --- shared ingest pipeline (one gate/store/lastSeen for all loaded events) ---

let emitFn: (event: string, payload: unknown) => void = () => {};
const out = { emit: (e: string, p: unknown) => emitFn(e, p) };

const gate = new FixGate();
// Seed the gate from the fix log: after a restart a device flushing its
// backlog would otherwise re-feed fixes the engines already consumed. Anything
// at or before what we have is dropped as stale; the gap still gets through.
gate.seedLastAccepted(store.lastAcceptedFixTimes());
const lastSeen = new Map<string, number>();
const simulated = new Map<string, { distance: number; raceTime?: string; tMs: number }>();
for (const d of store.devices() as Array<{ imei: string; last_received_ms: number | null }>) {
  if (d.last_received_ms) lastSeen.set(d.imei, d.last_received_ms);
}

// --- loaded events (several can run at once) ---

const apps = new Map<string, App>();
const managers = new Map<string, ConfigManager>();

/** Per-event publishing switch, persisted per event (falls back to the old
 *  global setting for first-time migration). */
function publishSetting(eventId: string): boolean {
  const perEvent = store.getSetting(`publish-enabled:${eventId}`);
  if (perEvent !== undefined) return perEvent !== '0';
  return store.getSetting('publish-enabled') !== '0';
}

function setPublishing(eventId: string, enabled: boolean, by?: string): void {
  const app = apps.get(eventId);
  if (!app) throw new Error(`Event "${eventId}" is not active`);
  store.setSetting(`publish-enabled:${eventId}`, enabled ? '1' : '0');
  app.setPublishing(enabled, by);
  out.emit('publishing', { eventId, enabled, by, tMs: Date.now() });
  console.log(`[outputs] ${eventId}: publishing ${enabled ? 'ENABLED' : 'DISABLED'}${by ? ` by ${by}` : ''}`);
}

function persistLoaded(): void {
  store.setSetting('loaded-events', JSON.stringify([...managers.keys()].map((id) => loadedFiles.get(id))));
}
const loadedFiles = new Map<string, string>(); // eventId → file

function loadEvent(file: string): App {
  const manager = new ConfigManager(path.join(eventsDir, file));
  const resolved = manager.resolved();
  if (apps.has(resolved.id)) throw new Error(`Event "${resolved.id}" is already active`);
  const app = new App(resolved, store, out, hub, (imei) => gate.health(imei));
  app.publishEnabled = publishSetting(resolved.id);
  apps.set(resolved.id, app);
  managers.set(resolved.id, manager);
  loadedFiles.set(resolved.id, file);
  persistLoaded();
  syncListeners();
  console.log(`[events] activated "${resolved.name}" (${file}) — ${apps.size} event(s) running`);
  return app;
}

function unloadEvent(eventId: string): void {
  const app = apps.get(eventId);
  if (!app) throw new Error(`Event "${eventId}" is not active`);
  if (app.hasActiveRaces()) throw new Error('Event has an armed or live race — finish or reset it first');
  apps.delete(eventId);
  managers.delete(eventId);
  loadedFiles.delete(eventId);
  persistLoaded();
  syncListeners();
  console.log(`[events] deactivated "${eventId}" — ${apps.size} event(s) running`);
}

/** Rebuild one loaded event's App from an edited config. */
/**
 * Move a tracker to another vehicle without rebuilding anything.
 *
 * The config is corrected on disk so the fix survives a restart — which
 * matters most here, since a restart mid-race replays from the config — while
 * the running engines are patched in place so no window or distance is lost.
 */
function moveTracker(eventId: string, imei: string, vehicleKey: string, by?: string): void {
  const manager = managers.get(eventId);
  const app = apps.get(eventId);
  if (!manager || !app) throw new Error(`Event "${eventId}" is not active`);
  if (!manager.raw.trackers.some((t) => t.imei === imei)) {
    throw new Error(`Tracker ${imei} is not on this event's roster`);
  }
  if (vehicleKey !== '' && !manager.raw.vehicles.some((v) => v.key === vehicleKey)) {
    throw new Error(`Unknown vehicle "${vehicleKey}"`);
  }
  const raw = JSON.parse(JSON.stringify(manager.raw)) as typeof manager.raw;
  for (const v of raw.vehicles) v.trackers = v.trackers.filter((t) => t !== imei);
  const target = raw.vehicles.find((v) => v.key === vehicleKey);
  if (target) target.trackers.push(imei);
  manager.update(raw);
  app.moveTracker(imei, vehicleKey, by);
  console.log(`[${eventId}] tracker ${imei} moved to ${vehicleKey || 'no vehicle'}${by ? ` by ${by}` : ''}`);
}

/**
 * Save an edit to a running event.
 *
 * With nothing racing this is the old behaviour — validate, write, rebuild the
 * engines from scratch. With a race armed or live the engines are patched in
 * place instead, so windows, distances and open sessions survive the save; the
 * App refuses the few changes that cannot be made mid-race and says which.
 */
function updateEvent(eventId: string, json: unknown): void {
  const manager = managers.get(eventId);
  const app = apps.get(eventId);
  if (!manager || !app) throw new Error(`Event "${eventId}" is not active`);
  if (!app.hasActiveRaces()) return rebuildEvent(eventId, json);

  // Validate before anything is written, then let the App vet it against what
  // is actually running — a refusal must leave the file untouched.
  const resolved = manager.validate(json);
  app.applyConfig(resolved);
  manager.update(json);
  syncListeners();
  console.log(`[events] "${eventId}" config updated live — engines kept`);
}

function rebuildEvent(eventId: string, json: unknown): void {
  const manager = managers.get(eventId);
  if (!manager) throw new Error(`Event "${eventId}" is not active`);
  const resolved = manager.update(json);
  if (resolved.id !== eventId) {
    // id changed in the edit — rekey
    apps.delete(eventId);
    const file = loadedFiles.get(eventId)!;
    loadedFiles.delete(eventId);
    managers.delete(eventId);
    managers.set(resolved.id, manager);
    loadedFiles.set(resolved.id, file);
    persistLoaded();
  }
  const app = new App(resolved, store, out, hub, (imei) => gate.health(imei));
  app.publishEnabled = publishSetting(resolved.id);
  apps.set(resolved.id, app);
  syncListeners();
  console.log(`[events] "${resolved.id}" config updated — engines rebuilt`);
}

// --- shared fix/telemetry handling ---

/** Rate-limit the "unreadable frame" warning so one bad device can't drown the log. */
const unreadableWarned = new Map<string, number>();

function onFix(fix: Fix): void {
  lastSeen.set(fix.imei, fix.receivedAtMs);
  if (!Number.isFinite(fix.tUtcMs)) {
    // No usable GPS time means this is not a fix. Keep the raw frame as
    // telemetry for diagnosis rather than pushing NaN at a NOT NULL column and
    // taking the listener down with it.
    store.recordTelemetry({
      type: 'unreadable-fix',
      imei: /^\d{15}$/.test(fix.imei) ? fix.imei : undefined,
      source: fix.source,
      raw: fix.raw,
    });
    const key = fix.imei || fix.source;
    const last = unreadableWarned.get(key) ?? 0;
    if (Date.now() - last > 30_000) {
      unreadableWarned.set(key, Date.now());
      console.warn(`[${fix.source}] unreadable frame (no GPS time) from ${key}: ${String(fix.raw).slice(0, 220)}`);
    }
    return;
  }
  const g = gate.accept(fix);
  store.recordFix(fix, g.ok, g.reason);
  out.emit('fix', {
    imei: fix.imei,
    receivedAtMs: fix.receivedAtMs,
    lat: fix.lat,
    lon: fix.lon,
    tUtcMs: fix.tUtcMs,
    battery: fix.battery,
    accuracy: fix.accuracy,
    buffered: fix.buffered,
    accepted: g.ok,
    reason: g.reason,
    source: fix.source,
    protocol: fix.protocol,
  });
  if (!g.ok) return;
  for (const app of apps.values()) app.onFix(fix);
}

function onTelemetry(t: Telemetry): void {
  if (t.imei) lastSeen.set(t.imei, Date.now());
  store.recordTelemetry(t);
  // A no-fix report still tells us the device is on and how charged it is.
  if (t.imei && t.type.endsWith(':no-fix')) {
    const battery = typeof t.detail?.battery === 'number' ? t.detail.battery : undefined;
    store.noteDeviceHeard(t.imei, Date.now(), battery, undefined, t.source);
  }
  out.emit('telemetry', { imei: t.imei, type: t.type, tUtcMs: t.tUtcMs, source: t.source, receivedAtMs: Date.now() });
}

function onSimulatedDistance(data: { tracker?: unknown; distance?: unknown; raceTime?: unknown }): void {
  const tracker = String(data.tracker ?? '').trim();
  const distance = Number(data.distance);
  if (!tracker || !Number.isFinite(distance)) return;
  const raceTime = data.raceTime !== undefined ? String(data.raceTime) : undefined;
  const entry = { distance, raceTime, tMs: Date.now() };
  simulated.set(tracker, entry);
  store.recordTelemetry({
    type: 'split-distance',
    imei: /^\d{15}$/.test(tracker) ? tracker : undefined,
    detail: { tracker, distance, raceTime },
    source: 'splits',
    raw: JSON.stringify(data),
  });
  out.emit('simulatedDistance', { tracker, distance, raceTime, tMs: entry.tMs });
  for (const app of apps.values()) app.applySimulatedDistance(tracker, distance, raceTime);
}

function snapshotAll() {
  return {
    events: [...apps.values()].map((a) => a.snapshot()),
    lastSeen: Object.fromEntries(lastSeen),
    simulated: Object.fromEntries(simulated),
  };
}

/** Filtered snapshot for an event-scoped viewer PIN session. */
function snapshotFor(eventId: string) {
  const app = apps.get(eventId);
  return {
    events: app ? [app.snapshot()] : [],
    lastSeen: Object.fromEntries(lastSeen),
    simulated: Object.fromEntries(simulated),
  };
}

// --- listeners: union of ports across loaded events ---

let listenerServers: net.Server[] = [];
const liveSockets = new Set<net.Socket>();
let currentPorts = '';

function syncListeners(): void {
  const portNames = new Map<number, string>();
  for (const m of managers.values()) {
    for (const l of m.resolved().listeners) {
      if (!portNames.has(l.port)) portNames.set(l.port, l.name);
    }
  }
  const key = [...portNames.keys()].sort().join(',');
  if (key === currentPorts) return;
  for (const s of liveSockets) s.destroy();
  liveSockets.clear();
  for (const srv of listenerServers) srv.close();
  listenerServers = [];
  currentPorts = key;
  for (const [port, name] of portNames) {
    const srv = startListener(
      { name, port },
      {
        onFix,
        onTelemetry,
        onRawFrame: (raw, src, ip) => {
          forwarder.write(raw);
          emitRaw(raw, src, ip);
        },
        onConnection: (event, ip, source) => {
          console.log(`[${source}] ${ip} ${event}`);
          out.emit('connection', { event, ip, source, tMs: Date.now() });
        },
      },
    );
    srv.on('connection', (sock) => {
      liveSockets.add(sock);
      sock.on('close', () => liveSockets.delete(sock));
    });
    listenerServers.push(srv);
  }
}

// --- boot: restore loaded events (or seed from --event / legacy setting) ---

/**
 * Timing boxes on the course, polled from RaceResult. Separate hardware from
 * the GPS trackers, but the same question at a meet — is it up, and where is
 * it — so the console shows them side by side.
 */
const decoders = new DecoderPoller(store, (list) => out.emit('decoders', list));

const ctx: ServerContext = {
  store,
  decoders,
  hub,
  forwarder,
  eventsDir,
  apps,
  managers,
  gate,
  lastSeen,
  setPublishing,
  loadEvent,
  unloadEvent,
  rebuildEvent,
  updateEvent,
  moveTracker,
  snapshotAll,
  snapshotFor,
  onSimulatedDistance,
};

const { broadcast, emitRaw } = startApi(ctx, Number(arg('api-port', '8080')));
emitFn = broadcast;
decoders.start();

// Markers used to live on each race; they belong to the course, which is
// shared. Lift any that are still in event files into the course library.
migrateRaceMarkersToCourses(eventsDir, store);
// Roles carried their own tracker lists before vehicles existed.
migrateRolesToVehicles(eventsDir);

const available = listEvents(eventsDir).filter((e) => !e.error);
let toLoad: string[] = [];
try {
  toLoad = JSON.parse(store.getSetting('loaded-events') ?? '[]');
} catch {
  toLoad = [];
}
if (toLoad.length === 0) {
  const legacy = store.getSetting('active-event');
  if (legacy) toLoad = [legacy];
}
if (eventArg) {
  const f = path.basename(eventArg);
  if (!toLoad.includes(f)) toLoad.push(f);
}
for (const file of toLoad) {
  if (!available.some((e) => e.file === file)) continue;
  try {
    const app = loadEvent(file);
    app.recoverOpenSessions();
  } catch (err) {
    console.error(`[events] failed to activate ${file}:`, (err as Error).message);
  }
}
console.log(`[events] dir ${eventsDir} — ${apps.size} active event(s): ${[...apps.keys()].join(', ') || 'none'}`);
syncListeners();

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
process.on('SIGINT', () => {
  store.close();
  process.exit(0);
});

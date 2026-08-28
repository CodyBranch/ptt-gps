import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ConfigManager, listEvents } from './config/manager.js';
import { App } from './app.js';
import { Store } from './state/store.js';
import { startApi, type AppHolder } from './api/server.js';
import { startListener } from './ingest/source.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// --- resolve the events directory and the event to boot with ---

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

const available = listEvents(eventsDir).filter((e) => !e.error);
let eventFile: string | undefined = eventArg ? path.basename(eventArg) : undefined;
if (!eventFile) {
  const remembered = store.getSetting('active-event');
  if (remembered && fs.existsSync(path.join(eventsDir, remembered))) eventFile = remembered;
}
if (!eventFile && available.length === 1) eventFile = available[0].file;
if (!eventFile) {
  console.error(`No event selected. Pass --event, or available in ${eventsDir}:`);
  for (const e of available) console.error(`  ${e.file}  (${e.name})`);
  process.exit(1);
}

// --- boot the active event ---

let emitFn: (event: string, payload: unknown) => void = () => {};
const out = { emit: (e: string, p: unknown) => emitFn(e, p) };

let manager = new ConfigManager(path.join(eventsDir, eventFile));
store.setSetting('active-event', eventFile);

const holder: AppHolder = {
  app: new App(manager.resolved(), store, out),
  eventsDir,
  get manager() {
    return manager;
  },
  rebuild: (json: unknown) => {
    const resolved = manager.update(json);
    holder.app = new App(resolved, store, out);
    syncListeners(resolved.listeners);
    console.log(`[config] event config updated — engines rebuilt (${resolved.races.length} race(s))`);
  },
  activateEvent: (file: string) => {
    const nextManager = new ConfigManager(path.join(eventsDir, file));
    const resolved = nextManager.resolved();
    manager = nextManager;
    holder.app = new App(resolved, store, out);
    store.setSetting('active-event', file);
    syncListeners(resolved.listeners);
    console.log(`[config] activated event "${resolved.name}" (${file})`);
  },
};

console.log(`[config] events dir ${eventsDir} — active event "${manager.raw.name}" (${eventFile})`);

const { io } = startApi(holder, Number(arg('api-port', '8080')));
emitFn = (e, p) => io.emit(e, p);

// --- listeners: rebound only when the port set changes between events ---

let listenerServers: net.Server[] = [];
const liveSockets = new Set<net.Socket>();
let currentPorts = '';

function syncListeners(listeners: Array<{ name: string; port: number }>): void {
  const ports = listeners.map((l) => `${l.name}:${l.port}`).sort().join(',');
  if (ports === currentPorts) return; // same ports — connections keep flowing to the current App
  for (const s of liveSockets) s.destroy();
  liveSockets.clear();
  for (const srv of listenerServers) srv.close();
  listenerServers = [];
  currentPorts = ports;
  for (const listener of listeners) {
    const srv = startListener(listener, {
      onFix: (fix) => holder.app.onFix(fix),
      onTelemetry: (t) => holder.app.onTelemetry(t),
      onConnection: (event, ip, source) => {
        console.log(`[${source}] ${ip} ${event}`);
        io.emit('connection', { event, ip, source, tMs: Date.now() });
      },
    });
    srv.on('connection', (sock) => {
      liveSockets.add(sock);
      sock.on('close', () => liveSockets.delete(sock));
    });
    listenerServers.push(srv);
  }
}

syncListeners(manager.resolved().listeners);

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
process.on('SIGINT', () => {
  store.close();
  process.exit(0);
});

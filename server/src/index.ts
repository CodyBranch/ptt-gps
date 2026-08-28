import { loadEventConfig } from './config/load.js';
import { ConfigManager } from './config/manager.js';
import { App } from './app.js';
import { Store } from './state/store.js';
import { startApi, type AppHolder } from './api/server.js';
import { startListener } from './ingest/source.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const eventPath = arg('event');
if (!eventPath) {
  console.error('Usage: npm run dev -- --event events/<event>.json [--api-port 8080] [--db data/ptt.db]');
  process.exit(1);
}

const cfg = loadEventConfig(eventPath);
console.log(`[config] event "${cfg.name}" (meet ${cfg.meetId}) — ${cfg.races.length} race(s)`);

const store = new Store(arg('db', 'data/ptt.db')!);

// Late-bound so App can emit before the socket server exists during startup.
let emitFn: (event: string, payload: unknown) => void = () => {};
const out = { emit: (e: string, p: unknown) => emitFn(e, p) };

const manager = new ConfigManager(eventPath);
const holder: AppHolder = {
  app: new App(cfg, store, out),
  manager,
  rebuild: (json: unknown) => {
    const resolved = manager.update(json);
    holder.app = new App(resolved, store, out);
    console.log(`[config] event config updated — engines rebuilt (${resolved.races.length} race(s))`);
  },
};

const { io } = startApi(holder, Number(arg('api-port', '8080')));
emitFn = (e, p) => io.emit(e, p);

// Listeners are bound once at startup (changing ports requires a restart);
// they always deliver to the current App instance.
for (const listener of cfg.listeners) {
  startListener(listener, {
    onFix: (fix) => holder.app.onFix(fix),
    onTelemetry: (t) => holder.app.onTelemetry(t),
    onConnection: (event, ip, source) => {
      console.log(`[${source}] ${ip} ${event}`);
      io.emit('connection', { event, ip, source, tMs: Date.now() });
    },
  });
}

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});
process.on('SIGINT', () => {
  store.close();
  process.exit(0);
});

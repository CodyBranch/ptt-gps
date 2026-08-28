import { loadEventConfig } from './config/load.js';
import { App } from './app.js';
import { Store } from './state/store.js';
import { startApi } from './api/server.js';
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
const app = new App(cfg, store, { emit: (e, p) => emitFn(e, p) });

const { io } = startApi(app, Number(arg('api-port', '8080')));
emitFn = (e, p) => io.emit(e, p);

for (const listener of cfg.listeners) {
  startListener(listener, {
    onFix: (fix) => app.onFix(fix),
    onTelemetry: (t) => app.onTelemetry(t),
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

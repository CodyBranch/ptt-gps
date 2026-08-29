import fs from 'node:fs';
import { loadEventConfig } from '../config/load.js';
import { resolveRace, type EventConfig } from '../config/schema.js';
import { loadCourse } from '../engine/course.js';
import { SimEngine, type SimTrackerCfg } from './engine.js';

/**
 * Race simulator CLI — streams GTFRI pings at a server to test tracking setups.
 *
 * From a sim package exported in the console (Sim → Export sim package) —
 * works anywhere, e.g. a laptop pointed at the production box:
 *   npm run sim -- --package boston-2026-demo-sim.json --race marathon --host 23.99.178.28
 *
 * Or directly from a local event config (courses read from disk):
 *   npm run sim -- --event ../events/boston-2026-demo.json --race marathon
 *
 * Variables: --pace mph (lead pace, roles stagger behind) · --interval s
 * (device cadence) · --timescale N (race-time speedup) · --jitter m (GPS noise)
 * · --port (listener port, default from config)
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('Usage: npm run sim -- (--package <sim.json> | --event <cfg.json>) --race <id> [--host H] [--port P] [--pace mph] [--interval s] [--timescale N] [--jitter m]');
  process.exit(1);
}

interface SimPackage {
  kind: string;
  config: EventConfig;
  courses: Record<string, [number, number][]>;
}

let cfg: EventConfig;
let courseCoordsFor: (courseFile: string) => [number, number][];

const packagePath = arg('package');
if (packagePath) {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as SimPackage;
  if (pkg.kind !== 'ptt-sim-package') usage('Not a sim package (export one from the console Sim panel)');
  cfg = pkg.config;
  courseCoordsFor = (file) => {
    const coords = pkg.courses[file];
    if (!coords) usage(`Package has no course data for ${file}`);
    return coords;
  };
} else {
  const eventPath = arg('event') ?? usage();
  cfg = loadEventConfig(eventPath);
  courseCoordsFor = (file) => loadCourse(file, 'miles').line.geometry.coordinates as [number, number][];
}

const raceId = arg('race') ?? cfg.races[0]?.id ?? usage('Config has no races');
const race = cfg.races.find((r) => r.id === raceId) ?? usage(`Unknown race "${raceId}" — available: ${cfg.races.map((r) => r.id).join(', ')}`);

const host = arg('host', '127.0.0.1')!;
const port = Number(arg('port', String(cfg.listeners[0]?.port ?? 1000)));
// --also "host:port,host:port" mirrors the same pings to additional systems.
const targets = [{ host, port }];
for (const part of (arg('also') ?? '').split(',')) {
  const m = part.trim().match(/^(.+):(\d+)$/);
  if (m) targets.push({ host: m[1], port: Number(m[2]) });
}
const paceMph = Number(arg('pace', '12'));
const intervalS = Number(arg('interval', String(cfg.reportIntervalS ?? 10)));
const timescale = Number(arg('timescale', '5'));
const jitterM = Number(arg('jitter', '8'));

const { trackers, roles } = resolveRace(cfg, race);
const sims: SimTrackerCfg[] = [];
let roleIdx = 0;
for (const role of roles) {
  role.trackers.forEach((imei, i) => {
    if (sims.some((s) => s.imei === imei)) return;
    const t = trackers.find((x) => x.imei === imei)!;
    sims.push({ imei, label: t.label, paceMph: paceMph * (1 - roleIdx * 0.03), startOffsetMi: -i * 0.02 });
  });
  roleIdx++;
}
if (sims.length === 0) usage('Race has no role-assigned trackers to simulate');

const engine = new SimEngine(
  { targets, courseCoords: courseCoordsFor(race.course), trackers: sims, intervalS, timescale, jitterM },
  {
    onProgress: (() => {
      let lastLog = 0;
      return (p: ReturnType<SimEngine['status']>) => {
        if (Date.now() - lastLog < 5000) return;
        lastLog = Date.now();
        const lead = p.trackers.reduce((a, b) => (a.distanceMi > b.distanceMi ? a : b));
        console.log(`[sim] +${p.elapsedSimS}s sim · lead ${lead.label} @ ${lead.distanceMi.toFixed(2)}/${p.courseMi.toFixed(2)} mi`);
      };
    })(),
    onEnd: (reason) => {
      console.log(`[sim] ended: ${reason}`);
      process.exit(0);
    },
  },
);

console.log(
  `[sim] ${cfg.name} / ${race.name}: ${sims.length} trackers → ${targets.map((t) => `${t.host}:${t.port}`).join(' + ')} · x${timescale} · interval ${intervalS}s · jitter ${jitterM}m`,
);
engine.start().catch((err) => {
  console.error('[sim] connection failed:', err.message);
  process.exit(1);
});
process.on('SIGINT', () => engine.stop('interrupted'));

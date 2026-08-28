import net from 'node:net';
import * as turf from '@turf/turf';
import { loadEventConfig } from '../config/load.js';
import { resolveRace } from '../config/schema.js';
import { loadCourse } from '../engine/course.js';

/**
 * Race simulator: plays the trackers of a race along its course as GTFRI
 * packets over TCP — exercises the entire real pipeline (framer → parser →
 * hygiene → engine → publishers) with no hardware.
 *
 *   npm run sim -- --event events/demo.json --race marathon [--host 127.0.0.1]
 *     [--port 1000] [--pace 12] [--interval 2] [--timescale 5] [--jitter 8]
 *
 * pace: lead pace in mph · interval: seconds between reports per tracker ·
 * timescale: race-time speedup · jitter: GPS noise in meters
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const cfg = loadEventConfig(arg('event') ?? usage());
const raceId = arg('race') ?? cfg.races[0].id;
const race = cfg.races.find((r) => r.id === raceId) ?? usage(`unknown race ${raceId}`);
const host = arg('host', '127.0.0.1')!;
const port = Number(arg('port', String(cfg.listeners[0]?.port ?? 1000)));
const paceMph = Number(arg('pace', '12'));
const intervalS = Number(arg('interval', '2'));
const timescale = Number(arg('timescale', '5'));
const jitterM = Number(arg('jitter', '8'));

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('Usage: npm run sim -- --event events/<e>.json --race <id> [--pace mph] [--timescale N]');
  process.exit(1);
}

const { trackers, roles } = resolveRace(cfg, race);
const course = loadCourse(race.course, race.units);
const courseMi = race.units === 'miles' ? course.length : course.length / 1.60934;

// Role members run near the lead pace; trackers per role are staggered slightly
// so primary/backup separate visibly; chase-style roles trail farther back.
interface SimTracker {
  imei: string;
  label: string;
  paceMph: number;
  startOffsetMi: number;
  battery: number;
  count: number;
}
const sims: SimTracker[] = [];
let roleIdx = 0;
for (const role of roles) {
  role.trackers.forEach((imei, i) => {
    if (sims.some((s) => s.imei === imei)) return;
    const t = trackers.find((x) => x.imei === imei)!;
    sims.push({
      imei,
      label: t.label,
      paceMph: paceMph * (1 - roleIdx * 0.03),
      startOffsetMi: -i * 0.02,
      battery: 95 - sims.length * 7,
      count: 0,
    });
  });
  roleIdx++;
}

console.log(`[sim] ${cfg.name} / ${race.name}: ${sims.length} trackers, course ${courseMi.toFixed(2)} mi, x${timescale} time`);

const sock = net.connect(port, host, () => {
  console.log(`[sim] connected to ${host}:${port} — gun!`);
  const t0 = Date.now();

  const timer = setInterval(() => {
    const raceHrs = ((Date.now() - t0) / 3600_000) * timescale;
    let allDone = true;

    for (const s of sims) {
      const distMi = Math.min(Math.max(0, raceHrs * s.paceMph + s.startOffsetMi), courseMi);
      if (distMi < courseMi) allDone = false;
      const distCourseUnits = race.units === 'miles' ? distMi : distMi * 1.60934;
      const pt = turf.along(course.line, Math.min(distCourseUnits, course.length), { units: race.units });
      let [lon, lat] = pt.geometry.coordinates;
      // GPS noise
      lat += ((Math.random() - 0.5) * 2 * jitterM) / 111_320;
      lon += ((Math.random() - 0.5) * 2 * jitterM) / (111_320 * Math.cos((lat * Math.PI) / 180));

      const now = new Date();
      const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      s.battery = Math.max(5, s.battery - 0.001 * timescale);
      const speedKmh = (s.paceMph * 1.60934).toFixed(1);
      s.count = (s.count + 1) % 0x10000; // count numbers are per-device

      // 22-field GL300-style GTFRI frame
      const frame =
        `+RESP:GTFRI,F50A01,${s.imei},,0,0,1,1,${speedKmh},90,10.0,` +
        `${lon.toFixed(6)},${lat.toFixed(6)},${ts},0310,0410,9909,06F23911,,` +
        `${Math.round(s.battery)},${ts},${s.count.toString(16).toUpperCase().padStart(4, '0')}$`;
      sock.write(frame);
    }

    if (allDone) {
      console.log('[sim] all trackers finished');
      clearInterval(timer);
      sock.end();
    }
  }, (intervalS * 1000) / timescale);
});

sock.on('error', (err) => {
  console.error('[sim] connection error:', err.message);
  process.exit(1);
});

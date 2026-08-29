import fs from 'node:fs';
import readline from 'node:readline';
import { loadEventConfig } from '../config/load.js';
import { RaceEngine } from '../engine/race-engine.js';
import { FixGate } from '../ingest/hygiene.js';
import { parseAsciiFrame } from '../ingest/parsers/ascii-gtfri.js';
import { Store } from '../state/store.js';
import type { Fix } from '../ingest/types.js';

/**
 * Replay a past race through the engine — from a legacy-format log file
 * ("MM/DD/YYYY H:mm:ss.SSS | +RESP:GTFRI,...") or from a session in the store.
 * Prints a distance timeline per tracker; the verification tool for engine
 * changes and for post-race "what happened at mile 18" analysis.
 *
 *   npm run replay -- --event events/<e>.json --race <id> --log legacy/logs/<imei>.log
 *   npm run replay -- --event events/<e>.json --race <id> --session <id> [--db data/ptt.db]
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const eventPath = arg('event');
const raceId = arg('race');
if (!eventPath || !raceId) {
  console.error('Usage: npm run replay -- --event <cfg> --race <id> (--log <file> | --session <id>)');
  process.exit(1);
}

const cfg = loadEventConfig(eventPath);
const race = cfg.races.find((r) => r.id === raceId);
if (!race) {
  console.error(`Unknown race ${raceId}`);
  process.exit(1);
}

const gate = new FixGate({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxFutureMs: Number.MAX_SAFE_INTEGER });
let lastLine = '';
const engine = new RaceEngine(cfg, race, {
  onTrackerUpdate: (_raceId, s) => {
    lastLine = `${s.label} @ ${s.distance?.toFixed(3)} ${race.units}` + (s.suspect ? ' (SUSPECT: off course)' : '');
  },
  onRoleDistance: () => {},
  onSessionEvent: () => {},
});
engine.setStatus('armed');
engine.setStatus('live');

const fixes: Fix[] = [];

async function collect(): Promise<void> {
  const logPath = arg('log');
  if (logPath) {
    const rl = readline.createInterface({ input: fs.createReadStream(logPath) });
    for await (const line of rl) {
      const m = line.match(/^\s*[\d/]+ [\d:.]+ \| (.+)$/);
      const frameText = m ? m[1] : line.trim();
      if (!frameText.startsWith('+')) continue;
      const parsed = parseAsciiFrame(frameText, 'replay', Date.now());
      fixes.push(...parsed.fixes);
    }
  } else {
    const sessionId = Number(arg('session'));
    if (!sessionId) throw new Error('Provide --log or --session');
    const store = new Store(arg('db', 'data/ptt.db')!);
    const session = store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | { started_at_ms: number; ended_at_ms: number | null }
      | undefined;
    if (!session) throw new Error(`No session ${sessionId}`);
    const rows = store.fixesBetween(session.started_at_ms, session.ended_at_ms ?? Date.now()) as Array<
      Record<string, unknown>
    >;
    for (const r of rows) {
      fixes.push({
        imei: r.imei as string,
        lat: r.lat as number,
        lon: r.lon as number,
        altM: (r.alt_m as number) ?? undefined,
        tUtcMs: r.t_utc_ms as number,
        speedKmh: (r.speed_kmh as number) ?? undefined,
        azimuth: (r.azimuth as number) ?? undefined,
        accuracy: (r.accuracy as number) ?? undefined,
        battery: (r.battery as number) ?? undefined,
        fixValid: !!r.fix_valid,
        buffered: !!r.buffered,
        countNumber: (r.count_number as number) ?? undefined,
        source: 'replay',
        protocol: r.protocol as Fix['protocol'],
        raw: (r.raw as string) ?? '',
        receivedAtMs: r.received_ms as number,
      });
    }
    store.close();
  }
}

await collect();
// Replay strictly in GPS-time order regardless of arrival order in the source.
fixes.sort((a, b) => a.tUtcMs - b.tUtcMs);
console.log(`[replay] ${fixes.length} fixes → race "${race.id}" (course ${engine.course.length.toFixed(2)} ${race.units})`);

let accepted = 0;
let inRoster = 0;
const rejects: Record<string, number> = {};
for (const fix of fixes) {
  fix.receivedAtMs = fix.tUtcMs; // age gates are relative to arrival; replay pretends live arrival
  const g = gate.accept(fix);
  if (!g.ok) {
    rejects[g.reason!] = (rejects[g.reason!] ?? 0) + 1;
    continue;
  }
  accepted++;
  if (engine.trackers.has(fix.imei)) {
    inRoster++;
    engine.onFix(fix);
    if (inRoster % 50 === 0) console.log(`  [${new Date(fix.tUtcMs).toISOString()}] ${lastLine}`);
  }
}

console.log(`[replay] accepted ${accepted}/${fixes.length} (rejected: ${JSON.stringify(rejects)}), ${inRoster} in roster`);
for (const s of engine.trackers.values()) {
  if (s.distance !== undefined) {
    console.log(`  ${s.label} (${s.imei}): final ${s.distance.toFixed(3)} ${race.units}, off-course ${((s.offCourse ?? 0) * 1609).toFixed(0)} m-ish`);
  }
}

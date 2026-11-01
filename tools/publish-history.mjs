#!/usr/bin/env node
/**
 * What the server actually sent to Firebase, read back out of the box.
 *
 * Every publish is logged to the `publishes` table as it is made, and every
 * operator action to `session_events`. When a scoreboard or a Firebase node
 * misbehaves during a race, those two tables together say what was written,
 * when, and what the crew did just before it - which is the difference
 * between diagnosing a meet and guessing about it.
 *
 * Read-only: it opens the live database without taking a write lock, so it is
 * safe to run while a race is on.
 *
 *   node tools/publish-history.mjs                       # last 24h, every key
 *   node tools/publish-history.mjs --key distance        # just the distances
 *   node tools/publish-history.mjs --hours 72 --removed  # only disappearances
 *
 * Only transitions are printed. A key written with the same value on every
 * fix is one line, not nine thousand; a key whose value is null is marked
 * REMOVED, because a null in an RTDB update() deletes the key rather than
 * storing it.
 */

import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const dbPath = path.resolve(flag('db', 'data/ptt.db'));
const hours = Number(flag('hours', '24'));
const keyFilter = flag('key', null);
const pathFilter = flag('path', null);
const removedOnly = has('removed');
const since = Date.now() - hours * 3600_000;

const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour12: false });
const day = (ms) => new Date(ms).toLocaleDateString('en-CA');

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Cannot read ${dbPath}: ${err.message}`);
  process.exit(1);
}

console.log(`${dbPath}\nlast ${hours}h (since ${day(since)} ${clock(since)})\n`);

// ---------------------------------------------------------------- sessions

const sessions = db
  .prepare(`SELECT * FROM sessions WHERE started_at_ms > ? ORDER BY started_at_ms`)
  .all(since);

if (sessions.length === 0) {
  console.log('No race sessions in this window.\n');
} else {
  console.log('RACES RUN');
  for (const s of sessions) {
    const ended = s.ended_at_ms ? clock(s.ended_at_ms) : 'still open';
    console.log(`  #${s.id}  ${s.event_id} / ${s.race_id}   ${clock(s.started_at_ms)} -> ${ended}`);
  }
  console.log('');
}

// ------------------------------------------------------- operator actions

const ids = sessions.map((s) => s.id);
if (ids.length > 0) {
  const events = db
    .prepare(
      `SELECT * FROM session_events WHERE session_id IN (${ids.map(() => '?').join(',')})
       ORDER BY t_ms`,
    )
    .all(...ids);
  // Fixes are not logged here, so this is already only the things people did.
  console.log(`WHAT THE CREW DID (${events.length})`);
  for (const e of events) {
    console.log(`  ${clock(e.t_ms)}  #${e.session_id}  ${e.type.padEnd(20)} ${e.payload}`);
  }
  console.log('');
}

// -------------------------------------------------------------- publishes

const rows = db
  .prepare(`SELECT * FROM publishes WHERE t_ms > ? ORDER BY t_ms, id`)
  .all(since);

/** path -> key -> { value, firstMs, lastMs, writes } for the run in progress. */
const open = new Map();
const lines = [];
let totalKeys = 0;

const close = (pathName, key, run) => {
  lines.push({
    tMs: run.firstMs,
    pathName,
    key,
    value: run.value,
    writes: run.writes,
    untilMs: run.lastMs,
  });
};

for (const row of rows) {
  if (pathFilter && !row.path.includes(pathFilter)) continue;
  let value;
  try {
    value = JSON.parse(row.value);
  } catch {
    continue;
  }
  if (!value || typeof value !== 'object') continue;
  for (const [key, v] of Object.entries(value)) {
    if (keyFilter && key !== keyFilter) continue;
    totalKeys++;
    if (!open.has(row.path)) open.set(row.path, new Map());
    const perKey = open.get(row.path);
    const run = perKey.get(key);
    const same = run && JSON.stringify(run.value) === JSON.stringify(v);
    if (same) {
      run.writes++;
      run.lastMs = row.t_ms;
      continue;
    }
    if (run) close(row.path, key, run);
    perKey.set(key, { value: v, firstMs: row.t_ms, lastMs: row.t_ms, writes: 1 });
  }
}
for (const [pathName, perKey] of open) for (const [key, run] of perKey) close(pathName, key, run);

lines.sort((a, b) => a.tMs - b.tMs || a.pathName.localeCompare(b.pathName));

const shown = removedOnly ? lines.filter((l) => l.value === null) : lines;

console.log(
  `WRITES  —  ${rows.length} publish rows, ${totalKeys} key writes, ` +
    `${lines.length} value changes${removedOnly ? `, ${shown.length} removals` : ''}\n`,
);

if (shown.length === 0) {
  console.log('  (nothing matched)');
} else {
  for (const l of shown) {
    const held = l.writes > 1 ? ` x${l.writes} to ${clock(l.untilMs)}` : '';
    const value = l.value === null ? 'REMOVED  <-- null deletes the key' : JSON.stringify(l.value);
    console.log(`  ${clock(l.tMs)}  ${l.pathName}/${l.key}  =  ${value}${held}`);
  }
}

// A key that is written null repeatedly is being created and destroyed, which
// is worth calling out separately from a one-off disappearance.
const churn = new Map();
for (const l of lines) {
  if (l.value !== null) continue;
  const k = `${l.pathName}/${l.key}`;
  churn.set(k, (churn.get(k) ?? 0) + 1);
}
const repeated = [...churn.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
if (repeated.length > 0) {
  console.log('\nKEYS REMOVED MORE THAN ONCE — written, deleted, written again:');
  for (const [k, n] of repeated) console.log(`  ${n}x  ${k}`);
}

db.close();

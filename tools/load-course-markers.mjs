#!/usr/bin/env node
/**
 * Put a course's markers on the server.
 *
 * Markers belong to the course rather than to a race — the posts are painted
 * on the road and the mats go in the same places every year — so they live in
 * the course library in SQLite, not in the event file. Which means a course
 * authored from a KML full of placemarks has no way in except by hand through
 * the course editor, one row at a time. This takes the whole set at once.
 *
 *   node tools/load-course-markers.mjs events/reference/nyc-marathon-2026.markers.json \
 *     --course courses/nyc-marathon-2026.kml --user admin
 *
 * The payload is { auto, units, markers: [{ at, label, kind, units }] }, which
 * is exactly what GET /api/courses/<file>/markers returns — so an existing
 * course's markers can be pulled out, edited and pushed back.
 *
 * `at` is a distance along the course in the marker units; `kind` is 'timing'
 * for a mat, 'post' for a distance post, or 'point' for anything else. START
 * and FINISH are drawn from the ends of the line and are not listed.
 *
 * --server defaults to the box itself; run it there rather than over the
 * tunnel. The password comes from PTT_PASSWORD, or is prompted for.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { args, call, login, password } from './lib/console-api.mjs';

const { flag, has, positional } = args(process.argv.slice(2), ['server', 'course', 'user']);
const file = positional[0];
const server = flag('server', 'http://localhost:8080').replace(/\/$/, '');
const course = flag('course', null);
const user = flag('user', 'admin');
const dryRun = has('dry-run');

if (!file || !course) {
  console.error('Usage: node tools/load-course-markers.mjs <markers.json> --course courses/<file> [--user admin] [--server http://localhost:8080] [--dry-run]');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const markers = Array.isArray(payload.markers) ? payload.markers : [];
if (markers.length === 0) {
  // An empty list is a valid instruction to the API — it clears the course.
  // It is almost never what someone running this meant, so it takes the UI.
  console.error('No markers in the payload — refusing to clear the course by accident.');
  process.exit(1);
}
const bad = markers.filter((m) => !Number.isFinite(Number(m.at)) || Number(m.at) < 0);
if (bad.length > 0) {
  console.error(`${bad.length} marker(s) have no usable distance, e.g. ${JSON.stringify(bad[0])}`);
  process.exit(1);
}

const kinds = markers.reduce((a, m) => ({ ...a, [m.kind ?? 'point']: (a[m.kind ?? 'point'] ?? 0) + 1 }), {});
const units = payload.units === 'kilometers' ? 'kilometers' : 'miles';
console.log(`${file}\n  ${markers.length} markers ${JSON.stringify(kinds)}`);
console.log(`  auto posts: ${payload.auto === true}, marker units: ${units}`);
console.log(`  -> ${server}  ${course}`);

if (dryRun) {
  console.log('\n--dry-run: nothing sent.');
  process.exit(0);
}

const cookie = await login(server, user, await password(user));
const name = path.basename(course);
const stored = await call(
  server,
  cookie,
  'PUT',
  `/api/courses/${encodeURIComponent(name)}/markers`,
  { auto: payload.auto === true, units, markers },
);

const kept = stored?.markers?.length ?? 0;
console.log(`\nStored ${kept} markers on ${course}.`);
if (kept !== markers.length) {
  console.log(`  note: ${markers.length - kept} were dropped by the server.`);
  process.exit(1);
}

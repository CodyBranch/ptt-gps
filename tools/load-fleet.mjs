#!/usr/bin/env node
/**
 * Bring the fleet registry up to date from a fleet sheet.
 *
 * The registry is what the console knows about every tracker that exists —
 * its label, its model, whether it reports a battery — independently of which
 * meet it is working this weekend. Keeping it current is what makes the device
 * list, the roster pickers and the fleet health page legible, and typing
 * sixty-odd IMEIs into a form is not a thing anyone should do twice.
 *
 *   node tools/load-fleet.mjs franklin-gps-fleet.csv --user admin
 *   node tools/load-fleet.mjs franklin-gps-fleet.csv --dry-run
 *
 * Expected columns: IMEI, Name, Model, and optionally Class, Enabled,
 * "Assigned meet". Only the registry is touched — a device's meet assignment
 * is a property of an event's roster, not of the device, so the sheet's
 * Enabled/meet columns are carried into the notes and nothing else.
 *
 * Nothing is ever retired by this: that is a decision about hardware going out
 * of service, and a blank cell in a spreadsheet is not that decision.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { args, call, login, parseCsv, password } from './lib/console-api.mjs';

const { flag, has, positional } = args(process.argv.slice(2), ['server', 'user']);
const file = positional[0];
const server = flag('server', 'http://localhost:8080').replace(/\/$/, '');
const user = flag('user', 'admin');
const dryRun = has('dry-run');

if (!file) {
  console.error('Usage: node tools/load-fleet.mjs <fleet.csv> [--user admin] [--server http://localhost:8080] [--dry-run]');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
const missing = ['IMEI', 'Name'].filter((c) => !(c in (rows[0] ?? {})));
if (missing.length > 0) {
  console.error(`Sheet is missing column(s): ${missing.join(', ')}`);
  process.exit(1);
}

/** A GV500CNA is wired into the vehicle and reports no battery percentage. */
const VEHICLE_POWERED = /^GV500/i;

const devices = [];
const skipped = [];
for (const r of rows) {
  if (!/^(\d{15}|(?=.*[A-Za-z])[A-Za-z0-9._-]{2,24})$/.test(r.IMEI ?? '')) {
    skipped.push(`${r.IMEI || '(blank)'} — not a usable device id`);
    continue;
  }
  if (!r.Name) {
    skipped.push(`${r.IMEI} — no name`);
    continue;
  }
  const model = r.Model && r.Model !== '?' ? r.Model : undefined;
  const notes = [
    r.Class ? `class: ${r.Class}` : '',
    r['Assigned meet'] ? `meet ${r['Assigned meet']}` : '',
    r.Enabled === 'no' ? 'not in use' : '',
  ].filter(Boolean).join('; ');
  devices.push({
    imei: r.IMEI,
    label: r.Name,
    model,
    hasBattery: !VEHICLE_POWERED.test(r.Model ?? ''),
    notes: notes || undefined,
    retired: false,
  });
}

const byModel = devices.reduce((a, d) => ({ ...a, [d.model ?? 'unknown']: (a[d.model ?? 'unknown'] ?? 0) + 1 }), {});
console.log(`${file}\n  ${devices.length} devices ${JSON.stringify(byModel)}`);
console.log(`  no battery reported: ${devices.filter((d) => !d.hasBattery).length}`);
if (skipped.length > 0) console.log(`  skipped ${skipped.length}:\n    ${skipped.join('\n    ')}`);
console.log(`  -> ${server}`);

if (dryRun) {
  for (const d of devices) {
    console.log(`  ${d.imei}  ${d.label.padEnd(30)} ${(d.model ?? '?').padEnd(9)} bat=${d.hasBattery ? 'y' : 'n'}  ${d.notes ?? ''}`);
  }
  console.log('\n--dry-run: nothing sent.');
  process.exit(0);
}

const cookie = await login(server, user, await password(user));
const before = new Set((await call(server, cookie, 'GET', '/api/fleet')).map?.((d) => d.imei) ?? []);

let ok = 0;
const failed = [];
for (const d of devices) {
  try {
    await call(server, cookie, 'POST', '/api/fleet', d);
    ok++;
  } catch (err) {
    failed.push(`${d.imei} ${d.label}: ${err.message}`);
  }
}

console.log(`\n${ok} of ${devices.length} saved.`);
const added = devices.filter((d) => !before.has(d.imei)).length;
console.log(`  new to the registry: ${added}, updated: ${ok - added}`);
if (failed.length > 0) {
  console.log(`  failed ${failed.length}:\n    ${failed.join('\n    ')}`);
  process.exit(1);
}

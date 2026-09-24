import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';
import { App, trackable } from '../src/app.js';
import { EventSchema, type EventConfig } from '../src/config/schema.js';
import { parseEventConfig } from '../src/config/load.js';
import { Store } from '../src/state/store.js';

/**
 * A race that has no line to run on yet.
 *
 * A meet manager knows its schedule weeks out — the races, their numbers, their
 * start times, the order they run in — and the course is walked with a GPS a few
 * days before, sometimes the morning of. Requiring a traced line before a race
 * could be accepted meant the meet could not be sent at all until the last
 * piece existed, and then had to be sent again afterwards.
 *
 * So a race is carried without a course. What has to hold:
 *
 *   the event still LOADS, which is the real risk — an empty course path
 *   resolves to the event's own directory, which exists, so a naive check
 *   passes it through and the engine is later handed a folder to read;
 *
 *   no engine is built for it, and nothing that walks the engines trips over
 *   its absence;
 *
 *   and linking a course afterwards builds one, because an export that can
 *   never become trackable is not worth having.
 */

const LEAD = '015181000128000';
let coursePath: string;
let eventDir: string;

beforeAll(() => {
  eventDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-course-'));
  const start = turf.point([-92.3, 38.9]);
  const coords: string[] = [];
  for (let d = 0; d <= 3.0001; d += 0.1) {
    const p = turf.destination(start, d, 90, { units: 'miles' });
    coords.push(`${p.geometry.coordinates[0]},${p.geometry.coordinates[1]},0`);
  }
  coursePath = path.join(eventDir, 'gans.kml');
  fs.writeFileSync(
    coursePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<name>gans</name><LineString><coordinates>${coords.join(' ')}</coordinates></LineString>
</Placemark></Document></kml>`,
  );
});

/** One race ready to run, one still waiting for its course. */
function makeConfig(): EventConfig {
  return EventSchema.parse({
    id: 'gans-creek-classic-college',
    name: 'Gans Creek Classic College',
    meetId: 4211,
    trackers: [{ imei: LEAD, label: 'Lead A' }],
    vehicles: [{ key: 'lead-car', label: 'Lead Car', trackers: [LEAD] }],
    roles: [{ key: 'lead', label: 'Leader', vehicle: 'lead-car', cmd: 0, clockSlot: 1 }],
    races: [
      { id: 'womens-gold-6k', name: "Women's Gold Invite 6k", course: coursePath, eventNumber: 1 },
      { id: 'mens-gold-8k', name: "Men's Gold Invite 8k", course: '', eventNumber: 2, scheduledStart: '08:45' },
    ],
  });
}

/** The smallest event the loader will accept, around whatever races are given. */
const rawEvent = (races: Array<Record<string, unknown>>) => ({
  id: 'gans', name: 'Gans', meetId: 4211,
  trackers: [], vehicles: [], roles: [],
  races,
});

const makeApp = (cfg: EventConfig) =>
  new App(cfg, new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'awaiting-db-')), 'x.db')), { emit: () => {} });

describe('a race whose course has not been traced yet', () => {
  it('is a race the schema accepts', () => {
    const cfg = makeConfig();
    expect(cfg.races[1].course).toBe('');
    expect(cfg.races[1].name).toBe("Men's Gold Invite 8k");
  });

  it('may leave the course out entirely', () => {
    const cfg = EventSchema.parse(rawEvent([{ id: 'r', name: 'R' }]));
    expect(cfg.races[0].course).toBe('');
  });

  it('THE EVENT STILL LOADS — an empty path is not the event folder', () => {
    const { resolved } = parseEventConfig(rawEvent([{ id: 'r', name: 'R', course: '' }]), eventDir);
    expect(resolved.races[0].course).toBe('');
    // The bug this guards: path.resolve(dir, '') is dir, and dir exists, so a
    // naive existence check passes and the engine is handed a folder.
    expect(resolved.races[0].course).not.toBe(eventDir);
  });

  it('a course that really is missing is still an error', () => {
    expect(() => parseEventConfig(
      rawEvent([{ id: 'r', name: 'R', course: 'courses/nope.kml' }]),
      eventDir,
    )).toThrow(/course file not found/);
  });

  it('gets no engine, while the race beside it does', () => {
    const app = makeApp(makeConfig());
    expect(app.engines.has('womens-gold-6k')).toBe(true);
    expect(app.engines.has('mens-gold-8k')).toBe(false);
  });

  it('does not stop the event running the races that are ready', () => {
    const app = makeApp(makeConfig());
    expect(app.hasActiveRaces()).toBe(false);
    expect(() => app.raceSnapshot('womens-gold-6k')).not.toThrow();
    // Fixes are pushed at every engine; a missing one must not be walked into.
    expect(() => app.onFix({
      imei: LEAD, lat: 38.9, lon: -92.3, tUtcMs: Date.now(), fixValid: true,
      source: 'test', raw: '', receivedAtMs: Date.now(),
    } as Parameters<App['onFix']>[0])).not.toThrow();
  });

  it('LINKING A COURSE BUILDS ITS ENGINE', () => {
    const app = makeApp(makeConfig());
    const next = makeConfig();
    next.races[1].course = coursePath;
    app.applyConfig(next);
    expect(app.engines.has('mens-gold-8k')).toBe(true);
    expect(app.engines.get('mens-gold-8k')!.course.length).toBeGreaterThan(0);
  });

  it('  and the race keeps what it was pushed with', () => {
    const app = makeApp(makeConfig());
    const next = makeConfig();
    next.races[1].course = coursePath;
    app.applyConfig(next);
    const snap = app.raceSnapshot('mens-gold-8k');
    expect(snap.eventNumber).toBe(2);
    expect(snap.scheduledStart).toBe('08:45');
  });

  it('taking a course back off a race that is not running drops its engine', () => {
    const app = makeApp(makeConfig());
    const next = makeConfig();
    next.races[0].course = '';
    app.applyConfig(next);
    expect(app.engines.has('womens-gold-6k')).toBe(false);
    expect(app.engines.has('mens-gold-8k')).toBe(false);
  });

  it('but not one that is armed — that is refused, and says so', () => {
    const app = makeApp(makeConfig());
    app.engines.get('womens-gold-6k')!.setStatus('armed', 'test');
    const next = makeConfig();
    next.races[0].course = '';
    expect(() => app.applyConfig(next)).toThrow(/course for "Women's Gold Invite 6k"/);
    expect(app.engines.has('womens-gold-6k')).toBe(true);
  });

  it('knows which races are trackable', () => {
    expect(trackable({ course: coursePath })).toBe(true);
    expect(trackable({ course: '' })).toBe(false);
    expect(trackable({ course: '   ' })).toBe(false);
    expect(trackable({})).toBe(false);
  });
});

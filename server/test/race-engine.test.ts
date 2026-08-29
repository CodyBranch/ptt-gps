import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventSchema, resolveRace, type EventConfig } from '../src/config/schema.js';
import { RaceEngine, type RoleState, type TrackerState } from '../src/engine/race-engine.js';
import { loadCourse } from '../src/engine/course.js';
import type { Fix } from '../src/ingest/types.js';

const LEAD_A = '015181000128000';
const LEAD_B = '860201060937540';
const CHASE_A = '015181000121005';

let dir: string;
let coursePathKml: string;

/** 3-mile straight-line course written as KML — exercises the KML importer. */
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-test-'));
  const start = turf.point([-71.5, 42.23]);
  const coords: string[] = [];
  for (let d = 0; d <= 3.0001; d += 0.1) {
    const p = turf.destination(start, d, 90, { units: 'miles' });
    coords.push(`${p.geometry.coordinates[0]},${p.geometry.coordinates[1]},0`);
  }
  coursePathKml = path.join(dir, 'course.kml');
  fs.writeFileSync(
    coursePathKml,
    `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<name>Test 3mi</name><LineString><coordinates>${coords.join(' ')}</coordinates></LineString>
</Placemark></Document></kml>`,
  );
});

function makeConfig(): EventConfig {
  return EventSchema.parse({
    id: 'test-meet',
    name: 'Test Meet',
    meetId: 9999,
    trackers: [
      { imei: LEAD_A, label: 'Lead A' },
      { imei: LEAD_B, label: 'Lead B' },
      { imei: CHASE_A, label: 'Chase A' },
    ],
    roles: [
      { key: 'lead', label: 'Leader', trackers: [LEAD_A, LEAD_B], cmd: 0, clockSlot: 1, mapEvent: 'elite_women' },
      { key: 'chase', label: 'Chase', trackers: [CHASE_A], cmd: 1, mapEvent: 'elite_women_chase' },
    ],
    races: [
      { id: 'r1', name: 'Race 1', course: 'course.kml' },
      { id: 'r2', name: 'Race 2', course: 'course.kml' },
    ],
  });
}

function makeEngine(cfg = makeConfig(), raceId = 'r1') {
  const events: Array<{ type: string; payload: unknown }> = [];
  const published: Array<{ role: string; imei: string; distance?: number }> = [];
  const race = cfg.races.find((r) => r.id === raceId)!;
  race.course = coursePathKml;
  const engine = new RaceEngine(cfg, race, {
    onTrackerUpdate: () => {},
    onRoleDistance: (_r, role: RoleState, s: TrackerState) => {
      published.push({ role: role.key, imei: s.imei, distance: s.distance });
    },
    onSessionEvent: (_r, type, payload) => {
      events.push({ type, payload });
    },
  });
  return { engine, events, published };
}

function fixAt(engine: RaceEngine, imei: string, dMiles: number, tUtcMs: number): Fix {
  const p = turf.along(engine.course.line, dMiles, { units: 'miles' });
  return {
    imei,
    lon: p.geometry.coordinates[0],
    lat: p.geometry.coordinates[1],
    tUtcMs,
    fixValid: true,
    buffered: false,
    source: 'test',
    protocol: 'gtfri-22',
    raw: '',
    receivedAtMs: tUtcMs,
  };
}

const T0 = 1756400000000;

describe('KML course import', () => {
  it('loads a KML LineString and measures its length', () => {
    const course = loadCourse(coursePathKml, 'miles');
    expect(course.length).toBeCloseTo(3.0, 1);
    expect(course.line.geometry.coordinates[0]).toHaveLength(2); // altitude stripped
  });
});

describe('meet-level inheritance', () => {
  it('races inherit meet trackers/roles; overrides apply per race', () => {
    const cfg = makeConfig();
    const base = resolveRace(cfg, cfg.races[0]);
    expect(base.trackers).toHaveLength(3);
    expect(base.roles.map((r) => r.key)).toEqual(['lead', 'chase']);

    cfg.races[1].excludeTrackers = [CHASE_A];
    const overridden = resolveRace(cfg, cfg.races[1]);
    expect(overridden.trackers).toHaveLength(2);
    // chase role loses its only tracker → dropped from the race entirely
    expect(overridden.roles.map((r) => r.key)).toEqual(['lead']);
  });
});

describe('RaceEngine', () => {
  it('ignores fixes while scheduled; computes while armed; publishes only while live', () => {
    const { engine, published } = makeEngine();
    engine.onFix(fixAt(engine, LEAD_A, 0.2, T0));
    expect(engine.trackers.get(LEAD_A)!.distance).toBeUndefined();

    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 0.3, T0 + 10_000));
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.3, 1);
    expect(published).toHaveLength(0); // armed = verify, don't publish

    engine.setStatus('live');
    engine.onFix(fixAt(engine, LEAD_A, 0.4, T0 + 20_000));
    expect(published).toEqual([{ role: 'lead', imei: LEAD_A, distance: published[0].distance }]);
    expect(published[0].distance).toBeCloseTo(0.4, 1);
  });

  it('only the ACTIVE tracker of a role publishes; backups still compute', () => {
    const { engine, published } = makeEngine();
    engine.setStatus('armed');
    engine.setStatus('live');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));
    engine.onFix(fixAt(engine, LEAD_B, 0.45, T0));
    expect(published.map((p) => p.imei)).toEqual([LEAD_A]);
    // backup computed anyway — warm window, ready for failover
    expect(engine.trackers.get(LEAD_B)!.distance).toBeCloseTo(0.45, 1);
  });

  it('failover: switching active flips publishing source seamlessly', () => {
    const { engine, published, events } = makeEngine();
    engine.setStatus('armed');
    engine.setStatus('live');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));
    engine.onFix(fixAt(engine, LEAD_B, 0.48, T0 + 1000));
    engine.setActive('lead', LEAD_B);
    engine.onFix(fixAt(engine, LEAD_B, 0.55, T0 + 11_000));
    engine.onFix(fixAt(engine, LEAD_A, 0.57, T0 + 12_000)); // old primary no longer publishes
    expect(published.map((p) => p.imei)).toEqual([LEAD_A, LEAD_B]);
    expect(events.some((e) => e.type === 'active-tracker')).toBe(true);
  });

  it('rejects activating a tracker not in the role', () => {
    const { engine } = makeEngine();
    expect(() => engine.setActive('lead', CHASE_A)).toThrow(/not in role/);
  });

  it('distance source: GPS stops publishing the role when switched to splits', () => {
    const { engine, published, events } = makeEngine();
    engine.setStatus('armed');
    engine.setStatus('live');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));
    expect(published).toHaveLength(1);

    engine.setSource('lead', 'splits');
    engine.onFix(fixAt(engine, LEAD_A, 0.6, T0 + 10_000));
    expect(published).toHaveLength(1); // suppressed — splits feed owns the number
    // tracker still computes (map/health keep working)
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.6, 1);

    engine.setSource('lead', 'gps');
    engine.onFix(fixAt(engine, LEAD_A, 0.7, T0 + 20_000));
    expect(published).toHaveLength(2);
    expect(events.filter((e) => e.type === 'distance-source')).toHaveLength(2);
  });

  it('reset returns every tracker to the start line', () => {
    const { engine, events } = makeEngine();
    engine.setStatus('armed');
    engine.setStatus('live');
    // two fixes so the window has actually advanced off the start
    engine.onFix(fixAt(engine, LEAD_A, 0.8, T0));
    engine.onFix(fixAt(engine, LEAD_A, 1.2, T0 + 10_000));
    engine.onFix(fixAt(engine, LEAD_B, 0.7, T0));
    // hold a tracker to a zone, as an operator would mid-race
    engine.setWindow(LEAD_B, 0.5, 2, true, 'op');

    const before = engine.trackers.get(LEAD_A)!;
    expect(before.distance).toBeCloseTo(1.2, 1);
    expect(before.window.min).toBeGreaterThan(0);
    expect(engine.trackers.get(LEAD_B)!.window.mode).toBe('clamped');

    engine.resetTrackers('op');

    for (const imei of [LEAD_A, LEAD_B]) {
      const t = engine.trackers.get(imei)!;
      expect(t.distance).toBeUndefined();
      expect(t.speedCalMph).toBeUndefined();
      expect(t.window.min).toBe(0); // back to the initial 0..initialMax slice
      expect(t.window.mode).toBe('auto'); // latched zone released
    }
    expect(events.some((e) => e.type === 'race-reset')).toBe(true);
  });

  it('a tracker that reset is re-snapped from the start, not from its old distance', () => {
    const { engine } = makeEngine();
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 0.8, T0));
    engine.resetTrackers();
    // a fix near the start would previously be dragged forward by the stale
    // distance and the advanced window
    engine.onFix(fixAt(engine, LEAD_A, 0.2, T0 + 10_000));
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.2, 1);
  });

  it('rejects switching source on an unknown role', () => {
    const { engine } = makeEngine();
    expect(() => engine.setSource('nope', 'splits')).toThrow(/Unknown role/);
  });

  it('window override: one-shot reset and latched zone clamp', () => {
    const { engine, events } = makeEngine();
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));

    engine.setWindow(LEAD_A, 2.0, 2.5, false);
    engine.onFix(fixAt(engine, LEAD_A, 2.2, T0 + 10_000));
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(2.2, 1);

    engine.setWindow(LEAD_A, 2.0, 2.5, true);
    engine.onFix(fixAt(engine, LEAD_A, 2.9, T0 + 20_000)); // outside the zone
    const s = engine.trackers.get(LEAD_A)!;
    expect(s.distance!).toBeLessThanOrEqual(2.5 + 1e-6);
    expect(s.window.mode).toBe('clamped');

    engine.releaseClamp(LEAD_A);
    // Window is still around the old zone; it takes a couple of fixes to catch up.
    engine.onFix(fixAt(engine, LEAD_A, 2.9, T0 + 30_000));
    engine.onFix(fixAt(engine, LEAD_A, 2.9, T0 + 40_000));
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(2.9, 1);
    expect(events.filter((e) => e.type === 'window-override')).toHaveLength(2);
  });

  it('validates window bounds', () => {
    const { engine } = makeEngine();
    expect(() => engine.setWindow(LEAD_A, 2.5, 2.0, false)).toThrow(/greater than start/);
    expect(() => engine.setWindow(LEAD_A, 0, 99, false)).toThrow(/within 0\.\./);
  });

  it('keeps per-race window state independent for the same physical tracker', () => {
    const cfg = makeConfig();
    const a = makeEngine(cfg, 'r1');
    const b = makeEngine(cfg, 'r2');
    a.engine.setStatus('armed');
    b.engine.setStatus('armed');
    a.engine.onFix(fixAt(a.engine, LEAD_A, 0.8, T0));
    b.engine.onFix(fixAt(b.engine, LEAD_A, 0.1, T0 + 1000));
    expect(a.engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.8, 1);
    expect(b.engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.1, 1);
    // a's window advanced around 0.8; b's is untouched by it
    expect(a.engine.trackers.get(LEAD_A)!.window.min).toBeGreaterThan(0.2);
    expect(b.engine.trackers.get(LEAD_A)!.window.min).toBe(0);
  });

  it('computes speed from successive fixes (legacy speed_cal)', () => {
    const { engine } = makeEngine();
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 1.0, T0));
    engine.onFix(fixAt(engine, LEAD_A, 1.1, T0 + 30_000)); // 0.1 mi in 30 s = 12 mph
    expect(engine.trackers.get(LEAD_A)!.speedCalMph).toBeCloseTo(12, 0);
  });
});

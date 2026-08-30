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
    vehicles: [
      { key: 'lead-car', label: 'Lead Car', trackers: [LEAD_A, LEAD_B] },
      { key: 'chase-car', label: 'Chase Car', trackers: [CHASE_A] },
    ],
    roles: [
      { key: 'lead', label: 'Leader', vehicle: 'lead-car', cmd: 0, clockSlot: 1, mapEvent: 'elite_women' },
      { key: 'chase', label: 'Chase', vehicle: 'chase-car', cmd: 1, mapEvent: 'elite_women_chase' },
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
    // The chase role loses its only tracker but is KEPT: a role nobody is
    // covering is a gap the crew has to see, not something to hide by
    // dropping the row. The console lists it under "Not being covered".
    expect(overridden.roles.map((r) => r.key)).toEqual(['lead', 'chase']);
    expect(overridden.roles.find((r) => r.key === 'chase')!.trackers).toEqual([]);
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

  it('records positions before the gun without snapping them to the course', () => {
    const { engine, published } = makeEngine();
    engine.onFix(fixAt(engine, LEAD_A, 0.3, T0));
    const t = engine.trackers.get(LEAD_A)!;
    // the crew can see the vehicle on the map...
    expect(t.lastFix).toBeDefined();
    expect(t.lastFix!.lat).toBeCloseTo(fixAt(engine, LEAD_A, 0.3, T0).lat, 5);
    // ...but a scheduled race has no distance, window movement or output
    expect(t.distance).toBeUndefined();
    expect(t.window.min).toBe(0);
    expect(published).toHaveLength(0);
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

  it('reassigns a role to another vehicle without moving its output bindings', () => {
    const { engine, published, events } = makeEngine();
    engine.setStatus('armed');
    engine.setStatus('live');
    engine.onFix(fixAt(engine, LEAD_A, 0.4, T0));
    expect(published.map((p) => p.imei)).toEqual([LEAD_A]);

    // the chase car takes over the lead role mid-race
    engine.setVehicle('lead', 'chase-car', 'op');
    const lead = engine.roles.find((r) => r.key === 'lead')!;
    expect(lead.vehicle).toBe('chase-car');
    expect(lead.activeImei).toBe(CHASE_A);
    // the publishing identity is untouched — the scoreboard slot does not move
    expect(lead.clockSlot).toBe(1);
    expect(lead.cmd).toBe(0);
    expect(events.some((e) => e.type === 'role-vehicle')).toBe(true);

    published.length = 0;
    engine.onFix(fixAt(engine, CHASE_A, 0.5, T0 + 10_000));
    // It is now covering the lead role as well as its own, and honestly feeds
    // both — a handover state the operator is expected to resolve, which
    // rolesFor() surfaces rather than the engine silently picking one.
    expect(published.map((p) => p.role).sort()).toEqual(['chase', 'lead']);
    expect(engine.rolesFor('chase-car').map((r) => r.key).sort()).toEqual(['chase', 'lead']);

    // and the vehicle that handed over publishes nothing for the lead role
    published.length = 0;
    engine.onFix(fixAt(engine, LEAD_A, 0.6, T0 + 20_000));
    expect(published).toHaveLength(0);
  });

  it('a vehicle taking over arrives with a warm window, not from the start', () => {
    const { engine } = makeEngine();
    engine.setStatus('armed');
    // the chase car has been computing all along, though it published nothing
    engine.onFix(fixAt(engine, CHASE_A, 0.4, T0));
    engine.onFix(fixAt(engine, CHASE_A, 0.9, T0 + 10_000));
    const before = engine.trackers.get(CHASE_A)!.distance;
    expect(before).toBeCloseTo(0.9, 1);

    engine.setVehicle('lead', 'chase-car', 'op');
    // reassignment does not disturb where it already is on the course
    expect(engine.trackers.get(CHASE_A)!.distance).toBeCloseTo(0.9, 1);
  });

  it('moves a tracker to another vehicle without disturbing its tracking', () => {
    const { engine } = makeEngine();
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_B, 0.4, T0));
    const before = engine.trackers.get(LEAD_B)!;
    expect(before.distance).toBeCloseTo(0.4, 1);
    const window = { ...before.window };

    // LEAD_B turns out to be bolted to the chase bike, not the lead one
    engine.moveTracker(LEAD_B, 'chase-car', 'op');
    expect(engine.vehicles.find((v) => v.key === 'lead-car')!.trackers).toEqual([LEAD_A]);
    expect(engine.vehicles.find((v) => v.key === 'chase-car')!.trackers).toContain(LEAD_B);
    // Same device on the same course, so its window and distance carry over:
    // the correction is to the label of what is carrying it, nothing more.
    expect(engine.trackers.get(LEAD_B)!.distance).toBeCloseTo(0.4, 1);
    expect(engine.trackers.get(LEAD_B)!.window).toEqual(window);
    // and the roles now reflect what their vehicles actually carry
    expect(engine.roles.find((r) => r.key === 'lead')!.trackers).toEqual([LEAD_A]);
    expect(engine.roles.find((r) => r.key === 'chase')!.trackers).toContain(LEAD_B);
  });

  it('a role whose publishing tracker is moved away falls back to its primary', () => {
    const { engine } = makeEngine();
    engine.setStatus('armed');
    engine.setActive('lead', LEAD_B, 'op');
    expect(engine.roles.find((r) => r.key === 'lead')!.activeImei).toBe(LEAD_B);

    engine.moveTracker(LEAD_B, 'chase-car', 'op');
    // it cannot keep publishing the lead from a bike that is not on the lead
    expect(engine.roles.find((r) => r.key === 'lead')!.activeImei).toBe(LEAD_A);
  });

  it('detaches a tracker from every vehicle when moved to none', () => {
    const { engine } = makeEngine();
    engine.moveTracker(LEAD_B, '', 'op');
    expect(engine.vehicles.every((v) => !v.trackers.includes(LEAD_B))).toBe(true);
    // still on the roster and still tracked — just not carried by anything
    expect(engine.trackers.has(LEAD_B)).toBe(true);
  });

  it('a mid-race config edit keeps every window and distance', () => {
    const cfg = makeConfig();
    const { engine } = makeEngine(cfg);
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));
    engine.onFix(fixAt(engine, LEAD_B, 0.4, T0));
    const before = {
      a: { ...engine.trackers.get(LEAD_A)! },
      b: { ...engine.trackers.get(LEAD_B)! },
    };

    // rename a tracker, relabel a vehicle, move a scoreboard slot
    cfg.trackers[0].label = 'Lead A (spare)';
    cfg.vehicles[0].label = 'Moto 1';
    cfg.roles[0].clockSlot = 3;
    engine.applyConfig(cfg, cfg.races.find((r) => r.id === 'r1')!);

    expect(engine.trackers.get(LEAD_A)!.label).toBe('Lead A (spare)');
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(before.a.distance!, 5);
    expect(engine.trackers.get(LEAD_A)!.window).toEqual(before.a.window);
    expect(engine.trackers.get(LEAD_B)!.distance).toBeCloseTo(before.b.distance!, 5);
    expect(engine.vehicles[0].label).toBe('Moto 1');
    expect(engine.roles.find((r) => r.key === 'lead')!.clockSlot).toBe(3);
  });

  it('a role keeps its publishing tracker across an edit', () => {
    const cfg = makeConfig();
    const { engine } = makeEngine(cfg);
    engine.setStatus('armed');
    engine.setActive('lead', LEAD_B, 'op');

    cfg.roles[0].label = 'Race Leader';
    engine.applyConfig(cfg, cfg.races.find((r) => r.id === 'r1')!);

    // re-electing the primary here would silently move the output back to A
    expect(engine.roles.find((r) => r.key === 'lead')!.activeImei).toBe(LEAD_B);
    expect(engine.roles.find((r) => r.key === 'lead')!.label).toBe('Race Leader');
  });

  it('a tracker added mid-race starts fresh; one removed is dropped', () => {
    const cfg = makeConfig();
    const { engine } = makeEngine(cfg);
    engine.setStatus('armed');
    engine.onFix(fixAt(engine, LEAD_A, 0.5, T0));

    const SPARE = '860201060000001';
    cfg.trackers.push({ imei: SPARE, label: 'Spare', hasBattery: true });
    cfg.vehicles[0].trackers.push(SPARE);
    cfg.trackers = cfg.trackers.filter((t) => t.imei !== CHASE_A);
    cfg.vehicles[1].trackers = [SPARE];
    engine.applyConfig(cfg, cfg.races.find((r) => r.id === 'r1')!);

    expect(engine.trackers.get(SPARE)!.distance).toBeUndefined();
    expect(engine.trackers.has(CHASE_A)).toBe(false);
    // the tracker that stayed is untouched
    expect(engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.5, 1);
  });

  it('rejects moving a tracker that is not in the race', () => {
    const { engine } = makeEngine();
    expect(() => engine.moveTracker('999999999999999', 'chase-car')).toThrow(/not in race/);
  });

  it('rejects assigning a role to an unknown vehicle', () => {
    const { engine } = makeEngine();
    expect(() => engine.setVehicle('lead', 'nope', 'op')).toThrow(/Unknown vehicle/);
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
    // both inside the initial 0..initialMax window, so each snaps where it is
    a.engine.onFix(fixAt(a.engine, LEAD_A, 0.4, T0));
    b.engine.onFix(fixAt(b.engine, LEAD_A, 0.1, T0 + 1000));
    expect(a.engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.4, 1);
    expect(b.engine.trackers.get(LEAD_A)!.distance).toBeCloseTo(0.1, 1);
    // a's window advanced around 0.4; b's is untouched by it
    expect(a.engine.trackers.get(LEAD_A)!.window.min).toBeGreaterThan(0.1);
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { EventSchema, type EventConfig } from '../src/config/schema.js';
import { Store } from '../src/state/store.js';

const LEAD_A = '015181000128000';
const LEAD_B = '860201060937540';
const CHASE_A = '015181000121005';

let coursePath: string;
let altCoursePath: string;

/** Two straight-line courses so a course swap is a real change, not a no-op. */
beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-edit-'));
  const write = (name: string, bearing: number) => {
    const start = turf.point([-71.5, 42.23]);
    const coords: string[] = [];
    for (let d = 0; d <= 3.0001; d += 0.1) {
      const p = turf.destination(start, d, bearing, { units: 'miles' });
      coords.push(`${p.geometry.coordinates[0]},${p.geometry.coordinates[1]},0`);
    }
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<name>${name}</name><LineString><coordinates>${coords.join(' ')}</coordinates></LineString>
</Placemark></Document></kml>`,
    );
    return file;
  };
  coursePath = write('a.kml', 90);
  altCoursePath = write('b.kml', 180);
});

function makeConfig(): EventConfig {
  return EventSchema.parse({
    id: 'live-edit',
    name: 'Live Edit Meet',
    meetId: 9100,
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
      { key: 'lead', label: 'Leader', vehicle: 'lead-car', cmd: 0, clockSlot: 1 },
      { key: 'chase', label: 'Chase', vehicle: 'chase-car', cmd: 1 },
    ],
    races: [
      { id: 'r1', name: 'Race 1', course: coursePath },
      { id: 'r2', name: 'Race 2', course: coursePath },
    ],
  });
}

function makeApp(cfg: EventConfig) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-edit-db-')), 'x.db');
  const app = new App(cfg, new Store(db), { emit: () => {} });
  return app;
}

describe('editing setup mid-event', () => {
  it('saves an edit while a race is live and keeps the engines', () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    app.engines.get('r1')!.setStatus('armed');
    app.engines.get('r1')!.setStatus('live');
    const engineBefore = app.engines.get('r1');

    const next = makeConfig();
    next.trackers[0].label = 'Lead A (moto 1)';
    next.name = 'Live Edit Meet (rev 2)';
    app.applyConfig(next);

    // the same engine object, not a replacement: state is preserved by identity
    expect(app.engines.get('r1')).toBe(engineBefore);
    expect(app.engines.get('r1')!.trackers.get(LEAD_A)!.label).toBe('Lead A (moto 1)');
    expect(app.cfg.name).toBe('Live Edit Meet (rev 2)');
  });

  it('rebuilds races that are not running, even while another one is live', () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    app.engines.get('r1')!.setStatus('armed');
    const liveEngine = app.engines.get('r1');
    const idleEngine = app.engines.get('r2');

    const next = makeConfig();
    next.races[1].name = 'Race 2 renamed';
    app.applyConfig(next);

    expect(app.engines.get('r1')).toBe(liveEngine); // untouched
    expect(app.engines.get('r2')).not.toBe(idleEngine); // rebuilt
    expect(app.engines.get('r2')!.race.name).toBe('Race 2 renamed');
  });

  it("refuses the course of a race that is running, and names it", () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    app.engines.get('r1')!.setStatus('armed');
    app.engines.get('r1')!.setStatus('live');

    const next = makeConfig();
    next.races[0].course = altCoursePath;
    expect(() => app.applyConfig(next)).toThrow(/course for "Race 1"/);
  });

  it('refuses units, listeners, outputs and removing a running race', () => {
    const start = () => {
      const cfg = makeConfig();
      const app = makeApp(cfg);
      app.engines.get('r1')!.setStatus('armed');
      return app;
    };
    let next = makeConfig();
    next.races[0].units = 'kilometers';
    expect(() => start().applyConfig(next)).toThrow(/units for "Race 1"/);

    next = makeConfig();
    next.listeners = [{ name: 'queclink', port: 1234 }];
    expect(() => start().applyConfig(next)).toThrow(/listener ports/);

    next = makeConfig();
    next.outputUnits = 'kilometers';
    expect(() => start().applyConfig(next)).toThrow(/output units/);

    next = makeConfig();
    next.races = next.races.filter((r) => r.id !== 'r1');
    expect(() => start().applyConfig(next)).toThrow(/removing "Race 1"/);
  });

  it('allows the course of a race that is NOT running while another is live', () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    app.engines.get('r1')!.setStatus('armed');

    const next = makeConfig();
    next.races[1].course = altCoursePath; // r2 is only scheduled
    expect(() => app.applyConfig(next)).not.toThrow();
    expect(app.engines.get('r2')!.race.course).toBe(altCoursePath);
  });

  it('with nothing running, anything goes', () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    const next = makeConfig();
    next.races[0].course = altCoursePath;
    next.outputUnits = 'kilometers';
    expect(() => app.applyConfig(next)).not.toThrow();
  });

  it('adds a race mid-event without touching the live one', () => {
    const cfg = makeConfig();
    const app = makeApp(cfg);
    app.engines.get('r1')!.setStatus('armed');
    app.engines.get('r1')!.setStatus('live');
    const liveEngine = app.engines.get('r1');

    const next = makeConfig();
    next.races.push({ ...next.races[0], id: 'r3', name: 'Race 3' });
    app.applyConfig(next);

    expect(app.engines.has('r3')).toBe(true);
    expect(app.engines.get('r1')).toBe(liveEngine);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { EventSchema, type EventConfig } from '../src/config/schema.js';
import type { Fix } from '../src/ingest/types.js';
import type { Publisher } from '../src/outputs/publisher.js';
import { Store } from '../src/state/store.js';

/**
 * Hiding the distance, and automatic selection, as the App holds them.
 *
 * The engine tests cover the choosing. What can only be tested here is how
 * these settings interact with everything else that writes showDistance -
 * starting a race, the publishing switch, and above all recovering a race
 * after a restart, which re-asserts showDistance and would put back a number
 * someone deliberately took down.
 */

const LEAD_A = '015181000128000';
const LEAD_B = '860201060937540';

let coursePath: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visibility-'));
  const start = turf.point([-71.5, 42.23]);
  const coords: string[] = [];
  for (let d = 0; d <= 3.0001; d += 0.1) {
    const p = turf.destination(start, d, 90, { units: 'miles' });
    coords.push(`${p.geometry.coordinates[0]},${p.geometry.coordinates[1]},0`);
  }
  coursePath = path.join(dir, 'c.kml');
  fs.writeFileSync(
    coursePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<name>c</name><LineString><coordinates>${coords.join(' ')}</coordinates></LineString>
</Placemark></Document></kml>`,
  );
});

function makeConfig(): EventConfig {
  return EventSchema.parse({
    id: 'visibility',
    name: 'Visibility Meet',
    meetId: 9200,
    trackers: [
      { imei: LEAD_A, label: 'Lead A' },
      { imei: LEAD_B, label: 'Lead B' },
    ],
    vehicles: [{ key: 'lead-car', label: 'Lead Car', trackers: [LEAD_A, LEAD_B] }],
    roles: [{ key: 'lead', label: 'Leader', vehicle: 'lead-car', cmd: 0, clockSlot: 1 }],
    races: [{ id: 'r1', name: 'Race 1', course: coursePath }],
  });
}

const newStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'visibility-db-')), 'x.db'));

/** An App whose outputs are captured rather than written. */
function makeApp(store = newStore()) {
  const app = new App(makeConfig(), store, { emit: () => {} });
  const shown: boolean[] = [];
  const distances: number[] = [];
  const spy: Publisher = {
    name: 'spy',
    roleDistance: (_meetId, _role, distance) => {
      distances.push(distance);
    },
    trackerData: () => {},
    showDistance: (_meetId, show) => {
      shown.push(show);
    },
  };
  app.publishers.length = 0;
  app.publishers.push(spy);
  return { app, shown, distances, store };
}

const startRace = (app: App) => {
  app.lifecycle('r1', 'arm');
  app.lifecycle('r1', 'start');
};

const fixAt = (app: App, imei: string, dMiles: number, t: number): Fix => {
  const p = turf.along(app.engines.get('r1')!.course.line, dMiles, { units: 'miles' });
  return {
    imei,
    lon: p.geometry.coordinates[0],
    lat: p.geometry.coordinates[1],
    tUtcMs: t,
    fixValid: true,
    buffered: false,
    source: 'test',
    protocol: 'gtfri-22',
    raw: '',
    receivedAtMs: t,
  };
};

const role = (app: App) => app.engines.get('r1')!.roles.find((r) => r.key === 'lead')!;

describe('hiding the distance', () => {
  it('shows it when a race starts, exactly as before, when nobody has hidden it', () => {
    const { app, shown } = makeApp();
    startRace(app);
    expect(shown).toEqual([true]);
  });

  it('holds it off at the start of a race when it has been hidden beforehand', () => {
    const { app, shown } = makeApp();
    app.setDistanceHidden(true, 'op');
    // nothing is running, so there is nothing to write yet - only a choice to keep
    expect(shown).toEqual([]);
    startRace(app);
    expect(shown).toEqual([false]);
  });

  it('takes it down and puts it back during a live race, straight away', () => {
    const { app, shown } = makeApp();
    startRace(app);
    app.setDistanceHidden(true, 'op');
    app.setDistanceHidden(false, 'op');
    expect(shown).toEqual([true, false, true]);
  });

  it('keeps publishing distances underneath while hidden', () => {
    const { app, distances } = makeApp();
    startRace(app);
    app.setDistanceHidden(true, 'op');
    app.onFix(fixAt(app, LEAD_A, 0.3, Date.now()));
    expect(distances).toHaveLength(1);
    expect(distances[0]).toBeCloseTo(0.3, 1);
  });

  it('writes nothing while publishing is off, and applies the choice when it comes back', () => {
    const { app, shown } = makeApp();
    startRace(app);
    app.setPublishing(false, 'op'); // the existing final showDistance-off
    app.setDistanceHidden(true, 'op'); // publishing is off: remembered, not written
    expect(shown).toEqual([true, false]);
    app.setPublishing(true, 'op');
    expect(shown).toEqual([true, false, false]);
  });

  it('survives a restart, so recovering the race does not put the distance back up', () => {
    const store = newStore();
    const before = makeApp(store);
    startRace(before.app);
    before.app.setDistanceHidden(true, 'op');

    const after = makeApp(store);
    expect(after.app.distanceHidden).toBe(true);
    expect(after.app.recoverOpenSessions()).toBe(1);
    expect(after.shown).toEqual([false]);
  });
});

describe('automatic selection, kept across what can disturb it', () => {
  it('comes back on after a restart for the roles that had it', () => {
    const store = newStore();
    makeApp(store).app.setAutoActive('r1', 'lead', true, 'op');
    expect(role(makeApp(store).app).autoActive).toBe(true);
  });

  it('stays off after a restart when a hand pick switched it off', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.setAutoActive('r1', 'lead', true, 'op');
    first.app.engines.get('r1')!.setActive('lead', LEAD_B, 'op');
    first.app.persistAutoActive(); // what the route does after a pick
    expect(role(makeApp(store).app).autoActive).toBe(false);
  });

  it('survives a setup edit saved during a live race', () => {
    const { app } = makeApp();
    startRace(app);
    app.setAutoActive('r1', 'lead', true, 'op');
    const next = makeConfig();
    next.name = 'Visibility Meet (rev 2)';
    app.applyConfig(next);
    expect(role(app).autoActive).toBe(true);
  });
});

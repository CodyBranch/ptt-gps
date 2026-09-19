import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as turf from '@turf/turf';
import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/app.js';
import { EventSchema, type EventConfig } from '../src/config/schema.js';
import type { Publisher } from '../src/outputs/publisher.js';
import { Store } from '../src/state/store.js';

/**
 * What a race's status comes back as after a restart.
 *
 * A finished race was recorded nowhere in the event file, so the server came
 * back believing a meet that had run all morning was still to start. On the
 * console that is a lie you can see; for anything driving races from outside
 * it is worse, because "scheduled" is the state a sender is waiting for and it
 * would gun the race a second time.
 */

let coursePath: string;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-'));
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

const config = (): EventConfig =>
  EventSchema.parse({
    id: 'recovery',
    name: 'Recovery Meet',
    meetId: 9300,
    trackers: [{ imei: '015181000128000', label: 'Lead A' }],
    vehicles: [{ key: 'lead-car', label: 'Lead Car', trackers: ['015181000128000'] }],
    roles: [{ key: 'lead', label: 'Leader', vehicle: 'lead-car', cmd: 0, clockSlot: 1 }],
    races: [
      { id: 'r1', name: 'Race 1', course: coursePath },
      { id: 'r2', name: 'Race 2', course: coursePath },
    ],
  });

const newStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-db-')), 'x.db'));

function makeApp(store: Store) {
  const app = new App(config(), store, { emit: () => {} });
  const shown: boolean[] = [];
  const spy: Publisher = {
    name: 'spy',
    roleDistance: () => {},
    trackerData: () => {},
    showDistance: (_meetId, show) => {
      shown.push(show);
    },
  };
  app.publishers.length = 0;
  app.publishers.push(spy);
  return { app, shown };
}

const status = (app: App, raceId: string) => app.engines.get(raceId)!.status;

describe('a race that had already finished', () => {
  it('comes back finished rather than as one still to run', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 600_000, 'op');
    first.app.lifecycle('r1', 'finish', Date.now() - 60_000, 'op');

    const after = makeApp(store);
    expect(after.app.recoverOpenSessions()).toBe(0);
    expect(status(after.app, 'r1')).toBe('finished');
  });

  it('publishes nothing and opens no session doing it', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 600_000, 'op');
    first.app.lifecycle('r1', 'finish', Date.now() - 60_000, 'op');

    const after = makeApp(store);
    after.app.recoverOpenSessions();
    expect(after.shown).toEqual([]);
    expect(after.app.sessions.size).toBe(0);
  });

  it('leaves a race that never ran alone', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 600_000, 'op');
    first.app.lifecycle('r1', 'finish', Date.now() - 60_000, 'op');

    const after = makeApp(store);
    after.app.recoverOpenSessions();
    expect(status(after.app, 'r2')).toBe('scheduled');
  });
});

describe('a race that was reset', () => {
  it('comes back scheduled, because it genuinely is', () => {
    // The false start. Its session is closed too, but it did not finish.
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 300_000, 'op');
    first.app.lifecycle('r1', 'reset', Date.now() - 290_000, 'op');

    const after = makeApp(store);
    after.app.recoverOpenSessions();
    expect(status(after.app, 'r1')).toBe('scheduled');
  });

  it('and a re-run after a reset is what counts, not the run before it', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 300_000, 'op');
    first.app.lifecycle('r1', 'reset', Date.now() - 290_000, 'op');
    first.app.lifecycle('r1', 'start', Date.now() - 280_000, 'op');
    first.app.lifecycle('r1', 'finish', Date.now() - 60_000, 'op');

    const after = makeApp(store);
    after.app.recoverOpenSessions();
    expect(status(after.app, 'r1')).toBe('finished');
  });
});

describe('a race that was still live', () => {
  it('is resumed, not marked finished', () => {
    const store = newStore();
    const first = makeApp(store);
    first.app.lifecycle('r1', 'start', Date.now() - 60_000, 'op');

    const after = makeApp(store);
    expect(after.app.recoverOpenSessions()).toBe(1);
    expect(status(after.app, 'r1')).toBe('live');
  });
});

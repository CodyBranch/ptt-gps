import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEvent } from '../src/config/manager.js';

/**
 * Building next year's meet from last year's.
 *
 * Copying is how a recurring meet is set up: the roster, the vehicles, the
 * roles and the races are a morning's work and they carry over. What must not
 * carry over is anything that says which running of the meet this is - a copy
 * that inherits last year's dates files itself under completed before anyone
 * opens it, and one that inherits an external id quietly steals the next sync
 * from the meet it was copied from.
 */

let dir: string;

const source = {
  id: 'gans-creek-2026',
  name: 'Gans Creek Classic',
  meetId: 5501,
  completedAt: '2026-09-28',
  startDate: '2026-09-25',
  endDate: '2026-09-26',
  externalId: 'nx-meet-gans',
  externalSource: 'nexus-xc',
  reportIntervalS: 7,
  listeners: [{ name: 'queclink', port: 1000 }],
  firebase: [{ connection: 'ptt-franklin', flavor: 'ptt' }],
  trackers: [{ imei: '015181000128000', label: 'Lead A' }],
  vehicles: [{ key: 'lead-car', label: 'Lead Car', trackers: ['015181000128000'] }],
  roles: [{ key: 'lead', label: 'Lead Vehicle', vehicle: 'lead-car', clockSlot: 1 }],
  snapDefaults: { minInc: 0.2, maxInc: 1 },
  races: [
    {
      id: 'hs-girls-5k',
      name: 'HS Girls 5K',
      externalId: 'nx-race-5',
      eventNumber: 5,
      scheduledStart: '07:55',
      date: '2026-09-26',
      order: 4,
      course: 'courses/gans-5k.kml',
      units: 'kilometers',
    },
  ],
};

const copy = () => {
  const file = createEvent(dir, {
    id: 'gans-creek-2027',
    name: 'Gans Creek Classic 2027',
    meetId: 6001,
    copyFromFile: 'gans-creek-2026.json',
  });
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-copy-'));
  fs.mkdirSync(path.join(dir, 'courses'));
  fs.writeFileSync(
    path.join(dir, 'courses', 'gans-5k.kml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><LineString>
<coordinates>-92.33,38.90,0 -92.32,38.91,0 -92.31,38.92,0</coordinates>
</LineString></Placemark></Document></kml>`,
  );
  fs.writeFileSync(path.join(dir, 'gans-creek-2026.json'), JSON.stringify(source, null, 2));
});

describe('what a copied event keeps', () => {
  it('carries the setup, which is the whole reason to copy one', () => {
    const made = copy();
    expect(made.trackers).toEqual(source.trackers);
    expect(made.vehicles).toEqual(source.vehicles);
    expect(made.roles).toEqual(source.roles);
    expect(made.firebase).toEqual(source.firebase);
    expect(made.listeners).toEqual(source.listeners);
    expect(made.snapDefaults).toMatchObject(source.snapDefaults);
    expect(made.reportIntervalS).toBe(7);
  });

  it('keeps the programme: races, their courses, numbers, order and time of day', () => {
    const race = copy().races[0];
    expect(race).toMatchObject({
      id: 'hs-girls-5k',
      name: 'HS Girls 5K',
      eventNumber: 5,
      order: 4,
      course: 'courses/gans-5k.kml',
      units: 'kilometers',
      // A meet that went off at 07:55 last year usually will again.
      scheduledStart: '07:55',
    });
  });

  it('takes the new name, id and meet number', () => {
    const made = copy();
    expect(made.id).toBe('gans-creek-2027');
    expect(made.name).toBe('Gans Creek Classic 2027');
    expect(made.meetId).toBe(6001);
  });
});

describe('what a copied event must not keep', () => {
  it('is not already finished', () => {
    // Inheriting completedAt filed a brand-new event under completed events
    // on the day it was made.
    expect(copy().completedAt).toBeUndefined();
  });

  it("does not inherit last year's dates", () => {
    const made = copy();
    expect(made.startDate).toBeUndefined();
    expect(made.endDate).toBeUndefined();
    // Nor on the races, whose day belongs to that meet.
    expect(made.races[0].date).toBeUndefined();
  });

  it('does not inherit the external identity of the meet it was copied from', () => {
    // The one with teeth: a meet pushed in from another system is found again
    // by externalId, so a copy carrying one steals the next sync.
    const made = copy();
    expect(made.externalId).toBeUndefined();
    expect(made.externalSource).toBeUndefined();
    expect(made.races[0].externalId).toBeUndefined();
  });
});

describe('an event built from nothing', () => {
  it('is unaffected — there is no source to strip anything from', () => {
    const file = createEvent(dir, { id: 'blank-meet', name: 'Blank Meet', meetId: 1 });
    const made = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    expect(made).toMatchObject({ id: 'blank-meet', name: 'Blank Meet', meetId: 1 });
    expect(made.races).toEqual([]);
    expect(made.trackers).toEqual([]);
  });
});

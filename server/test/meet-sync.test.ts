import { describe, expect, it } from 'vitest';
import { planMeetSync, type SyncRequest } from '../src/sync/meet.js';

/**
 * The merge rules.
 *
 * Most of these test what the sync leaves alone rather than what it writes.
 * The sending system knows about races and courses and nothing else, so the
 * damage a bad merge does is not a wrong race name - it is a roster, a set of
 * vehicles or a Firebase target quietly disappearing from a meet the morning
 * it runs.
 */

/** An event config with the hand-built half an operator would lose. */
const existing = () => ({
  id: 'fsu-invite',
  name: 'FSU Invitational',
  meetId: 4210,
  // Already synced once, so a re-send has nothing to change.
  externalId: 'nx-meet-9',
  externalSource: 'nexus-xc',
  outputUnits: 'miles',
  reportIntervalS: 10,
  listeners: [{ name: 'queclink', port: 1000 }],
  firebase: [{ connection: 'ptt-franklin', flavor: 'ptt' }],
  trackers: [{ imei: '015181000128000', label: 'Lead A' }],
  vehicles: [{ key: 'lead-car', label: 'Lead Car', trackers: ['015181000128000'] }],
  roles: [{ key: 'lead', label: 'Leader', vehicle: 'lead-car', clockSlot: 1 }],
  snapDefaults: { minInc: 0.2, maxInc: 1 },
  races: [
    {
      id: 'mens-8k',
      name: "Men's 8K",
      externalId: 'nx-race-1',
      eventNumber: 2,
      course: 'courses/apalachee-8k.kml',
      units: 'kilometers',
    },
  ],
});

const request = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  source: 'nexus-xc',
  event: { name: 'FSU Invitational', externalId: 'nx-meet-9' },
  races: [],
  ...over,
});

const plan = (req: SyncRequest, current = existing() as Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  planMeetSync({
    request: req,
    current,
    creating: false,
    courseFiles: new Map([['c-8k', 'courses/apalachee-8k.kml'], ['c-5k', 'courses/apalachee-5k.kml']]),
    ...opts,
  });

describe('what a meet sync leaves alone', () => {
  it('carries through everything the sender knows nothing about', () => {
    const before = existing();
    const out = plan(
      request({ races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-8k' }] }),
    );

    expect(out.config.trackers).toEqual(before.trackers);
    expect(out.config.vehicles).toEqual(before.vehicles);
    expect(out.config.roles).toEqual(before.roles);
    expect(out.config.firebase).toEqual(before.firebase);
    expect(out.config.listeners).toEqual(before.listeners);
    expect(out.config.snapDefaults).toEqual(before.snapDefaults);
    expect(out.config.reportIntervalS).toBe(10);
  });

  it('keeps races the sender did not mention, and says which they were', () => {
    const current = existing() as Record<string, unknown>;
    (current.races as unknown[]).push({ id: 'womens-5k', name: "Women's 5K", course: 'courses/apalachee-5k.kml' });

    const out = plan(request({ races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-8k' }] }), current);

    expect((out.config.races as Array<{ id: string }>).map((r) => r.id)).toEqual(['mens-8k', 'womens-5k']);
    expect(out.untouched).toEqual([{ id: 'womens-5k', name: "Women's 5K" }]);
  });

  it('never overwrites a meet number with the zero that means "not known"', () => {
    const out = plan(request({ event: { name: 'FSU Invitational', meetId: 0 } }));
    expect(out.config.meetId).toBe(4210);
  });

  it('warns when there is no meet number at all, because Firebase would publish under 0', () => {
    const current = { ...existing(), meetId: 0 } as Record<string, unknown>;
    const out = plan(request(), current);
    expect(out.warnings.join(' ')).toMatch(/no meet number/i);
  });
});

describe('matching a race that is already here', () => {
  it('matches on the stable id even when the name and number both changed', () => {
    const out = plan(
      request({
        races: [{ externalId: 'nx-race-1', name: "Men's 8K Varsity", eventNumber: 7, courseKey: 'c-8k' }],
      }),
    );

    expect(out.races).toHaveLength(1);
    expect(out.races[0]).toMatchObject({ id: 'mens-8k', action: 'updated' });
    expect(out.config.races).toHaveLength(1);
    expect((out.config.races as Array<{ name: string }>)[0].name).toBe("Men's 8K Varsity");
  });

  it('falls back to the programme number, then to the name', () => {
    const byNumber = plan(request({ races: [{ name: 'Renamed', eventNumber: 2, courseKey: 'c-8k' }] }));
    expect(byNumber.races[0].id).toBe('mens-8k');

    const byName = plan(request({ races: [{ name: "  men's 8k  ", courseKey: 'c-8k' }] }));
    expect(byName.races[0].id).toBe('mens-8k');
  });

  it('never matches two sent races onto the same existing one', () => {
    const out = plan(
      request({
        races: [
          { name: "Men's 8K", courseKey: 'c-8k' },
          { name: "Men's 8K", courseKey: 'c-8k' },
        ],
      }),
    );
    const ids = out.races.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(out.config.races).toHaveLength(2);
  });

  it('reports a race that is already correct as unchanged', () => {
    const out = plan(
      request({
        races: [{ externalId: 'nx-race-1', name: "Men's 8K", eventNumber: 2, units: 'kilometers', courseKey: 'c-8k' }],
      }),
    );
    expect(out.races[0].action).toBe('unchanged');
    expect(out.eventAction).toBe('unchanged');
  });
});

describe('races that are running', () => {
  it('leaves the course alone and says why', () => {
    const out = plan(
      request({ races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-5k' }] }),
      existing() as Record<string, unknown>,
      { runningRaceIds: new Set(['mens-8k']) },
    );

    expect((out.config.races as Array<{ course: string }>)[0].course).toBe('courses/apalachee-8k.kml');
    expect(out.races[0].reason).toMatch(/running/);
  });

  it('leaves the units alone, and does not change the meet output units either', () => {
    const out = plan(
      request({
        event: { name: 'FSU Invitational', outputUnits: 'kilometers' },
        races: [{ externalId: 'nx-race-1', name: "Men's 8K", units: 'miles', courseKey: 'c-8k' }],
      }),
      existing() as Record<string, unknown>,
      { runningRaceIds: new Set(['mens-8k']) },
    );

    expect((out.config.races as Array<{ units: string }>)[0].units).toBe('kilometers');
    expect(out.config.outputUnits).toBe('miles');
    expect(out.warnings.join(' ')).toMatch(/while a race is running/);
  });
});

describe('races that cannot be built yet', () => {
  it('skips a new race with no course rather than writing one the engine refuses', () => {
    const out = plan(request({ races: [{ name: 'Open 3K', courseKey: null }] }));
    expect(out.races[0]).toMatchObject({ action: 'skipped' });
    expect(out.races[0].reason).toMatch(/no course/i);
    expect(out.config.races).toHaveLength(1); // nothing added
  });

  it('skips when the course key is not among the courses sent', () => {
    const out = plan(request({ races: [{ name: 'Open 3K', courseKey: 'c-never-sent' }] }));
    expect(out.races[0].action).toBe('skipped');
  });
});

describe('new races', () => {
  it('creates them with an id from the name, and keeps ids unique', () => {
    const out = plan(
      request({
        races: [
          { externalId: 'nx-2', name: "Women's 5K", courseKey: 'c-5k', eventNumber: 3, scheduledStart: '09:30', order: 1 },
          { externalId: 'nx-3', name: "Women's 5K", courseKey: 'c-5k', eventNumber: 4 },
        ],
      }),
    );

    expect(out.races.map((r) => r.id)).toEqual(['womens-5k', 'womens-5k-2']);
    const created = (out.config.races as Array<Record<string, unknown>>)[1];
    expect(created).toMatchObject({
      id: 'womens-5k',
      name: "Women's 5K",
      externalId: 'nx-2',
      eventNumber: 3,
      scheduledStart: '09:30',
      order: 1,
      course: 'courses/apalachee-5k.kml',
    });
  });

  it('builds a whole meet from nothing when the event is being created', () => {
    const fresh = { id: 'new-meet', name: 'New Meet', meetId: 0, trackers: [], roles: [], races: [] };
    const out = planMeetSync({
      request: request({ races: [{ name: "Men's 8K", courseKey: 'c-8k' }] }),
      current: fresh,
      creating: true,
      courseFiles: new Map([['c-8k', 'courses/apalachee-8k.kml']]),
    });

    expect(out.eventAction).toBe('created');
    expect(out.races[0].action).toBe('created');
    expect(out.config.trackers).toEqual([]);
  });
});

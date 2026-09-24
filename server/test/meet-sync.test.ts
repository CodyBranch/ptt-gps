import { describe, expect, it } from 'vitest';
import { planMeetSync, type SyncRequest } from '../src/sync/meet.js';
import { countPaths } from '../src/engine/course.js';

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

describe('a field the sender has taken away', () => {
  /**
   * Absent and null are different statements. A sender that does not set
   * programme numbers at all must not wipe the ones an operator typed; a
   * sender that has removed a race's start time must be able to say so, or
   * the schedule here keeps a time the meet no longer has.
   */
  it('clears a start time and a day sent explicitly as null', () => {
    const current = existing() as Record<string, unknown>;
    (current.races as Array<Record<string, unknown>>)[0].scheduledStart = '18:30';
    (current.races as Array<Record<string, unknown>>)[0].date = '2026-09-25';

    const out = plan(
      request({
        races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-8k', scheduledStart: null, date: null }],
      }),
      current,
    );

    const race = (out.config.races as Array<Record<string, unknown>>)[0];
    expect(race.scheduledStart).toBeUndefined();
    expect(race.date).toBeUndefined();
    expect(out.races[0].action).toBe('updated');
  });

  it('leaves them alone when the keys are simply absent', () => {
    const current = existing() as Record<string, unknown>;
    (current.races as Array<Record<string, unknown>>)[0].scheduledStart = '18:30';

    const out = plan(request({ races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-8k' }] }), current);

    expect((out.config.races as Array<Record<string, unknown>>)[0].scheduledStart).toBe('18:30');
    expect((out.config.races as Array<Record<string, unknown>>)[0].eventNumber).toBe(2);
  });

  it('never clears the id that finds the race again', () => {
    const out = plan(
      request({ races: [{ externalId: null, name: "Men's 8K", courseKey: 'c-8k', eventNumber: 2 }] }),
    );
    expect((out.config.races as Array<Record<string, unknown>>)[0].externalId).toBe('nx-race-1');
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

describe('races whose line has not been traced yet', () => {
  /**
   * The schedule is settled weeks out and the course is walked days before, so
   * a meet that could only be sent once every course had a GPX could not be
   * sent at all. The race lands without one and is linked to a course here.
   */
  it('takes a new race with no course, and says it needs one', () => {
    const out = plan(request({ races: [{ name: 'Open 3K', courseKey: null }] }));
    expect(out.races[0].action).toBe('created');
    expect(out.races[0].reason).toMatch(/no course yet/i);
    expect(out.config.races).toHaveLength(2);
  });

  it('writes the empty course as a value, not as a missing key', () => {
    const out = plan(request({ races: [{ name: 'Open 3K', courseKey: null }] }));
    const added = out.config.races.find((r) => r.name === 'Open 3K')!;
    expect(added.course).toBe('');
  });

  it('keeps the number and the time, which are the part that is known', () => {
    const out = plan(request({
      races: [{ name: 'Open 3K', courseKey: null, eventNumber: 4, scheduledStart: '09:30', order: 4 }],
    }));
    expect(out.config.races.find((r) => r.name === 'Open 3K')).toMatchObject({
      eventNumber: 4, scheduledStart: '09:30', order: 4,
    });
  });

  it('takes the race when the course key was not among the courses sent, and says so', () => {
    const out = plan(request({ races: [{ name: 'Open 3K', courseKey: 'c-never-sent' }] }));
    expect(out.races[0].action).toBe('created');
    expect(out.races[0].reason).toMatch(/was not in the request/);
  });

  it('a course linked later is kept when the meet is sent again without one', () => {
    const first = plan(request({ races: [{ name: 'Open 3K', courseKey: null }] }));
    // Somebody links it in Event Setup.
    first.config.races.find((r) => r.name === 'Open 3K')!.course = 'courses/gans-3k.kml';
    const again = plan(request({ races: [{ name: 'Open 3K', courseKey: null }] }), first.config);
    expect(again.config.races.find((r) => r.name === 'Open 3K')!.course).toBe('courses/gans-3k.kml');
    expect(again.races[0].reason).toBeUndefined();
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

  it('carries the day each race runs, for a meet that spans two of them', () => {
    const out = plan(
      request({
        races: [
          { externalId: 'nx-e1', name: 'Elite Women 6K', courseKey: 'c-5k', scheduledStart: '18:30', date: '2026-09-25', order: 0 },
          { externalId: 'nx-1', name: 'Open Men 8K', courseKey: 'c-8k', scheduledStart: '07:55', date: '2026-09-26', order: 4 },
        ],
      }),
    );

    const races = out.config.races as Array<Record<string, unknown>>;
    // The Friday twilight race is first despite the later clock time: the
    // running order says so, and the date is what explains it to a reader.
    expect(races.map((r) => [r.date, r.scheduledStart, r.order])).toEqual([
      // The race already here, which the sender did not mention, is untouched.
      [undefined, undefined, undefined],
      ['2026-09-25', '18:30', 0],
      ['2026-09-26', '07:55', 4],
    ]);
  });

  it('changes the day of a race that is running, since no engine has read it', () => {
    const out = plan(
      request({ races: [{ externalId: 'nx-race-1', name: "Men's 8K", courseKey: 'c-8k', date: '2026-09-26' }] }),
      existing() as Record<string, unknown>,
      { runningRaceIds: new Set(['mens-8k']) },
    );
    expect((out.config.races as Array<{ date: string }>)[0].date).toBe('2026-09-26');
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

describe('a course exported in pieces', () => {
  /**
   * Only the first path is ever used. A person uploading a course at the
   * console sees the length and notices it is short; a machine sending one
   * cannot, so the sync counts them and warns. This pins the counting.
   */
  const kml = (...parts: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${parts
    .map((c) => `<Placemark><LineString><coordinates>${c}</coordinates></LineString></Placemark>`)
    .join('')}</Document></kml>`;

  const A = '-84.30,30.44,0 -84.299,30.4405,0 -84.298,30.441,0';
  const B = '-84.29,30.45,0 -84.289,30.4505,0';

  it('counts one path in a course exported whole', () => {
    expect(countPaths(kml(A), true)).toBe(1);
  });

  it('counts the pieces of one exported in parts', () => {
    expect(countPaths(kml(A, B), true)).toBe(2);
    expect(countPaths(kml(A, B, B, A), true)).toBe(4);
  });

  it('counts a GeoJSON MultiLineString by its parts', () => {
    const gj = JSON.stringify({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[-84.3, 30.44], [-84.299, 30.4405]],
          [[-84.29, 30.45], [-84.289, 30.4505]],
        ],
      },
    });
    expect(countPaths(gj, false)).toBe(2);
  });

  it('says nothing rather than throwing on a file it cannot read', () => {
    expect(countPaths('not xml at all', true)).toBe(0);
    expect(countPaths('{', false)).toBe(0);
  });
});

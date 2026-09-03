import { describe, expect, it } from 'vitest';
import { eventSummary, feedMessages, PROTOCOL } from '../src/api/feed.js';

/**
 * The feed is a published contract, so these tests are as much about pinning
 * the shape as about the arithmetic. A consumer's software breaks quietly if a
 * field is renamed or a unit changes meaning.
 */

const NOW = 1_800_000_000_000;

const snapshot = (over: Record<string, unknown> = {}) => ({
  events: [
    {
      event: { id: 'boston-2026', name: 'Boston 2026', meetId: 42, reportIntervalS: 10 },
      races: [
        {
          raceId: 'r1',
          name: 'Marathon',
          status: 'live',
          units: 'miles',
          courseLength: 26.2,
          sessionId: 4,
          roles: [
            { key: 'lead', label: 'Lead Vehicle', vehicle: 'moto-1', activeImei: '111', source: 'gps' },
            { key: 'trail', label: 'Trail Vehicle', vehicle: null, activeImei: null, source: 'gps' },
          ],
          trackers: [
            {
              imei: '111',
              distance: 5.5,
              offCourse: false,
              suspect: false,
              gpsQuality: 'good' as const,
              lastFix: { lat: 42.3, lon: -71.1, tUtcMs: NOW - 6_000, receivedAtMs: NOW - 5_000, speedKmh: 20 },
            },
          ],
        },
      ],
      ...over,
    },
  ],
});

describe('the external live feed payload', () => {
  it('carries the protocol version, so a consumer can refuse a shape it does not know', () => {
    const [msg] = feedMessages(snapshot(), NOW);
    expect(msg.protocol).toBe(PROTOCOL);
    expect(msg.event).toEqual({ id: 'boston-2026', name: 'Boston 2026', meetId: 42 });
    expect(msg.race.id).toBe('r1');
    expect(msg.race.sessionId).toBe(4);
  });

  it('reports distance in the race units and in metres', () => {
    const [msg] = feedMessages(snapshot(), NOW);
    const lead = msg.race.roles.find((r) => r.key === 'lead')!;
    expect(lead.distance).toBe(5.5);
    // 5.5 miles is 8851.4m; the conversion is the part a consumer cannot check.
    expect(lead.distanceMeters).toBeCloseTo(8851.4, 0);
    expect(msg.race.courseLengthMeters).toBeCloseTo(42164.8, 0);
  });

  it('converts kilometre races too', () => {
    const snap = snapshot();
    snap.events[0].races[0].units = 'kilometers';
    snap.events[0].races[0].courseLength = 10;
    snap.events[0].races[0].trackers[0].distance = 2.5;
    const [msg] = feedMessages(snap, NOW);
    expect(msg.race.courseLengthMeters).toBe(10_000);
    expect(msg.race.roles[0].distanceMeters).toBe(2500);
  });

  it('gives every position an age, because a frozen distance still looks like an answer', () => {
    const [msg] = feedMessages(snapshot(), NOW);
    const lead = msg.race.roles.find((r) => r.key === 'lead')!;
    expect(lead.position?.ageS).toBe(5);
    expect(lead.position?.stale).toBe(false);
    expect(lead.position?.lat).toBe(42.3);
    expect(lead.position?.speedKmh).toBe(20);
    expect(lead.position?.speedMph).toBe(12.43);
    expect(lead.position?.fixMs).toBe(NOW - 6_000);
  });

  it('marks a position stale past three reporting intervals', () => {
    const snap = snapshot();
    // 10s interval, so anything beyond 30s is suspect.
    snap.events[0].races[0].trackers[0].lastFix.receivedAtMs = NOW - 31_000;
    const [msg] = feedMessages(snap, NOW);
    expect(msg.race.roles[0].position?.stale).toBe(true);
    expect(msg.race.roles[0].position?.ageS).toBe(31);

    snap.events[0].races[0].trackers[0].lastFix.receivedAtMs = NOW - 29_000;
    expect(feedMessages(snap, NOW)[0].race.roles[0].position?.stale).toBe(false);
  });

  it('ages a position from when the server received it, not the device clock', () => {
    // A tracker with a wrong clock would otherwise look hours old, or worse,
    // permanently fresh.
    const snap = snapshot();
    snap.events[0].races[0].trackers[0].lastFix.tUtcMs = NOW - 9_000_000;
    snap.events[0].races[0].trackers[0].lastFix.receivedAtMs = NOW - 4_000;
    const pos = feedMessages(snap, NOW)[0].race.roles[0].position!;
    expect(pos.ageS).toBe(4);
    expect(pos.stale).toBe(false);
    expect(pos.fixMs).toBe(NOW - 9_000_000);
    expect(pos.receivedMs).toBe(NOW - 4_000);
  });

  it('scales staleness to the event, not to a fixed number of seconds', () => {
    const snap = snapshot();
    snap.events[0].event.reportIntervalS = 60;
    snap.events[0].races[0].trackers[0].lastFix.receivedAtMs = NOW - 100_000;
    // 100s is stale at a 10s interval but fine at 60s.
    expect(feedMessages(snap, NOW)[0].race.roles[0].position?.stale).toBe(false);
  });

  it('reports an uncovered role as null rather than omitting it', () => {
    const [msg] = feedMessages(snapshot(), NOW);
    const trail = msg.race.roles.find((r) => r.key === 'trail')!;
    expect(trail.imei).toBeNull();
    expect(trail.vehicle).toBeNull();
    expect(trail.distance).toBeNull();
    expect(trail.distanceMeters).toBeNull();
    expect(trail.position).toBeNull();
  });

  it('takes a splits-fed role from the splits, not from a tracker', () => {
    const snap: Record<string, unknown> = snapshot();
    (snap as any).events[0].races[0].roles[0].source = 'splits';
    (snap as any).simulated = { lead: { distance: 9.1 } };
    const [msg] = feedMessages(snap as never, NOW);
    expect(msg.race.roles[0].source).toBe('splits');
    expect(msg.race.roles[0].distance).toBe(9.1);
  });

  it('handles an event with no races, and a race with no trackers', () => {
    const empty = { events: [{ event: { id: 'e', name: 'E', meetId: 0 }, races: [] }] };
    expect(feedMessages(empty, NOW)).toEqual([]);
    expect(feedMessages({ events: [] }, NOW)).toEqual([]);
  });

  it('rounds, so the wire does not imply precision the GPS cannot support', () => {
    const snap = snapshot();
    snap.events[0].races[0].trackers[0].distance = 1.2590385119960725;
    const role = feedMessages(snap, NOW)[0].race.roles[0];
    expect(role.distance).toBe(1.259);
    expect(role.distanceMeters).toBe(2026.2);
    // 15 decimal places of a mile is nanometres; 4 is about 16cm.
    expect(String(role.distance).split('.')[1]!.length).toBeLessThanOrEqual(4);
    expect(role.position!.speedMph).toBe(12.43);
  });

  it('emits one message per race', () => {
    const snap = snapshot();
    snap.events[0].races.push({ ...snap.events[0].races[0], raceId: 'r2', name: 'Half' });
    const msgs = feedMessages(snap, NOW);
    expect(msgs.map((m) => m.race.id)).toEqual(['r1', 'r2']);
  });
});

describe('the meet list a consumer maps against', () => {
  it('carries what is needed to line a meet up with a consumer record', () => {
    const snap = snapshot();
    (snap as any).events[0].event.startDate = '2026-04-20';
    (snap as any).events[0].event.endDate = '2026-04-20';

    const summary = eventSummary('boston-2026', snap.events[0] as never);
    expect(summary).toEqual({
      id: 'boston-2026',
      name: 'Boston 2026',
      meetId: 42,
      startDate: '2026-04-20',
      endDate: '2026-04-20',
      races: [
        {
          id: 'r1',
          name: 'Marathon',
          status: 'live',
          units: 'miles',
          courseLength: 26.2,
          courseLengthMeters: 42164.8,
          sessionId: 4,
        },
      ],
    });
  });

  it('reports absent dates as null rather than leaving the field out', () => {
    const summary = eventSummary('e', snapshot().events[0] as never);
    expect(summary.startDate).toBeNull();
    expect(summary.endDate).toBeNull();
  });
});

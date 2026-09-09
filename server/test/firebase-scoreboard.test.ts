import { describe, expect, it } from 'vitest';
import { FirebasePublisher } from '../src/outputs/firebase.js';
import type { FirebaseHub } from '../src/outputs/hub.js';
import type { RoleState, TrackerState } from '../src/engine/race-engine.js';

/**
 * What actually reaches Firebase.
 *
 * The scoreboard and the clock read the same distance from two different
 * paths, and only one of them displays it verbatim. These tests exist to keep
 * that distinction: adding a unit to the scoreboard must not add one to the
 * value the clock parses.
 */

/** A database that records writes instead of making them. */
function stubHub(): { hub: FirebaseHub; writes: Array<{ path: string; value: Record<string, unknown> }> } {
  const writes: Array<{ path: string; value: Record<string, unknown> }> = [];
  const db = {
    ref: () => ({
      child: (path: string) => ({
        update: (value: Record<string, unknown>) => {
          writes.push({ path, value });
          return Promise.resolve();
        },
      }),
    }),
  };
  return { hub: { database: () => db } as unknown as FirebaseHub, writes };
}

const role = { key: 'lead', label: 'Lead', clockSlot: 1 } as unknown as RoleState;
const state = { imei: '1', label: 'Lead' } as unknown as TrackerState;

const publish = (units: 'miles' | 'kilometers', distance: number) => {
  const { hub, writes } = stubHub();
  const p = new FirebasePublisher(
    { connection: 'x', flavor: 'ptt' },
    hub,
    () => {},
    units,
  );
  p.roleDistance(9999, role, distance, state);
  return writes;
};

describe('what the scoreboard is sent', () => {
  it('carries the unit, in miles', () => {
    const scoreboard = publish('miles', 1.24).find((w) => w.path.includes('PTT-Scoreboard'));
    expect(scoreboard?.value).toEqual({ Distance: '1.2 mi' });
  });

  it('carries the unit, in kilometres', () => {
    const scoreboard = publish('kilometers', 1.24).find((w) => w.path.includes('PTT-Scoreboard'));
    expect(scoreboard?.value).toEqual({ Distance: '1.2k' });
  });

  it('leaves the clock a bare number to parse', () => {
    // Meta/Clock is consumed, not displayed. A unit suffix here would be a
    // string where a number is expected, which is how a scoreboard change
    // quietly breaks a clock.
    for (const units of ['miles', 'kilometers'] as const) {
      const clock = publish(units, 1.24).find((w) => w.path.includes('Meta/Clock'));
      expect(clock?.value).toEqual({ distanceComplete: '1.2' });
    }
  });

  it('writes both paths for a slotted role', () => {
    const paths = publish('miles', 3).map((w) => w.path);
    expect(paths).toEqual(['9999/Meta/Clock', '9999/PTT-Scoreboard/1']);
  });
});

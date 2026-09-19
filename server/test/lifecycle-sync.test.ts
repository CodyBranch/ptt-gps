import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, planLifecycle } from '../src/sync/lifecycle.js';

/**
 * Whether a start or finish pushed in from the timing system may be applied.
 *
 * The case that matters most is the repeated start. A sender retries after a
 * dropped connection, and app.lifecycle('start') opens a session every time it
 * is called - so the second one would strand the first session open and take
 * the race's recorded distances with it.
 */

const NOW = Date.UTC(2026, 9, 3, 15, 30, 0);
const gun = NOW - 90_000;

describe('starting a race from outside', () => {
  it('starts one that is scheduled or armed', () => {
    expect(planLifecycle('start', 'scheduled', gun, NOW)).toMatchObject({ apply: true });
    expect(planLifecycle('start', 'armed', gun, NOW)).toMatchObject({ apply: true });
  });

  it('does nothing at all to a race that is already live', () => {
    // The retry. Not an error, and above all not a second session.
    expect(planLifecycle('start', 'live', gun, NOW)).toEqual({ apply: false, unchanged: true });
  });

  it('refuses to restart a finished race, and says who can', () => {
    const out = planLifecycle('start', 'finished', gun, NOW);
    expect(out.apply).toBe(false);
    expect(out.status).toBe(409);
    expect(out.error).toMatch(/console/);
  });
});

describe('finishing a race from outside', () => {
  it('finishes one that is live', () => {
    expect(planLifecycle('finish', 'live', gun, NOW)).toMatchObject({ apply: true });
  });

  it('treats a repeated finish as already done', () => {
    expect(planLifecycle('finish', 'finished', gun, NOW)).toEqual({ apply: false, unchanged: true });
  });

  it('refuses to finish a race that never started', () => {
    for (const status of ['scheduled', 'armed'] as const) {
      const out = planLifecycle('finish', status, gun, NOW);
      expect(out.apply).toBe(false);
      expect(out.status).toBe(409);
      expect(out.error).toMatch(/not started/);
    }
  });
});

describe('the pushed timestamp', () => {
  it('insists on a number, because every elapsed time is measured from it', () => {
    for (const bad of [undefined, null, 'now', NaN, '1788419071380']) {
      expect(planLifecycle('start', 'armed', bad, NOW)).toMatchObject({ apply: false, status: 400 });
    }
  });

  it('accepts a gun time that arrived late, because it is still the right time', () => {
    expect(planLifecycle('start', 'armed', NOW - 3 * 3600_000, NOW)).toMatchObject({ apply: true });
  });

  it('refuses one from another day', () => {
    const out = planLifecycle('start', 'armed', NOW - MAX_AGE_MS - 1000, NOW);
    expect(out.status).toBe(400);
    expect(out.error).toMatch(/another day/);
  });

  it('allows a little clock skew but not a time in the future', () => {
    expect(planLifecycle('start', 'armed', NOW + 60_000, NOW)).toMatchObject({ apply: true });
    expect(planLifecycle('start', 'armed', NOW + 3600_000, NOW)).toMatchObject({
      apply: false,
      status: 400,
    });
  });

  it('checks the clock before the state, so a bad timestamp never reads as "already done"', () => {
    expect(planLifecycle('start', 'live', 'nope', NOW)).toMatchObject({ apply: false, status: 400 });
  });
});

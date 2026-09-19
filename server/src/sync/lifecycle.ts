import type { RaceStatus } from '../engine/race-engine.js';

/**
 * Deciding whether a start or a finish pushed in from another system may be
 * applied to a race here.
 *
 * The sending system has a timing console of its own and is driving ours from
 * it: a gun time becomes a start, the first finisher becomes a finish. Two
 * things make that worth a decision function rather than a straight call
 * through to app.lifecycle().
 *
 * The first is that a repeated start is not harmless. `lifecycle('start')`
 * opens a session unconditionally and overwrites the race's entry in the
 * sessions map, so a retried gun time - which is exactly what a sender does
 * after a dropped connection - would strand the first session open forever and
 * lose the distances already recorded against it. A start on a race that is
 * already live has to be a no-op.
 *
 * The second is the clock. The gun time is the sender's, not ours, and it is
 * the number every elapsed time is measured from; a delivery that arrives late
 * must still stamp the race at the gun. That means trusting a timestamp from
 * off the machine, so it is worth checking it is plausible before an entire
 * race is hung off it.
 *
 * Pure, so the rules can be read and tested without an engine.
 */

export type LifecycleAction = 'start' | 'finish';

export interface LifecycleDecision {
  /** Call app.lifecycle() with this action. */
  apply: boolean;
  /** Already in the state that was asked for. Reported as ok, not as an error. */
  unchanged: boolean;
  /** Set when it cannot be applied: the sentence the sender shows its operator. */
  error?: string;
  /** HTTP status for `error`. 409 for a state clash, 400 for a bad request. */
  status?: 409 | 400;
}

const ok = (apply: boolean, unchanged = false): LifecycleDecision => ({ apply, unchanged });
const no = (error: string, status: 409 | 400 = 409): LifecycleDecision => ({
  apply: false,
  unchanged: false,
  error,
  status,
});

/**
 * How late a pushed timestamp may be, and how far ahead.
 *
 * Generous in the past because a sender that lost its connection at the gun
 * may not reach us for a long time, and the gun time is still right when it
 * does. Tight in the future because nothing legitimate is ahead of our clock
 * by more than the two machines disagree.
 */
export const MAX_AGE_MS = 12 * 3600_000;
export const MAX_AHEAD_MS = 5 * 60_000;

export function planLifecycle(
  action: LifecycleAction,
  status: RaceStatus,
  atMs: unknown,
  nowMs: number,
): LifecycleDecision {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) {
    return no('atMs must be the epoch-millisecond time of the gun, as a number', 400);
  }
  if (atMs > nowMs + MAX_AHEAD_MS) {
    return no('atMs is in the future - check the sending machine\'s clock', 400);
  }
  if (atMs < nowMs - MAX_AGE_MS) {
    // Someone opening an old meet and replaying it at us. A race hung off a
    // timestamp from days ago reads as an elapsed time of days.
    return no('atMs is more than 12 hours ago - this looks like a meet from another day', 400);
  }

  if (action === 'start') {
    switch (status) {
      case 'scheduled':
      case 'armed':
        return ok(true);
      case 'live':
        // The retry case. Never a second session.
        return ok(false, true);
      case 'finished':
        return no('this race has already finished here - reopen it from the console to run it again');
    }
  }

  switch (status) {
    case 'live':
      return ok(true);
    case 'finished':
      return ok(false, true);
    default:
      return no('this race has not started here, so there is nothing to finish');
  }
}

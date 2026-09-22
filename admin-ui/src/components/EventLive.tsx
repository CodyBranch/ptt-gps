import { Fragment } from 'react';
import { toDisplay, unitAbbr } from '../api';
import type { EventSnap, Units } from '../types';
import { raceLabel } from '../format';

/**
 * The live view of an active event — publishing state and a row per race with
 * its status, length and how many of its trackers are currently reporting.
 * Shared by Home and the Events library so the two can't drift apart.
 */

/** A tracker counts as reporting if a frame landed within 3 report intervals. */
export const staleAfter = (ev: EventSnap): number => Math.max(30_000, (ev.event.reportIntervalS || 10) * 3000);

export function isReporting(imei: string, ev: EventSnap, lastSeen: Record<string, number>, now: number): boolean {
  const t = lastSeen[imei];
  return t !== undefined && now - t < staleAfter(ev);
}

/** Unique IMEIs across an event's races (a device can run in several). */
export function eventImeis(ev: EventSnap): string[] {
  return [...new Set(ev.races.flatMap((r) => r.trackers.map((t) => t.imei)))];
}

export function reportingCount(
  imeis: string[],
  ev: EventSnap,
  lastSeen: Record<string, number>,
  now: number,
): number {
  return imeis.filter((i) => isReporting(i, ev, lastSeen, now)).length;
}

export function PublishBadge({ on }: { on: boolean }) {
  return <span className={`ev-pub ${on ? 'on' : 'off'}`}>{on ? 'PUBLISHING' : '⛔ OUTPUTS OFF'}</span>;
}

/** "7/7 trackers reporting", green while everything is heard from. */
export function ReportingCount({
  ev,
  lastSeen,
  now,
}: {
  ev: EventSnap;
  lastSeen: Record<string, number>;
  now: number;
}) {
  const imeis = eventImeis(ev);
  const on = reportingCount(imeis, ev, lastSeen, now);
  return (
    <span className={on < imeis.length ? 'warn-text' : 'ok-text'}>
      {on}/{imeis.length} trackers reporting
    </span>
  );
}

export function RaceRows({
  ev,
  lastSeen,
  now,
  displayUnits,
  onOpenRace,
}: {
  ev: EventSnap;
  lastSeen: Record<string, number>;
  now: number;
  /** The console's mi/km choice — a race measured in miles still reads in km
   *  when that is what the operator asked to see. */
  displayUnits: Units;
  onOpenRace: (raceId: string) => void;
}) {
  if (ev.races.length === 0) return <p className="hint">No races configured yet.</p>;

  /**
   * A two-day meet is broken up by day; a one-day meet is not.
   *
   * Races are already in running order, and the order runs across the whole
   * meet rather than restarting each morning - so the days come out as runs of
   * consecutive races and a heading goes wherever the date changes. Without
   * this a Friday twilight race at 18:30 sits above a Saturday race at 07:55
   * with nothing to explain it.
   */
  const days = new Set(ev.races.map((r) => r.date).filter(Boolean));
  const showDays = days.size > 1;
  let lastDay: string | null | undefined;

  return (
    <>
      {ev.races.map((race) => {
        const imeis = race.trackers.map((t) => t.imei);
        const on = imeis.filter((i) => isReporting(i, ev, lastSeen, now)).length;
        const heading = showDays && race.date !== lastDay;
        if (heading) lastDay = race.date;
        return (
          <Fragment key={race.raceId}>
          {heading && <div className="ev-race-day">{race.date ? dayLabel(race.date) : 'Day not set'}</div>}
          <button className="ev-race" onClick={() => onOpenRace(race.raceId)}>
            <span className={`status-dot ${race.status}`} />
            <span className="ev-race-name">{raceLabel(race)}</span>
            {/* A scheduled start is the next thing anyone asks after the name. */}
            {race.scheduledStart && <span className="ev-race-time dim">{race.scheduledStart}</span>}
            <span className={`ev-race-status ${race.status}`}>{race.status.toUpperCase()}</span>
            <span className="ev-race-len dim">
              {toDisplay(race.courseLength, race.units, displayUnits).toFixed(1)} {unitAbbr(displayUnits)}
            </span>
            <span className={`ev-report ${on < imeis.length ? 'warn-text' : 'ok-text'}`}>
              {on}/{imeis.length}
            </span>
          </button>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * "Friday, Sep 25" from "2026-09-25".
 *
 * Built field by field rather than handed to Date, which reads a bare date as
 * UTC midnight - west of Greenwich that renders as the day before, which is
 * precisely the mistake this label exists to prevent.
 */
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

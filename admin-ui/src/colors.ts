import type { RaceSnap } from './types';

/**
 * One colour per physical tracker, shared by the map dots and the panels.
 *
 * The colour is the link between "which dot is that on the map" and "which row
 * is it in the list" — so it has to be assigned in one place and handed to
 * everything that draws a tracker, not recomputed per component.
 */
export const MARKER_COLORS = [
  '#e8484d',
  '#2f7ded',
  '#1fa860',
  '#c85fd4',
  '#e8842f',
  '#12a5a5',
  '#96981f',
  '#777',
];

/**
 * Assign colours in race order, deduped by IMEI — one device carries one
 * colour even when it is running in several races at once.
 */
export function trackerColors(races: RaceSnap[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  for (const race of races) {
    for (const t of race.trackers) {
      if (out[t.imei] === undefined) out[t.imei] = MARKER_COLORS[i++ % MARKER_COLORS.length];
    }
  }
  return out;
}

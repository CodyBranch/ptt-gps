import * as turf from '@turf/turf';
import type { Course } from './course.js';
import type { SnapConfig } from '../config/schema.js';

/**
 * Windowed course-snapping, ported from the legacy admin pages where it ran
 * per-tracker in the browser:
 *
 *   slice the course to [min, max] → nearestPointOnLine(slice, fix)
 *   → distance = slice-local location + min → advance window around it
 *
 * The moving window is what makes snapping unambiguous on courses that loop or
 * overlap themselves (out-and-backs, multi-lap): the tracker can only snap to
 * the part of the course it is plausibly on.
 *
 * Window modes:
 *  - auto:    advances with each snap (dist − minInc .. dist + maxInc)
 *  - clamped: operator-latched to a zone; the window may move within the zone
 *             but never expand past it, until released
 */

export interface SnapWindow {
  min: number;
  max: number;
  mode: 'auto' | 'clamped';
  clamp?: { start: number; end: number };
}

export interface SnapResult {
  /** Distance along the course, in course units. */
  distance: number;
  /** Perpendicular distance from the course line, course units. */
  offCourse: number;
  /** The snapped point on the course. */
  pathLat: number;
  pathLon: number;
  /** The advanced window to use for the next fix. */
  window: SnapWindow;
  /** offCourse exceeded maxOffCourse — distance is suspect (GPS glitch or off-route). */
  suspect: boolean;
}

export function initialWindow(snap: SnapConfig, courseLength: number): SnapWindow {
  return { min: 0, max: Math.min(snap.initialMax, courseLength), mode: 'auto' };
}

export function snapFix(
  course: Course,
  window: SnapWindow,
  lon: number,
  lat: number,
  snap: SnapConfig,
  /** Last snapped distance for this tracker, if any — enables forward bias. */
  lastDistance?: number,
): SnapResult {
  const units = course.units;
  let min = Number.isFinite(window.min) ? Math.max(0, Math.min(window.min, course.length)) : 0;
  let max = Number.isFinite(window.max) ? Math.max(0, Math.min(window.max, course.length)) : course.length;
  if (max - min < 1e-6) {
    // Degenerate window (e.g. clamped at course end) — widen minimally backwards.
    min = Math.max(0, max - Math.max(snap.minInc, 0.01));
  }

  const pt = turf.point([lon, lat]);
  const sliced = turf.lineSliceAlong(course.line, min, max, { units });
  const snapped = turf.nearestPointOnLine(sliced, pt, { units });

  let location = snapped.properties.location ?? 0;
  let distance = location + min;
  let offCourse = snapped.properties.dist ?? 0;
  let bestSnapped = snapped;

  // Forward bias: on overlapping legs (out-and-backs, laps) the outbound and
  // return passes are equally near, and a plain nearest-point can yank the
  // distance backwards at the turnaround. If this snap regresses but a snap
  // restricted to [lastDistance, max] is nearly as close to the course, take
  // the forward one. A genuine backtrack (fix clearly nearer the earlier
  // segment) still wins.
  if (lastDistance !== undefined && distance < lastDistance - 1e-9) {
    const fwdMin = Math.max(min, Math.min(lastDistance, max - 0.01));
    if (max - fwdMin > 1e-6) {
      const fwdSliced = turf.lineSliceAlong(course.line, fwdMin, max, { units });
      const fwdSnapped = turf.nearestPointOnLine(fwdSliced, pt, { units });
      const fwdOff = fwdSnapped.properties.dist ?? 0;
      if (fwdOff <= offCourse + snap.fwdTolerance) {
        location = fwdSnapped.properties.location ?? 0;
        distance = location + fwdMin;
        offCourse = fwdOff;
        bestSnapped = fwdSnapped;
      }
    }
  }

  let nextMin = distance - snap.minInc;
  let nextMax = distance + snap.maxInc;
  if (window.mode === 'clamped' && window.clamp) {
    nextMin = Math.max(nextMin, window.clamp.start);
    nextMax = Math.min(nextMax, window.clamp.end);
  }
  nextMin = Math.max(0, nextMin);
  nextMax = Math.min(course.length, nextMax);

  return {
    distance,
    offCourse,
    pathLat: bestSnapped.geometry.coordinates[1],
    pathLon: bestSnapped.geometry.coordinates[0],
    window: { ...window, min: nextMin, max: nextMax },
    suspect: offCourse > snap.maxOffCourse,
  };
}

/** Coordinates of the current window slice, for drawing on the admin map. */
export function windowSlice(course: Course, window: SnapWindow): [number, number][] {
  const min = Math.max(0, Math.min(window.min, course.length));
  const max = Math.max(min + 1e-6, Math.min(window.max, course.length));
  const sliced = turf.lineSliceAlong(course.line, min, max, { units: course.units });
  return sliced.geometry.coordinates as [number, number][];
}

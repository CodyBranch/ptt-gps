import * as turf from '@turf/turf';
import { describe, expect, it } from 'vitest';
import type { Course } from '../src/engine/course.js';
import { initialWindow, snapFix, windowSlice, type SnapWindow } from '../src/engine/snap.js';

const SNAP = { minInc: 0.5, maxInc: 0.5, initialMax: 1.0, maxOffCourse: 0.25, fwdTolerance: 0.02 };

/**
 * Synthetic out-and-back course: 2 miles due east, turn around, 2 miles back
 * along the same road → 4 mile course where every outbound point overlaps a
 * return point. The worst case for naive snapping, the normal case for XC.
 */
function outAndBack(): Course {
  const start = turf.point([-71.5, 42.23]);
  const out: [number, number][] = [];
  for (let d = 0; d <= 2.0001; d += 0.05) {
    const p = turf.destination(start, d, 90, { units: 'miles' });
    out.push(p.geometry.coordinates as [number, number]);
  }
  const back = [...out].reverse().slice(1);
  const line = turf.lineString([...out, ...back]);
  return { line, length: turf.length(line, { units: 'miles' }), units: 'miles' };
}

/** Geographic point at `d` miles east of the start (on the shared road). */
function roadPoint(course: Course, d: number): [number, number] {
  const p = turf.along(course.line, d, { units: 'miles' });
  return p.geometry.coordinates as [number, number];
}

describe('windowed snap', () => {
  const course = outAndBack();

  it('course sanity: ~4 miles, overlapping legs', () => {
    expect(course.length).toBeGreaterThan(3.9);
    expect(course.length).toBeLessThan(4.1);
  });

  it('snaps an early fix to the outbound leg, not the overlapping return leg', () => {
    const win = initialWindow(SNAP, course.length);
    const [lon, lat] = roadPoint(course, 0.5); // geographically identical to mile 3.5
    const r = snapFix(course, win, lon, lat, SNAP);
    expect(r.distance).toBeCloseTo(0.5, 1);
    expect(r.suspect).toBe(false);
  });

  it('advances monotonically through the turnaround and back down the same road', () => {
    let win = initialWindow(SNAP, course.length);
    let last: number | undefined;
    for (let d = 0.1; d <= 3.9; d += 0.1) {
      const [lon, lat] = roadPoint(course, d);
      const r = snapFix(course, win, lon, lat, SNAP, last);
      expect(r.distance, `at ${d.toFixed(1)} mi`).toBeCloseTo(d, 1);
      expect(r.distance).toBeGreaterThanOrEqual((last ?? 0) - 0.05);
      win = r.window;
      last = r.distance;
    }
  });

  it('still allows a genuine backtrack (fix clearly nearer the earlier segment)', () => {
    // On the outbound leg (window nowhere near the return leg): runner at 1.5,
    // then drops back to 1.2 — the regression is real and must be reported.
    const win: SnapWindow = { min: 1.0, max: 2.0, mode: 'auto' };
    const r = snapFix(course, win, ...roadPoint(course, 1.2), SNAP, 1.5);
    expect(r.distance).toBeCloseTo(1.2, 1);
  });

  it('the same geographic point resolves by window: mile 0.5 outbound vs 3.5 return', () => {
    const late: SnapWindow = { min: 3.2, max: 3.8, mode: 'auto' };
    const [lon, lat] = roadPoint(course, 0.5);
    const r = snapFix(course, late, lon, lat, SNAP);
    expect(r.distance).toBeCloseTo(3.5, 1);
  });

  it('one-shot reset window: next fix snaps inside it, then auto-advance resumes', () => {
    const reset: SnapWindow = { min: 3.0, max: 4.0, mode: 'auto' };
    const [lon, lat] = roadPoint(course, 0.5); // = return-leg mile 3.5
    const r = snapFix(course, reset, lon, lat, SNAP);
    expect(r.distance).toBeCloseTo(3.5, 1);
    expect(r.window.min).toBeCloseTo(3.0, 1); // 3.5 − minInc
    expect(r.window.max).toBeCloseTo(4.0, 1); // 3.5 + maxInc, clipped to course
    expect(r.window.mode).toBe('auto');
  });

  it('clamped window never expands past the zone', () => {
    const clamped: SnapWindow = { min: 0, max: 1, mode: 'clamped', clamp: { start: 0, end: 1 } };
    // Runner is actually at mile 1.5, outside the zone
    const [lon, lat] = roadPoint(course, 1.5);
    const r = snapFix(course, clamped, lon, lat, SNAP);
    expect(r.distance).toBeLessThanOrEqual(1.0 + 1e-6); // pinned at zone edge
    expect(r.window.max).toBeLessThanOrEqual(1.0);
    expect(r.window.mode).toBe('clamped');
    // and it reports being off the sliced course
    expect(r.offCourse).toBeGreaterThan(0.25);
    expect(r.suspect).toBe(true);
  });

  it('flags off-course fixes as suspect without losing the snap', () => {
    const win = initialWindow(SNAP, course.length);
    const away = turf.destination(turf.point(roadPoint(course, 0.5)), 0.5, 0, { units: 'miles' });
    const [lon, lat] = away.geometry.coordinates;
    const r = snapFix(course, win, lon, lat, SNAP);
    expect(r.suspect).toBe(true);
    expect(r.distance).toBeCloseTo(0.5, 1);
  });

  it('window never goes below 0 or beyond course length', () => {
    const win = initialWindow(SNAP, course.length);
    const r0 = snapFix(course, win, ...roadPoint(course, 0.05), SNAP);
    expect(r0.window.min).toBe(0);
    const rEnd = snapFix(course, { min: 3.4, max: 4.0, mode: 'auto' }, ...roadPoint(course, 3.95), SNAP);
    expect(rEnd.window.max).toBeLessThanOrEqual(course.length);
  });

  it('survives a degenerate window clamped at the course end', () => {
    const w: SnapWindow = { min: course.length, max: course.length, mode: 'auto' };
    const r = snapFix(course, w, ...roadPoint(course, 3.99), SNAP);
    expect(Number.isFinite(r.distance)).toBe(true);
  });

  it('windowSlice returns drawable coordinates for the admin map', () => {
    const coords = windowSlice(course, { min: 1.0, max: 2.0, mode: 'auto' });
    expect(coords.length).toBeGreaterThan(2);
    const sliceLen = turf.length(turf.lineString(coords), { units: 'miles' });
    expect(sliceLen).toBeCloseTo(1.0, 1);
  });
});

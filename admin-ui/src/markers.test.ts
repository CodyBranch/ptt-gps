import { describe, expect, it } from 'vitest';
import { markerStepFor, visibleMarkers, type CourseMarker } from './components/MapView';

/** A 124-mile lap race: the loop traced over and over, so every mile post
 *  exists but many share a street corner. */
const lapCourse: CourseMarker[] = [
  { at: 0, label: 'START', kind: 'start', lat: 39.96, lon: -75.18 },
  ...Array.from({ length: 124 }, (_, i) => ({
    at: i + 1,
    label: `${i + 1} mi`,
    kind: 'unit' as const,
    units: 'miles' as const,
    lat: 39.96,
    lon: -75.18,
  })),
  { at: 62, label: 'Sprint', kind: 'timing', lat: 39.97, lon: -75.19 },
  { at: 124.3, label: 'FINISH', kind: 'finish', lat: 39.96, lon: -75.18 },
];

const units = (m: CourseMarker[]) => m.filter((x) => x.kind === 'unit').map((x) => x.at);

describe('course marker thinning', () => {
  it('drops to round numbers when zoomed out and shows every post up close', () => {
    expect(markerStepFor(8)).toBe(25);
    expect(markerStepFor(15)).toBe(1);
    // zoomed right out, a 124-mile lap race is a handful of marks, not 124
    expect(units(visibleMarkers(lapCourse, 8))).toEqual([25, 50, 75, 100]);
    expect(units(visibleMarkers(lapCourse, 15))).toHaveLength(124);
  });

  it('keeps a short course readable — five posts are not clutter', () => {
    // a 6k with five km posts: thinning by 25 would leave none of them
    const short: CourseMarker[] = Array.from({ length: 5 }, (_, i) => ({
      at: i + 1,
      label: `${i + 1} km`,
      kind: 'unit' as const,
      units: 'kilometers' as const,
      lat: 0,
      lon: 0,
    }));
    expect(markerStepFor(8, 6)).toBe(1);
    expect(units(visibleMarkers(short, 8, undefined, 6))).toEqual([1, 2, 3, 4, 5]);
    // the long lap race still thins right down
    expect(markerStepFor(8, 124.3)).toBe(25);
  });

  it('never hides start, finish or a timing point', () => {
    const kept = visibleMarkers(lapCourse, 8).map((m) => m.kind);
    expect(kept).toContain('start');
    expect(kept).toContain('finish');
    expect(kept).toContain('timing');
  });

  it('during a live race keeps only the posts around the vehicles', () => {
    // leaders between 40 and 42 miles: lap one's marks are noise by now
    const shown = units(visibleMarkers(lapCourse, 15, { from: 39, to: 47, units: 'miles' }));
    expect(shown).toEqual([39, 40, 41, 42, 43, 44, 45, 46, 47]);
    expect(shown).not.toContain(3);
    expect(shown).not.toContain(120);
  });

  it('a timing point outside the band still shows', () => {
    // the sprint at 62 is not in a 39-47 band, but it is not a unit post
    const kept = visibleMarkers(lapCourse, 15, { from: 39, to: 47, units: 'miles' });
    expect(kept.some((m) => m.kind === 'timing')).toBe(true);
  });

  it('compares km posts against a miles band in the same unit', () => {
    const mixed: CourseMarker[] = [
      { at: 5, label: '5 km', kind: 'unit', units: 'kilometers', lat: 0, lon: 0 },
      { at: 80, label: '80 km', kind: 'unit', units: 'kilometers', lat: 0, lon: 0 },
    ];
    // band 39-47 miles is 62.8-75.6 km: neither post falls inside it
    expect(visibleMarkers(mixed, 15, { from: 39, to: 47, units: 'miles' })).toHaveLength(0);
    // widen to 0-60 miles (0-96 km) and both are in range
    expect(visibleMarkers(mixed, 15, { from: 0, to: 60, units: 'miles' })).toHaveLength(2);
  });
});

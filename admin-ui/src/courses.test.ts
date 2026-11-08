import { describe, expect, it } from 'vitest';
import { courseName, matchesCourse, useLabel, usesByEvent, visibleCourses } from './courses';
import type { CourseInfo, CourseUse } from './types';

/**
 * The library page for a course we run constantly.
 *
 * Gans-5k is the real case: three events, around thirty races between them,
 * which the card listed one per chip until the course itself was the smallest
 * thing on the row.
 */

const use = (eventId: string, eventName: string, raceName: string, endDate?: string): CourseUse => ({
  eventId, eventName, file: 'courses/gans-5k.geojson', raceId: raceName.toLowerCase().replace(/\W+/g, '-'),
  raceName, endDate,
});

const gansUses: CourseUse[] = [
  ...['Girls\' White 5k', 'Boys\' White 5k', 'Girls\' Blue 5k', 'Boys\' Blue 5k', 'Girls\' Gold 5k'].map((r) =>
    use('gans-creek-classic-hs', 'Gans Creek Classic HS', r, '2026-09-19'),
  ),
  use('larry-young-invite', 'Larry Young Invite - Columbia College', '5k', '2026-09-05'),
  ...['Girls Class 2 5k', 'Boys Class 2 5k', 'Girls Class 3 5k'].map((r) =>
    use('mshsaa-xc', 'MSHSAA Cross Country Championships', r, '2026-11-07'),
  ),
];

const course = (over: Partial<CourseInfo> = {}): CourseInfo => ({
  file: 'courses/gans-5k.geojson', points: 333, lengthMi: 3.1, lengthKm: 5, ...over,
});

describe('what a course is called', () => {
  it('is the name we gave it', () => {
    expect(courseName(course({ label: 'Gans Creek — Blue 5k' }))).toBe('Gans Creek — Blue 5k');
  });

  it('falls back to the filename, without the folder', () => {
    expect(courseName(course())).toBe('gans-5k.geojson');
    expect(courseName(course({ label: '   ' }))).toBe('gans-5k.geojson');
  });
});

describe('who uses a course', () => {
  it('IS ONE ENTRY PER EVENT, NOT PER RACE', () => {
    // The whole point: nine races across three events is three chips.
    expect(usesByEvent(gansUses)).toHaveLength(3);
  });

  it('keeps every race, so the details panel can still list them', () => {
    const gans = usesByEvent(gansUses).find((u) => u.eventId === 'gans-creek-classic-hs')!;
    expect(gans.races).toHaveLength(5);
    expect(gans.races).toContain("Girls' Blue 5k");
  });

  it('reads as the race when an event runs it once, and a count when it does not', () => {
    const [mshsaa, gans, larry] = usesByEvent(gansUses);
    expect(useLabel(larry)).toBe('5k');
    expect(useLabel(gans)).toBe('5 races');
    expect(useLabel(mshsaa)).toBe('3 races');
  });

  it('puts the most recent meet first — which one used it last is the question', () => {
    expect(usesByEvent(gansUses).map((u) => u.eventId)).toEqual([
      'mshsaa-xc', 'gans-creek-classic-hs', 'larry-young-invite',
    ]);
  });

  it('copes with a course nothing uses, and with events carrying no dates', () => {
    expect(usesByEvent(undefined)).toEqual([]);
    expect(usesByEvent([use('a', 'A', 'r1'), use('b', 'B', 'r2')]).map((u) => u.eventId)).toEqual(['a', 'b']);
  });

  it('does not mutate the rows it was given', () => {
    const before = JSON.stringify(gansUses);
    usesByEvent(gansUses);
    expect(JSON.stringify(gansUses)).toBe(before);
  });
});

describe('narrowing the library', () => {
  const all: CourseInfo[] = [
    course({ file: 'courses/gans-5k.geojson', label: 'Gans-5k', uses: gansUses }),
    course({ file: 'courses/gans-10k.geojson', label: 'Gans-10k' }),
    course({ file: 'courses/gans-6k.geojson', label: 'Gans-6k' }),
    course({ file: 'courses/franklinpark-8k.geojson', label: 'FranklinPark-8k', notes: 'certified MA-2024-017' }),
    course({ file: 'courses/old-loop.geojson', label: 'Retired loop', archived: true }),
  ];

  it('is sorted by the name we gave it, not the filename order', () => {
    const named = [
      course({ file: 'courses/zzz-old.geojson', label: 'Apple Hill 5k' }),
      course({ file: 'courses/aaa-new.geojson', label: 'Zebra Park 5k' }),
    ];
    expect(visibleCourses(named).map(courseName)).toEqual(['Apple Hill 5k', 'Zebra Park 5k']);
  });

  it('counts numbers as numbers, so 10k does not land before 5k', () => {
    expect(visibleCourses(all).map(courseName)).toEqual([
      'FranklinPark-8k', 'Gans-5k', 'Gans-6k', 'Gans-10k',
    ]);
  });

  it('hides archived courses unless they are asked for', () => {
    expect(visibleCourses(all).map(courseName)).not.toContain('Retired loop');
    expect(visibleCourses(all, { showArchived: true }).map(courseName)).toContain('Retired loop');
  });

  it('matches on the name', () => {
    expect(visibleCourses(all, { query: 'gans' })).toHaveLength(3);
    expect(visibleCourses(all, { query: 'GANS-6K' }).map(courseName)).toEqual(['Gans-6k']);
  });

  it('matches on the filename, which is what an event config points at', () => {
    expect(visibleCourses(all, { query: 'franklinpark-8k.geojson' }).map(courseName)).toEqual(['FranklinPark-8k']);
  });

  it('matches on notes', () => {
    expect(visibleCourses(all, { query: 'MA-2024' }).map(courseName)).toEqual(['FranklinPark-8k']);
  });

  it('MATCHES ON THE MEETS THAT USE IT — "the one we run at State"', () => {
    expect(visibleCourses(all, { query: 'mshsaa' }).map(courseName)).toEqual(['Gans-5k']);
    expect(visibleCourses(all, { query: "girls' blue" }).map(courseName)).toEqual(['Gans-5k']);
  });

  it('narrows with every word added, rather than widening', () => {
    expect(visibleCourses(all, { query: 'gans' })).toHaveLength(3);
    expect(visibleCourses(all, { query: 'gans 6k' })).toHaveLength(1);
    expect(visibleCourses(all, { query: 'gans nothinglikethis' })).toHaveLength(0);
  });

  it('an empty or blank query is everything', () => {
    expect(visibleCourses(all, { query: '   ' })).toHaveLength(4);
    expect(visibleCourses(all)).toHaveLength(4);
  });

  it('does not reorder the caller\'s array in place', () => {
    const order = all.map((c) => c.file);
    visibleCourses(all, { showArchived: true });
    expect(all.map((c) => c.file)).toEqual(order);
  });

  it('matchesCourse is independent of the archive filter', () => {
    expect(matchesCourse(all[4], 'retired')).toBe(true);
  });
});

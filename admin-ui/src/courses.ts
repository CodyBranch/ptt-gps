import type { CourseInfo, CourseUse } from './types';

/**
 * Presenting the course library.
 *
 * A course outlives the event it was drawn for, and the ones we run most are
 * the ones that get pointed at most — so the two things that grow without
 * bound on this page are the number of courses and the number of races using
 * any one of them. A 5k we run a dozen times a year ends up with thirty races
 * behind it, and listing them one per row buried the course it belonged to.
 *
 * So uses are summarised per event rather than per race, and the list can be
 * narrowed by name. Both are pure functions here so they can be tested without
 * a browser.
 */

/** What a course is called: the name somebody gave it, else its filename. */
export function courseName(c: Pick<CourseInfo, 'file' | 'label'>): string {
  return c.label?.trim() || c.file.replace(/^courses\//, '');
}

export interface EventUse {
  eventId: string;
  eventName: string;
  /** The races in that event pointing at this course, in the order given. */
  races: string[];
  /** Latest date the event carries, for ordering most recent first. */
  dateKey: string;
}

/**
 * One entry per event rather than one per race.
 *
 * An event that runs a course fourteen times is one fact about the course, not
 * fourteen. The races are kept so the details panel can still show them; the
 * card only needs to say who, and how many.
 */
export function usesByEvent(uses: CourseUse[] | undefined): EventUse[] {
  const byEvent = new Map<string, EventUse>();
  for (const u of uses ?? []) {
    const found = byEvent.get(u.eventId);
    const date = u.endDate ?? u.startDate ?? '';
    if (found) {
      found.races.push(u.raceName);
      if (date > found.dateKey) found.dateKey = date;
    } else {
      byEvent.set(u.eventId, {
        eventId: u.eventId,
        eventName: u.eventName,
        races: [u.raceName],
        dateKey: date,
      });
    }
  }
  // Most recent first: which meet used this last is the useful question, and
  // an event with no dates at all sorts after ones that have them.
  return [...byEvent.values()].sort(
    (a, b) => b.dateKey.localeCompare(a.dateKey) || a.eventName.localeCompare(b.eventName),
  );
}

/** How a grouped use reads on a card. */
export function useLabel(use: EventUse): string {
  return use.races.length === 1 ? use.races[0] : `${use.races.length} races`;
}

/**
 * Narrow the library by a typed query.
 *
 * Matching goes wider than the name on purpose. The filename is what a course
 * is called on disk and in an event config, and the meets using it are often
 * how it is remembered — "the one we use at State" is a real way to look for a
 * course, and searching only display names would not find it.
 */
export function matchesCourse(c: CourseInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  // Every word has to appear somewhere, so adding a word always narrows.
  const hay = [
    courseName(c),
    c.file.replace(/^courses\//, ''),
    c.notes ?? '',
    ...(c.uses ?? []).flatMap((u) => [u.eventName, u.raceName]),
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/**
 * The library as the page shows it: archived courses hidden unless asked for,
 * narrowed by the query, and in the order of the names we gave them.
 *
 * Sorted here rather than taken as the server sends it, which is the order the
 * files happen to sit in on disk. A course renamed to something clearer then
 * sorts under its old filename, which is exactly where nobody looks for it.
 */
export function visibleCourses(
  courses: CourseInfo[],
  opts: { query?: string; showArchived?: boolean } = {},
): CourseInfo[] {
  return courses
    .filter((c) => (opts.showArchived ? true : !c.archived))
    .filter((c) => matchesCourse(c, opts.query ?? ''))
    .sort((a, b) =>
      // Numeric-aware, so 5k, 6k, 8k and 10k fall in that order rather than
      // 10k, 5k, 6k, 8k.
      courseName(a).localeCompare(courseName(b), undefined, { numeric: true, sensitivity: 'base' }),
    );
}

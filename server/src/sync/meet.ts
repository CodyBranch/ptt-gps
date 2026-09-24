/**
 * Merging a meet sent by another system into an event config.
 *
 * The sending system knows about races, schedules and courses. It knows
 * nothing about trackers, vehicles, roles, Firebase targets, listener ports or
 * snap settings - which is most of what makes a GPS event work, and all of it
 * hand-built by an operator. So this is a merge, never a replace: anything the
 * sender has no opinion about is carried through untouched, and the planner
 * works on the raw event JSON rather than the parsed config so that keys this
 * server has never heard of survive too.
 *
 * Deliberately pure. Everything that touches the disk - saving a course,
 * writing the file, rebuilding engines - belongs to the caller, so the merge
 * rules can be tested for what they preserve rather than only for what they
 * change.
 */

export type UnitSystem = 'miles' | 'kilometers';

export interface SyncRace {
  /** The sender's own id, stable across renames and renumbering. */
  externalId?: string | null;
  name: string;
  eventNumber?: number | null;
  /** "HH:MM", local to the meet. */
  scheduledStart?: string | null;
  /** "YYYY-MM-DD", the day this race runs. Only a multi-day meet needs it. */
  date?: string | null;
  order?: number | null;
  units?: UnitSystem | null;
  /** Key into the request's courses list; null when the course is not traced yet. */
  courseKey?: string | null;
}

export interface SyncEvent {
  id?: string | null;
  externalId?: string | null;
  name: string;
  meetId?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  outputUnits?: UnitSystem | null;
}

export interface SyncRequest {
  source?: string;
  sourceVersion?: string;
  dryRun?: boolean;
  event: SyncEvent;
  courses?: Array<{ key: string; name?: string; kml?: string; lengthMeters?: number }>;
  races?: SyncRace[];
}

export type RaceAction = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface RaceReport {
  externalId?: string;
  id: string;
  name: string;
  action: RaceAction;
  reason?: string;
}

export interface MeetPlan {
  /** The raw event JSON to write. */
  config: Record<string, unknown>;
  eventAction: 'created' | 'updated' | 'unchanged';
  races: RaceReport[];
  /** Races already on this server that the sender did not mention. Never removed. */
  untouched: Array<{ id: string; name: string }>;
  warnings: string[];
}

type RawRace = Record<string, unknown>;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    // Apostrophes vanish rather than becoming separators. A race id is read in
    // URLs and on the feed, and "women-s-5k" is nobody's idea of a name.
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A race id that is not already taken, derived from the name. */
function uniqueRaceId(name: string, taken: Set<string>): string {
  const base = slugify(name) || 'race';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Apply one of the schedule fields the sender owns.
 *
 * A key that is absent and a key sent as null are different statements, and
 * JSON is the only thing that can tell them apart. Absent means "no opinion":
 * a sender that never sets programme numbers should not be wiping them.
 * Explicitly null means "there is no longer one" - a race whose start time the
 * operator took out of the schedule - and dropping that on the floor leaves a
 * stale 18:30 on a race that has no time any more, reported as unchanged.
 *
 * So: absent leaves what is here, null clears it, a value replaces it.
 */
function applySent<K extends 'eventNumber' | 'order' | 'scheduledStart' | 'date'>(
  target: RawRace,
  incoming: SyncRace,
  key: K,
  wanted: 'number' | 'string',
): void {
  if (!(key in incoming)) return;
  const value = incoming[key];
  if (value === null || value === undefined || value === '') delete target[key];
  else if (typeof value === wanted) target[key] = value;
}

export function planMeetSync(input: {
  request: SyncRequest;
  /** The raw event JSON being merged into. */
  current: Record<string, unknown>;
  /** True when the current config was synthesised because no event matched. */
  creating: boolean;
  /** Course key from the request, mapped to the course file it resolved to. */
  courseFiles: Map<string, string>;
  /** Races whose engine is armed or live; their course and units are left alone. */
  runningRaceIds?: Set<string>;
}): MeetPlan {
  const { request, current, creating, courseFiles } = input;
  const running = input.runningRaceIds ?? new Set<string>();
  const warnings: string[] = [];

  const before = JSON.stringify(current);
  const config: Record<string, unknown> = { ...current };
  const existingRaces: RawRace[] = Array.isArray(current.races)
    ? (current.races as RawRace[]).map((r) => ({ ...r }))
    : [];

  // --- the event itself -----------------------------------------------------
  const ev = request.event;
  if (ev.name) config.name = ev.name;
  if (ev.startDate) config.startDate = ev.startDate;
  if (ev.endDate) config.endDate = ev.endDate;
  if (ev.externalId) config.externalId = ev.externalId;
  if (request.source) config.externalSource = request.source;

  // A meet number the sender does not have arrives as 0, and 0 is a real
  // Firebase path prefix. Never let "not known" overwrite a number an operator
  // typed in.
  if (typeof ev.meetId === 'number' && ev.meetId > 0) {
    config.meetId = ev.meetId;
  }
  if (!Number(config.meetId)) {
    warnings.push(
      'This meet has no meet number, so Firebase output would publish under 0. Set one in Setup before race day.',
    );
  }

  if (ev.outputUnits && ev.outputUnits !== config.outputUnits) {
    if (running.size > 0) {
      // The engines refuse a units change under a running race, and rightly:
      // it reinterprets every distance already published.
      warnings.push(
        `Output units stay ${String(config.outputUnits)} while a race is running; ${ev.outputUnits} was not applied.`,
      );
    } else {
      config.outputUnits = ev.outputUnits;
    }
  }

  // --- races ----------------------------------------------------------------
  const takenIds = new Set(existingRaces.map((r) => String(r.id ?? '')));
  const matched = new Set<number>();
  const reports: RaceReport[] = [];

  /**
   * Stable id first, then programme number, then name. Name alone is last
   * because it is the one that changes: "Boys Varsity" becomes "Boys Varsity
   * 5K" and a number stays a number.
   */
  const findMatch = (incoming: SyncRace): number => {
    const byExternal = existingRaces.findIndex(
      (r, i) => !matched.has(i) && incoming.externalId && str(r.externalId) === incoming.externalId,
    );
    if (byExternal >= 0) return byExternal;

    const byNumber = existingRaces.findIndex(
      (r, i) =>
        !matched.has(i) &&
        typeof incoming.eventNumber === 'number' &&
        typeof r.eventNumber === 'number' &&
        r.eventNumber === incoming.eventNumber,
    );
    if (byNumber >= 0) return byNumber;

    const wanted = incoming.name.trim().toLowerCase();
    return existingRaces.findIndex(
      (r, i) => !matched.has(i) && String(r.name ?? '').trim().toLowerCase() === wanted,
    );
  };

  for (const incoming of request.races ?? []) {
    const idx = findMatch(incoming);
    const isNew = idx < 0;
    const target: RawRace = isNew ? {} : existingRaces[idx];
    const raceId = isNew ? uniqueRaceId(incoming.name, takenIds) : String(target.id ?? '');
    const raceBefore = JSON.stringify(target);
    const reasons: string[] = [];

    let course = str(target.course);
    if (incoming.courseKey) {
      const file = courseFiles.get(incoming.courseKey);
      if (!file) {
        reasons.push(`the course "${incoming.courseKey}" was not in the request`);
      } else if (running.has(raceId) && course && course !== file) {
        reasons.push('the course was left alone because this race is running');
      } else {
        course = file;
      }
    }

    if (!course) {
      // The race is taken anyway, without a line to run on.
      //
      // It used to be refused here, on the grounds that an engine cannot be
      // built without a course. True, but it made the wrong thing impossible:
      // a schedule is settled weeks out and a course is traced days before, so
      // refusing the race until the GPX exists meant the meet could not be sent
      // at all, and every race had to be re-sent afterwards to pick up a course
      // that was linked over here anyway.
      //
      // So the race lands, carrying its number, time and running order, and
      // shows in Event Setup with an empty course picker. Linking a course
      // there builds its engine. Nothing tracks it in the meantime.
      reasons.push('no course yet — link one in Event Setup');
    }

    if (isNew) {
      target.id = raceId;
      takenIds.add(raceId);
    }
    target.name = incoming.name;
    // Written as an empty string rather than left undefined, so "not traced
    // yet" is a thing the file says rather than a key that happens to be absent.
    target.course = course ?? '';
    // The match key is the exception: a null here is never honoured. Clearing
    // the id that finds this race again, remotely and in passing, is not a
    // thing a sender should be able to do by mistake.
    if (incoming.externalId) target.externalId = incoming.externalId;

    applySent(target, incoming, 'eventNumber', 'number');
    applySent(target, incoming, 'order', 'number');
    applySent(target, incoming, 'scheduledStart', 'string');
    // The day is not held back for a running race: it is a label on the
    // schedule, not something a live engine has read.
    applySent(target, incoming, 'date', 'string');

    if (incoming.units) {
      if (running.has(raceId) && target.units && target.units !== incoming.units) {
        reasons.push('the units were left alone because this race is running');
      } else {
        target.units = incoming.units;
      }
    }

    if (isNew) {
      existingRaces.push(target);
      matched.add(existingRaces.length - 1);
    } else {
      matched.add(idx);
    }

    const changed = JSON.stringify(target) !== raceBefore;
    reports.push({
      externalId: incoming.externalId ?? undefined,
      id: raceId,
      name: incoming.name,
      action: isNew ? 'created' : changed ? 'updated' : 'unchanged',
      reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    });
  }

  config.races = existingRaces;

  const untouched = existingRaces
    .map((r, i) => ({ r, i }))
    .filter(({ i }) => !matched.has(i))
    .map(({ r }) => ({ id: String(r.id ?? ''), name: String(r.name ?? '') }));

  const eventAction = creating ? 'created' : JSON.stringify(config) === before ? 'unchanged' : 'updated';

  return { config, eventAction, races: reports, untouched, warnings };
}

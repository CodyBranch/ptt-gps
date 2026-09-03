import { z } from 'zod';

export const Units = z.enum(['miles', 'kilometers']);

export const TrackerSchema = z.object({
  imei: z.string().regex(/^\d{15}$/, 'IMEI must be 15 digits'),
  label: z.string(),
  /** Vehicle-powered units (GV500CNA) report no battery percent. */
  hasBattery: z.boolean().default(true),
});

/**
 * A physical vehicle carrying trackers — a lead car, a moto, a timing van.
 *
 * It exists as its own thing because coverage moves: at a criterium four motos
 * swap which race they are shooting through the day, and reassigning one is a
 * property of the vehicle, not of the hardware bolted to it. Its trackers are
 * ordered primary-first and all compute continuously, so failover within the
 * vehicle and reassignment of the vehicle are separate moves.
 */
export const VehicleSchema = z.object({
  key: z.string(),
  label: z.string(),
  trackers: z.array(z.string()).min(1),
});

export const RoleSchema = z.object({
  key: z.string(),
  label: z.string(),
  /**
   * Which vehicle is currently covering this role, if any. The role owns the
   * output bindings below and keeps them whoever is assigned, so a scoreboard
   * slot stays fixed while the vehicle behind it changes mid-race. Empty means
   * nobody is covering it — a real state when a moto leaves one race for
   * another — and an uncovered role publishes nothing rather than a stale or
   * invented number.
   */
  vehicle: z.string().default(''),
  /** Legacy Firebase command number — GPSMap/<cmd> path (krush flavor). */
  cmd: z.number().int().optional(),
  /** Legacy event name written into GPSMap payloads, e.g. "elite_women". */
  mapEvent: z.string().optional(),
  /** Legacy Meta/Clock distanceComplete<N> / PTT-Scoreboard Distance<N> slot (1–4). */
  clockSlot: z.number().int().min(1).max(4).optional(),
});

/**
 * Snap window defaults, taken from the legacy per-event admin pages
 * (min_inc 0.2 / max_inc 1.0, first window 0..0.5, in miles) rather than
 * invented: those are the values PT Timing actually raced with. The asymmetry
 * is deliberate — a lead vehicle only moves forward, so the window is kept on
 * a short leash behind and given room ahead to recover from a dropped signal.
 */
export const SnapSchema = z.object({
  /** How far behind the last snap the window reaches (course units). */
  minInc: z.number().positive().default(0.2),
  /** How far ahead of the last snap the window reaches (course units). */
  maxInc: z.number().positive().default(1.0),
  /** Window before the first fix: 0..initialMax (course units). */
  initialMax: z.number().positive().default(0.5),
  /** Max distance off-course before a snap is flagged suspect (course units). */
  maxOffCourse: z.number().positive().default(0.25),
  /**
   * When a snap would move backwards but a forward candidate is nearly as close
   * to the course (within this distance, course units), prefer forward — keeps
   * overlapping out-and-back legs from yanking the distance back at turnarounds.
   */
  fwdTolerance: z.number().positive().default(0.02),
});

export const RaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * The number this race is known by in the meet programme. Optional, because
   * a road race with one start has no use for it, and a track or cross-country
   * meet cannot be discussed without it.
   */
  eventNumber: z.number().int().min(0).optional(),
  /**
   * Scheduled start, as the operator writes it on the schedule: "09:00", local
   * to the meet.
   *
   * Deliberately a wall-clock time rather than an instant. A schedule is
   * written in the time at the venue and does not move when the server is in
   * another zone, and a meet that slips by a day should not silently reschedule
   * every race by 24 hours.
   */
  scheduledStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00')
    .optional(),
  /**
   * Where this race sits in the running order. Lower first; ties fall back to
   * the order races appear in the file, so an event that never sets it behaves
   * exactly as it always did.
   */
  order: z.number().int().optional(),
  /** Path to a KML or GeoJSON course file, relative to the event file. */
  course: z.string(),
  units: Units.default('miles'),
  /**
   * Course markers (mile/km posts, aid stations) belong to the course, not to
   * the race — the same course is reused across events and the posts are the
   * same every year. They live in the course library; older event files may
   * still carry `autoMarkers`/`markers` keys, which are migrated then ignored.
   */
  snap: SnapSchema.partial().optional(),
  /** Per-race overrides — exceptions only; normally inherited from the meet. */
  roles: z.array(RoleSchema).optional(),
  extraTrackers: z.array(TrackerSchema).optional(),
  excludeTrackers: z.array(z.string()).optional(),
});

export const FirebaseTargetSchema = z.object({
  /** Name of a connection from the server-wide Firebase registry (Setup). */
  connection: z.string(),
  /** "ptt" = PTT-Scoreboard + Meta/Clock; "krush" = Meta/Clock + GPSMap. */
  flavor: z.enum(['ptt', 'krush']),
});

/** Per-view decimal places: the full viewer and the distances board differ. */
export const ViewerPrecisionSchema = z.object({
  full: z.number().int().min(0).max(2).default(2),
  board: z.number().int().min(0).max(2).default(2),
});

export const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  meetId: z.number().int(),
  /** Event dates (YYYY-MM-DD) — drive sorting and completed/hidden state. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * Units for published distances (Firebase etc.). Courses keep their own
   * per-race units; the publisher converts. Scoreboards expect one unit per meet.
   */
  outputUnits: Units.default('miles'),
  /**
   * Expected tracker report cadence in seconds — drives the console's
   * fresh/aging/stale coloring on packet age (fleet reports every 5–10 s).
   */
  reportIntervalS: z.number().positive().default(10),
  /**
   * When the meet was put away, ISO date. Events also file themselves once
   * their end date passes, but that needs an end date and a date that has
   * actually passed — this is the operator saying "this one is done".
   */
  completedAt: z.string().optional(),
  /**
   * Decimal places on the distances the viewer pages show. The operator console
   * always reads 2 — it is a working instrument. What gets read aloud or put on
   * a screen is a different question: "5.1 km" is often the honest precision
   * for a moto's position, and "5" is what an announcer wants.
   */
  viewerPrecision: ViewerPrecisionSchema.prefault({}),
  listeners: z
    .array(z.object({ name: z.string(), port: z.number().int() }))
    .default([{ name: 'queclink', port: 1000 }]),
  firebase: z.array(FirebaseTargetSchema).default([]),
  trackers: z.array(TrackerSchema),
  vehicles: z.array(VehicleSchema).default([]),
  roles: z.array(RoleSchema),
  snapDefaults: SnapSchema.prefault({}),
  /** A freshly created event legitimately has no races yet — add them in Setup. */
  races: z.array(RaceSchema).default([]),
});

export type EventConfig = z.infer<typeof EventSchema>;
export type RaceConfig = z.infer<typeof RaceSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type VehicleConfig = z.infer<typeof VehicleSchema>;
export type TrackerConfig = z.infer<typeof TrackerSchema>;
export type SnapConfig = z.infer<typeof SnapSchema>;
export type FirebaseTarget = z.infer<typeof FirebaseTargetSchema>;

export const MI_PER_KM = 0.621371;

/**
 * The running order of an event's races.
 *
 * Sorted by `order` where it is set, falling back to the position in the file
 * so that an event which never sets one behaves exactly as it always did. The
 * sort is stable and total, and lives here rather than in each caller because
 * the console, the live feed and the snapshot all present this list and must
 * not disagree about it.
 */
export function inRunningOrder<T extends { order?: number }>(races: readonly T[]): T[] {
  return races
    .map((race, index) => ({ race, index }))
    .sort((a, b) => {
      const ao = a.race.order ?? Number.POSITIVE_INFINITY;
      const bo = b.race.order ?? Number.POSITIVE_INFINITY;
      // Races without an explicit order keep their file position, after those
      // that have one - "unordered" should not mean "first".
      return ao === bo ? a.index - b.index : ao - bo;
    })
    .map(({ race }) => race);
}

/** Convert a distance between course units and another unit system. */
export function convertUnits(value: number, from: z.infer<typeof Units>, to: z.infer<typeof Units>): number {
  if (from === to) return value;
  return from === 'miles' ? value / MI_PER_KM : value * MI_PER_KM;
}

/** A role with its assigned vehicle's trackers resolved onto it. */
export interface ResolvedRole extends RoleConfig {
  trackers: string[];
}

/** Effective roster/vehicles/roles/snap for a race after meet-level inheritance. */
export function resolveRace(event: EventConfig, race: RaceConfig) {
  const excluded = new Set(race.excludeTrackers ?? []);
  const trackers = [...event.trackers, ...(race.extraTrackers ?? [])].filter(
    (t) => !excluded.has(t.imei),
  );
  const imeis = new Set(trackers.map((t) => t.imei));
  // Vehicles are the meet's physical assets, shared by every race in it.
  const vehicles = event.vehicles
    .map((v) => ({ ...v, trackers: v.trackers.filter((i) => imeis.has(i)) }))
    .filter((v) => v.trackers.length > 0);
  const byKey = new Map(vehicles.map((v) => [v.key, v]));
  // Uncovered roles are kept: the console has to show that nobody is on them.
  const roles: ResolvedRole[] = (race.roles ?? event.roles).map((r) => ({
    ...r,
    trackers: byKey.get(r.vehicle)?.trackers ?? [],
  }));
  const snap = { ...event.snapDefaults, ...(race.snap ?? {}) };
  return { trackers, vehicles, roles, snap };
}

import { z } from 'zod';

export const Units = z.enum(['miles', 'kilometers']);

export const TrackerSchema = z.object({
  imei: z.string().regex(/^\d{15}$/, 'IMEI must be 15 digits'),
  label: z.string(),
  /** Vehicle-powered units (GV500CNA) report no battery percent. */
  hasBattery: z.boolean().default(true),
});

export const RoleSchema = z.object({
  key: z.string(),
  label: z.string(),
  /**
   * Ordered tracker list: primary first, then backups. All compute
   * continuously; exactly one is "active" (published) at a time.
   */
  trackers: z.array(z.string()).min(1),
  /** Legacy Firebase command number — GPSMap/<cmd> path (krush flavor). */
  cmd: z.number().int().optional(),
  /** Legacy event name written into GPSMap payloads, e.g. "elite_women". */
  mapEvent: z.string().optional(),
  /** Legacy Meta/Clock distanceComplete<N> / PTT-Scoreboard Distance<N> slot (1–4). */
  clockSlot: z.number().int().min(1).max(4).optional(),
});

export const SnapSchema = z.object({
  /** How far behind the last snap the window reaches (course units). */
  minInc: z.number().positive().default(0.5),
  /** How far ahead of the last snap the window reaches (course units). */
  maxInc: z.number().positive().default(0.5),
  /** Window before the first fix: 0..initialMax (course units). */
  initialMax: z.number().positive().default(1.0),
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
  /** Path to a KML or GeoJSON course file, relative to the event file. */
  course: z.string(),
  units: Units.default('miles'),
  snap: SnapSchema.partial().optional(),
  /** Per-race overrides — exceptions only; normally inherited from the meet. */
  roles: z.array(RoleSchema).optional(),
  extraTrackers: z.array(TrackerSchema).optional(),
  excludeTrackers: z.array(z.string()).optional(),
});

export const FirebaseTargetSchema = z.object({
  name: z.string(),
  /** "ptt" = PTT-Scoreboard + Meta/Clock; "krush" = Meta/Clock + GPSMap. */
  flavor: z.enum(['ptt', 'krush']),
  databaseURL: z.string().url(),
  /** Env var holding the path to the service-account JSON (never in config). */
  credentialEnv: z.string(),
});

export const EventSchema = z.object({
  id: z.string(),
  name: z.string(),
  meetId: z.number().int(),
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
  listeners: z
    .array(z.object({ name: z.string(), port: z.number().int() }))
    .default([{ name: 'queclink', port: 1000 }]),
  firebase: z.array(FirebaseTargetSchema).default([]),
  trackers: z.array(TrackerSchema),
  roles: z.array(RoleSchema),
  snapDefaults: SnapSchema.prefault({}),
  /** A freshly created event legitimately has no races yet — add them in Setup. */
  races: z.array(RaceSchema).default([]),
});

export type EventConfig = z.infer<typeof EventSchema>;
export type RaceConfig = z.infer<typeof RaceSchema>;
export type RoleConfig = z.infer<typeof RoleSchema>;
export type TrackerConfig = z.infer<typeof TrackerSchema>;
export type SnapConfig = z.infer<typeof SnapSchema>;
export type FirebaseTarget = z.infer<typeof FirebaseTargetSchema>;

export const MI_PER_KM = 0.621371;

/** Convert a distance between course units and another unit system. */
export function convertUnits(value: number, from: z.infer<typeof Units>, to: z.infer<typeof Units>): number {
  if (from === to) return value;
  return from === 'miles' ? value / MI_PER_KM : value * MI_PER_KM;
}

/** Effective roster/roles/snap for a race after applying meet-level inheritance. */
export function resolveRace(event: EventConfig, race: RaceConfig) {
  const excluded = new Set(race.excludeTrackers ?? []);
  const trackers = [...event.trackers, ...(race.extraTrackers ?? [])].filter(
    (t) => !excluded.has(t.imei),
  );
  const imeis = new Set(trackers.map((t) => t.imei));
  const roles = (race.roles ?? event.roles)
    .map((r) => ({ ...r, trackers: r.trackers.filter((i) => imeis.has(i)) }))
    .filter((r) => r.trackers.length > 0);
  const snap = { ...event.snapDefaults, ...(race.snap ?? {}) };
  return { trackers, roles, snap };
}

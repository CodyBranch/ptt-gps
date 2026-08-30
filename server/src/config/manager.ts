import fs from 'node:fs';
import path from 'node:path';
import { parseCourse } from '../engine/course.js';
import { parseEventConfig } from './load.js';
import type { EventConfig } from './schema.js';

/**
 * Owns the as-authored event config file so the setup UI can edit it.
 * The JSON on disk stays the source of truth (and stays versionable);
 * every accepted update is validated, persisted, and handed back resolved
 * for an engine rebuild.
 */
export interface EventListing {
  id: string;
  name: string;
  meetId: number;
  file: string;
  races: number;
  trackers: number;
  startDate?: string;
  endDate?: string;
  error?: string;
}

/** Scan an events directory for event config files. */
export function listEvents(dir: string): EventListing[] {
  const out: EventListing[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        id: String(json.id ?? f.replace(/\.json$/, '')),
        name: String(json.name ?? f),
        meetId: Number(json.meetId ?? 0),
        file: f,
        races: Array.isArray(json.races) ? json.races.length : 0,
        trackers: Array.isArray(json.trackers) ? json.trackers.length : 0,
        startDate: typeof json.startDate === 'string' ? json.startDate : undefined,
        endDate: typeof json.endDate === 'string' ? json.endDate : undefined,
      });
    } catch (err) {
      out.push({ id: f, name: f, meetId: 0, file: f, races: 0, trackers: 0, error: (err as Error).message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Course files live in <eventsDir>/courses and are shared by all events. */
export function listCoursesIn(eventsDir: string): Array<{ file: string; points: number; lengthMi: number; lengthKm: number }> {
  const coursesDir = path.join(eventsDir, 'courses');
  fs.mkdirSync(coursesDir, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(coursesDir)) {
    if (!/\.(kml|geojson|json)$/i.test(f)) continue;
    try {
      const text = fs.readFileSync(path.join(coursesDir, f), 'utf8');
      const mi = parseCourse(text, f.toLowerCase().endsWith('.kml'), 'miles');
      out.push({
        file: `courses/${f}`,
        points: mi.line.geometry.coordinates.length,
        lengthMi: mi.length,
        lengthKm: mi.length / 0.621371,
      });
    } catch {
      out.push({ file: `courses/${f}`, points: 0, lengthMi: 0, lengthKm: 0 });
    }
  }
  return out;
}

/**
 * Validate and store an uploaded KML course. Replacing the geometry behind an
 * existing name changes it for every event that already points at it — past
 * ones included — so that needs an explicit `replace`.
 */
export function saveCourseIn(
  eventsDir: string,
  name: string,
  kmlText: string,
  opts: { replace?: boolean } = {},
): { file: string; lengthMi: number; points: number; replaced: boolean } {
  const safe = name.toLowerCase().replace(/\.kml$/, '').replace(/[^a-z0-9-_]+/g, '-');
  if (!safe) throw new Error('Invalid course name');
  const course = parseCourse(kmlText, true, 'miles'); // throws when there is no LineString
  const coursesDir = path.join(eventsDir, 'courses');
  fs.mkdirSync(coursesDir, { recursive: true });
  const target = path.join(coursesDir, `${safe}.kml`);
  const exists = fs.existsSync(target);
  if (exists && !opts.replace) {
    throw new Error(`A course named ${safe}.kml already exists — rename this file, or replace it from the Courses page`);
  }
  fs.writeFileSync(target, kmlText);
  return {
    file: `courses/${safe}.kml`,
    lengthMi: course.length,
    points: course.line.geometry.coordinates.length,
    replaced: exists,
  };
}

export interface CourseUse {
  eventId: string;
  eventName: string;
  file: string;
  raceId: string;
  raceName: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Every (event, race) that references each course file. Courses outlive the
 * events that use them — a 2022 event still has to resolve its course to
 * replay that race — so this drives the "used by" view and guards deletes.
 */
export function courseUsage(dir: string): Map<string, CourseUse[]> {
  const out = new Map<string, CourseUse[]>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const race of Array.isArray(json.races) ? json.races : []) {
        const course = typeof race?.course === 'string' ? race.course : undefined;
        if (!course) continue;
        const key = course.replace(/^\.\//, '');
        const list = out.get(key) ?? [];
        list.push({
          eventId: String(json.id ?? f.replace(/\.json$/, '')),
          eventName: String(json.name ?? f),
          file: f,
          raceId: String(race.id ?? ''),
          raceName: String(race.name ?? race.id ?? ''),
          startDate: typeof json.startDate === 'string' ? json.startDate : undefined,
          endDate: typeof json.endDate === 'string' ? json.endDate : undefined,
        });
        out.set(key, list);
      }
    } catch {
      /* invalid files are reported by listEvents */
    }
  }
  return out;
}

const courseFilePath = (eventsDir: string, file: string): string => {
  const base = path.basename(file);
  if (!base || base !== file.replace(/^courses\//, '')) throw new Error('Invalid course file');
  return path.join(eventsDir, 'courses', base);
};

/**
 * Rename a course and rewrite every event that points at it, so a tidier name
 * never orphans an old event's race.
 */
export function renameCourseIn(eventsDir: string, from: string, to: string): { file: string; updated: string[] } {
  const safe = to.toLowerCase().replace(/\.kml$/, '').replace(/[^a-z0-9-_]+/g, '-');
  if (!safe) throw new Error('Invalid course name');
  const src = courseFilePath(eventsDir, from);
  if (!fs.existsSync(src)) throw new Error(`Course not found: ${from}`);
  const ext = path.extname(src) || '.kml';
  const target = `courses/${safe}${ext}`;
  if (target === from) return { file: from, updated: [] };
  const dst = path.join(eventsDir, 'courses', `${safe}${ext}`);
  if (fs.existsSync(dst)) throw new Error(`A course named ${safe}${ext} already exists`);

  const updated: string[] = [];
  for (const [eventFile, uses] of eventFilesUsing(eventsDir, from)) {
    const full = path.join(eventsDir, eventFile);
    const json = JSON.parse(fs.readFileSync(full, 'utf8'));
    for (const race of json.races ?? []) {
      if (typeof race?.course === 'string' && race.course.replace(/^\.\//, '') === from) race.course = target;
    }
    fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
    updated.push(`${json.name ?? eventFile} (${uses} race${uses === 1 ? '' : 's'})`);
  }
  fs.renameSync(src, dst);
  return { file: target, updated };
}

/** event file → how many of its races use this course. */
function eventFilesUsing(eventsDir: string, file: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const use of courseUsage(eventsDir).get(file) ?? []) {
    counts.set(use.file, (counts.get(use.file) ?? 0) + 1);
  }
  return counts;
}

/** Delete a course file. Refused while any event — past or present — uses it. */
export function deleteCourseIn(eventsDir: string, file: string): void {
  const uses = courseUsage(eventsDir).get(file) ?? [];
  if (uses.length > 0) {
    const names = [...new Set(uses.map((u) => u.eventName))];
    throw new Error(
      `In use by ${names.length} event${names.length === 1 ? '' : 's'} (${names.join(', ')}) — archive it instead so those races still resolve`,
    );
  }
  const p = courseFilePath(eventsDir, file);
  if (!fs.existsSync(p)) throw new Error(`Course not found: ${file}`);
  fs.unlinkSync(p);
}

/** Raw text of a course file, for download / re-export. */
export function readCourseIn(eventsDir: string, file: string): string {
  const p = courseFilePath(eventsDir, file);
  if (!fs.existsSync(p)) throw new Error(`Course not found: ${file}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * One-time lift of race-level `autoMarkers`/`markers` (where they used to live)
 * into the course library, where they belong — the posts are a property of the
 * course, not of whichever race is running on it this year. Only seeds courses
 * that have not been configured yet, so it never overwrites later edits, and it
 * strips the dead keys from the event file.
 */
export function migrateRaceMarkersToCourses(
  eventsDir: string,
  store: {
    courseMarkersConfigured(file: string): boolean;
    setCourseMarkers(file: string, patch: { auto?: boolean; units?: 'miles' | 'kilometers'; markers?: Array<{ at: number; label: string }> }): void;
  },
): void {
  for (const f of fs.readdirSync(eventsDir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(eventsDir, f);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    let touched = false;
    for (const race of (json.races as Array<Record<string, unknown>>) ?? []) {
      const hasLegacy = 'markers' in race || 'autoMarkers' in race;
      if (!hasLegacy) continue;
      const course = typeof race.course === 'string' ? race.course.replace(/^\.\//, '') : undefined;
      if (course && !store.courseMarkersConfigured(course)) {
        const markers = Array.isArray(race.markers)
          ? (race.markers as Array<{ at?: unknown; label?: unknown }>)
              .filter((m) => Number.isFinite(Number(m?.at)))
              .map((m) => ({ at: Number(m.at), label: String(m.label ?? '') }))
          : [];
        store.setCourseMarkers(course, {
          auto: race.autoMarkers !== false,
          units: race.units === 'kilometers' ? 'kilometers' : 'miles',
          markers,
        });
        console.log(`[courses] migrated markers from ${f}:${String(race.id)} onto ${course}`);
      }
      delete race.markers;
      delete race.autoMarkers;
      touched = true;
    }
    if (touched) fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n');
  }
}

/**
 * Lift `roles[].trackers` into first-class vehicles.
 *
 * Roles used to be both the publishing identity and the hardware list, which
 * only holds while a vehicle covers one thing all day. Each old role becomes a
 * vehicle carrying the same trackers, and the role points at it — identical
 * behaviour, but coverage can now be reassigned without touching hardware.
 */
const NEWLINE = String.fromCharCode(10);

export function migrateRolesToVehicles(eventsDir: string): void {
  for (const f of fs.readdirSync(eventsDir)) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(eventsDir, f);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const roles = (json.roles as Array<Record<string, unknown>>) ?? [];
    const needs = roles.some((r) => Array.isArray(r.trackers));
    if (!needs) continue;

    const vehicles = (json.vehicles as Array<Record<string, unknown>>) ?? [];
    const byTrackers = new Map(vehicles.map((v) => [JSON.stringify(v.trackers), String(v.key)]));
    for (const role of roles) {
      if (!Array.isArray(role.trackers)) continue;
      const fingerprint = JSON.stringify(role.trackers);
      // Two roles sharing a tracker list were one vehicle all along.
      let key = byTrackers.get(fingerprint);
      if (!key) {
        key = String(role.key);
        let n = 2;
        while (vehicles.some((v) => v.key === key)) key = `${String(role.key)}-${n++}`;
        vehicles.push({ key, label: String(role.label ?? role.key), trackers: role.trackers });
        byTrackers.set(fingerprint, key);
      }
      role.vehicle = key;
      delete role.trackers;
    }
    json.vehicles = vehicles;
    fs.writeFileSync(full, JSON.stringify(json, null, 2) + NEWLINE);
    console.log(`[events] ${f}: lifted ${vehicles.length} vehicle(s) out of its roles`);
  }
}

/** Which events reference which tracker IMEIs (for the fleet page). */
export function eventRosters(
  dir: string,
): Array<{ id: string; name: string; file: string; imeis: string[]; endDate?: string }> {
  const out: Array<{ id: string; name: string; file: string; imeis: string[]; endDate?: string }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: String(json.id ?? f.replace(/\.json$/, '')),
        name: String(json.name ?? f),
        file: f,
        imeis: Array.isArray(json.trackers) ? json.trackers.map((t: { imei?: unknown }) => String(t?.imei ?? '')) : [],
        endDate: typeof json.endDate === 'string' ? json.endDate : undefined,
      });
    } catch {
      /* invalid files are reported by listEvents */
    }
  }
  return out;
}

/**
 * Create a new event config file — blank, or copied from an existing event
 * (the copy-last-year workflow: everything carries over, you update meet ID,
 * name, and whatever changed).
 */
export function createEvent(
  dir: string,
  opts: { id: string; name: string; meetId: number; copyFromFile?: string },
): string {
  const slug = opts.id.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Event id is required');
  const file = path.join(dir, `${slug}.json`);
  if (fs.existsSync(file)) throw new Error(`Event file ${slug}.json already exists`);

  let base: Record<string, unknown>;
  if (opts.copyFromFile) {
    const src = path.join(dir, path.basename(opts.copyFromFile));
    if (!fs.existsSync(src)) throw new Error(`Copy source not found: ${opts.copyFromFile}`);
    base = JSON.parse(fs.readFileSync(src, 'utf8'));
  } else {
    base = { listeners: [{ name: 'queclink', port: 1000 }], firebase: [], trackers: [], roles: [], races: [] };
  }
  const json = { ...base, id: slug, name: opts.name, meetId: opts.meetId };
  parseEventConfig(json, dir); // validate before writing
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return `${slug}.json`;
}

export class ConfigManager {
  raw: EventConfig;
  readonly baseDir: string;

  constructor(private eventPath: string) {
    this.baseDir = path.dirname(path.resolve(eventPath));
    const json = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    this.raw = parseEventConfig(json, this.baseDir).raw;
  }

  get coursesDir(): string {
    return path.join(this.baseDir, 'courses');
  }

  /** The engine-ready form (absolute course paths) of the current raw config. */
  resolved(): EventConfig {
    return parseEventConfig(this.raw, this.baseDir).resolved;
  }

  /** Validate + persist a full event config; returns the resolved form. */
  update(json: unknown): EventConfig {
    const { raw, resolved } = parseEventConfig(json, this.baseDir);
    fs.writeFileSync(this.eventPath, JSON.stringify(raw, null, 2) + '\n');
    this.raw = raw;
    return resolved;
  }

  listCourses(): Array<{ file: string; points: number; lengthMi: number; lengthKm: number }> {
    fs.mkdirSync(this.coursesDir, { recursive: true });
    const out = [];
    for (const f of fs.readdirSync(this.coursesDir)) {
      if (!/\.(kml|geojson|json)$/i.test(f)) continue;
      try {
        const text = fs.readFileSync(path.join(this.coursesDir, f), 'utf8');
        const mi = parseCourse(text, f.toLowerCase().endsWith('.kml'), 'miles');
        out.push({
          file: `courses/${f}`,
          points: mi.line.geometry.coordinates.length,
          lengthMi: mi.length,
          lengthKm: mi.length / 0.621371,
        });
      } catch {
        out.push({ file: `courses/${f}`, points: 0, lengthMi: 0, lengthKm: 0 });
      }
    }
    return out;
  }

  /** Validate and store an uploaded KML course; returns its measured length. */
  saveCourse(name: string, kmlText: string): { file: string; lengthMi: number; points: number } {
    const safe = name.toLowerCase().replace(/\.kml$/, '').replace(/[^a-z0-9-_]+/g, '-');
    if (!safe) throw new Error('Invalid course name');
    const course = parseCourse(kmlText, true, 'miles'); // throws when there is no LineString
    fs.mkdirSync(this.coursesDir, { recursive: true });
    const file = path.join(this.coursesDir, `${safe}.kml`);
    fs.writeFileSync(file, kmlText);
    return { file: `courses/${safe}.kml`, lengthMi: course.length, points: course.line.geometry.coordinates.length };
  }
}

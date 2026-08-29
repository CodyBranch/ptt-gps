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
      });
    } catch (err) {
      out.push({ id: f, name: f, meetId: 0, file: f, races: 0, trackers: 0, error: (err as Error).message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which events reference which tracker IMEIs (for the fleet page). */
export function eventRosters(dir: string): Array<{ id: string; name: string; file: string; imeis: string[] }> {
  const out: Array<{ id: string; name: string; file: string; imeis: string[] }> = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({
        id: String(json.id ?? f.replace(/\.json$/, '')),
        name: String(json.name ?? f),
        file: f,
        imeis: Array.isArray(json.trackers) ? json.trackers.map((t: { imei?: unknown }) => String(t?.imei ?? '')) : [],
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

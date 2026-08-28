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

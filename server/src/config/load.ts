import fs from 'node:fs';
import path from 'node:path';
import { EventSchema, type EventConfig } from './schema.js';

/**
 * Parse + validate an event config object.
 * Returns both the as-authored form (relative course paths — what gets written
 * back to disk by the setup UI) and the resolved form (absolute course paths —
 * what the engines consume).
 */
export function parseEventConfig(
  json: unknown,
  baseDir: string,
): { raw: EventConfig; resolved: EventConfig } {
  const parsed = EventSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid event config: ${issues}`);
  }
  const raw = parsed.data;

  const imeis = new Set(raw.trackers.map((t) => t.imei));
  for (const vehicle of raw.vehicles) {
    for (const imei of vehicle.trackers) {
      if (!imeis.has(imei)) {
        throw new Error(`Vehicle "${vehicle.key}" references unknown tracker IMEI ${imei}`);
      }
    }
  }
  const vehicleKeys = new Set(raw.vehicles.map((v) => v.key));
  for (const role of raw.roles) {
    if (role.vehicle !== '' && !vehicleKeys.has(role.vehicle)) {
      throw new Error(`Role "${role.key}" is assigned to unknown vehicle "${role.vehicle}"`);
    }
  }
  const raceIds = new Set<string>();
  for (const race of raw.races) {
    if (raceIds.has(race.id)) throw new Error(`Duplicate race id "${race.id}"`);
    raceIds.add(race.id);
  }

  const resolved: EventConfig = structuredClone(raw);
  for (const race of resolved.races) {
    // A race whose line has not been traced yet is left as it is rather than
    // resolved. Resolving it would be worse than useless: path.resolve against
    // an empty string yields the event's own directory, which exists, so the
    // check below would pass and the engine would later be handed a folder to
    // read as a course.
    if (race.course.trim() === '') continue;
    const coursePath = path.resolve(baseDir, race.course);
    if (!fs.existsSync(coursePath)) {
      throw new Error(`Race "${race.id}": course file not found: ${race.course}`);
    }
    race.course = coursePath;
  }
  return { raw, resolved };
}

export function loadEventConfig(filePath: string): EventConfig {
  const abs = path.resolve(filePath);
  const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  return parseEventConfig(json, path.dirname(abs)).resolved;
}

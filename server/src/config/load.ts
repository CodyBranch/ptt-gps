import fs from 'node:fs';
import path from 'node:path';
import { EventSchema, type EventConfig } from './schema.js';

export function loadEventConfig(filePath: string): EventConfig {
  const abs = path.resolve(filePath);
  const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const parsed = EventSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid event config ${filePath}:\n${issues}`);
  }
  const cfg = parsed.data;

  // Cross-checks zod can't express
  const imeis = new Set(cfg.trackers.map((t) => t.imei));
  for (const role of cfg.roles) {
    for (const imei of role.trackers) {
      if (!imeis.has(imei)) {
        throw new Error(`Role "${role.key}" references unknown tracker IMEI ${imei}`);
      }
    }
  }
  const dir = path.dirname(abs);
  for (const race of cfg.races) {
    const coursePath = path.resolve(dir, race.course);
    if (!fs.existsSync(coursePath)) {
      throw new Error(`Race "${race.id}": course file not found: ${coursePath}`);
    }
    race.course = coursePath; // normalize to absolute for downstream loaders
  }
  return cfg;
}

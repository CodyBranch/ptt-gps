import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvent } from '../src/config/manager.js';
import { syncTargets } from '../src/api/meet-sync.js';

/**
 * The events a sending system can choose to sync into.
 *
 * The live feed announces only loaded events, so one prepared ahead of the
 * meet could not be picked from the desk. This listing is the whole library.
 */
const dirs: string[] = [];
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-targets-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const dated = (dir: string, file: string, start: string, extra: Record<string, unknown> = {}) => {
  const p = path.join(dir, file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...json, startDate: start, ...extra }, null, 2));
};

describe('events a desk can send into', () => {
  it('lists every event on disk, loaded or not, newest first', () => {
    const dir = scratch();
    dated(dir, createEvent(dir, { id: 'gans-2025', name: 'Gans Creek Classic', meetId: 8134 }), '2025-09-26');
    dated(dir, createEvent(dir, { id: 'gans-2026', name: 'Gans Creek Classic', meetId: 0 }), '2026-09-25', { externalId: 'nx-meet-1' });
    const out = syncTargets(dir, new Set(['gans-2025']));
    expect(out.map((e) => e.id)).toEqual(['gans-2026', 'gans-2025']);
    expect(out[0]).toMatchObject({ loaded: false, meetId: null, externalId: 'nx-meet-1', startDate: '2026-09-25' });
    expect(out[1]).toMatchObject({ loaded: true, meetId: 8134, externalId: null });
  });

  it('leaves out a file that will not parse', () => {
    const dir = scratch();
    createEvent(dir, { id: 'good', name: 'Good', meetId: 1 });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    expect(syncTargets(dir, new Set()).map((e) => e.id)).toEqual(['good']);
  });
});

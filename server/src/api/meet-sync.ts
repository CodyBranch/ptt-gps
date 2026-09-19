import express from 'express';
import path from 'node:path';
import type { AuthService } from './auth.js';
import { createEvent, listEvents, readCourseIn, saveCourseIn, ConfigManager, listCoursesIn } from '../config/manager.js';
import { EventSchema } from '../config/schema.js';
import { parseCourse } from '../engine/course.js';
import { planMeetSync, slugify, type SyncRequest } from '../sync/meet.js';
import type { App } from '../app.js';
import type { Store } from '../state/store.js';
import { syncCaller } from './sync-token.js';

/**
 * Taking a meet from another system - its races, their schedule, their courses
 * - and merging it into an event here.
 *
 * The point is to stop an operator re-keying a schedule that already exists
 * somewhere else on the morning of a meet. What it must never do is cost them
 * the half they cannot re-key quickly: the tracker roster, the vehicles, the
 * roles and their scoreboard slots. So the merge is additive (see sync/meet.ts)
 * and this module only handles what has to touch the disk - finding the event,
 * saving courses, writing the file the same way an operator edit does.
 */

interface SyncDeps {
  auth: AuthService;
  eventsDir: string;
  apps: Map<string, App>;
  configFor: (eventId: string) => { manager: ConfigManager; active: boolean };
  updateEvent: (eventId: string, json: unknown) => void;
  store: Store;
  /** Called after a real apply, so consoles see the new setup. */
  onApplied: () => void;
}

/** Coordinates rounded to ~10cm, which is far finer than a traced course. */
const fingerprint = (coords: number[][]): string =>
  coords.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(' ');

interface EventFile {
  id: string;
  name: string;
  file: string;
  externalId?: string;
  startDate?: string;
}

/** Every event on disk, with the external id it was last synced from. */
function eventFiles(dir: string): EventFile[] {
  const out: EventFile[] = [];
  for (const listed of listEvents(dir)) {
    if (listed.error) continue;
    try {
      const manager = new ConfigManager(path.join(dir, listed.file));
      out.push({
        id: manager.raw.id,
        name: manager.raw.name,
        file: listed.file,
        externalId: manager.raw.externalId,
        startDate: manager.raw.startDate,
      });
    } catch {
      // An event that will not parse cannot be a sync target either.
    }
  }
  return out;
}

export function registerMeetSync(ex: express.Express, deps: SyncDeps): void {
  const { auth, eventsDir, apps, configFor, updateEvent, store, onApplied } = deps;

  ex.post(
    '/api/sync/meet',
    // Courses travel as raw KML, which is large; the course upload route
    // allows the same.
    express.json({ limit: '25mb' }),
    (req, res) => {
      const caller = syncCaller(req, res, auth, 'setup');
      if (!caller) return;

      try {
        res.json(applySync(req.body as SyncRequest, deps, caller.row.label));
      } catch (err) {
        res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /** Everything after auth, so the happy path reads in one piece. */
  function applySync(request: SyncRequest, _deps: SyncDeps, by: string) {
    if (!request || typeof request !== 'object' || !request.event || typeof request.event.name !== 'string') {
      throw new Error('A meet needs at least event.name');
    }
    const dryRun = request.dryRun === true;

    // --- which event -------------------------------------------------------
    const known = eventFiles(eventsDir);
    let target =
      (request.event.id ? known.find((e) => e.id === request.event.id) : undefined) ??
      (request.event.externalId ? known.find((e) => e.externalId === request.event.externalId) : undefined);

    if (request.event.id && !target) {
      throw new Error(`No event here with the id "${request.event.id}"`);
    }

    const creating = !target;
    // Never matched on name alone: two meets a year apart share a name, and
    // merging into the wrong one is not something an operator can undo
    // quickly. They are offered as candidates so the link is made deliberately.
    const candidates = creating
      ? known
          .filter((e) => e.name.trim().toLowerCase() === request.event.name.trim().toLowerCase())
          .map((e) => ({ id: e.id, name: e.name, startDate: e.startDate ?? null }))
      : [];

    let eventId = target?.id ?? uniqueEventId(request.event.name, known);
    let file = target?.file ?? `${eventId}.json`;

    const current = target
      ? (configFor(target.id).manager.raw as unknown as Record<string, unknown>)
      : (EventSchema.parse({
          id: eventId,
          name: request.event.name,
          meetId: typeof request.event.meetId === 'number' ? request.event.meetId : 0,
          trackers: [],
          roles: [],
        }) as unknown as Record<string, unknown>);

    // --- courses -----------------------------------------------------------
    const { courseFiles, courseReports, courseWarnings } = resolveCourses(request, dryRun);

    // --- the merge ---------------------------------------------------------
    const app = target ? apps.get(target.id) : undefined;
    const runningRaceIds = new Set<string>();
    for (const [raceId, engine] of app?.engines ?? []) {
      if (engine.status === 'armed' || engine.status === 'live') runningRaceIds.add(raceId);
    }

    const plan = planMeetSync({ request, current, creating, courseFiles, runningRaceIds });
    const warnings = [...courseWarnings, ...plan.warnings];
    if (candidates.length > 0) {
      warnings.push(
        `A new event was ${dryRun ? 'planned' : 'created'} because nothing matched. ${candidates.length} existing event(s) share this name - link to one deliberately if that is what you meant.`,
      );
    }

    // --- write -------------------------------------------------------------
    if (!dryRun) {
      if (creating) {
        file = createEvent(eventsDir, {
          id: eventId,
          name: request.event.name,
          meetId: Number(plan.config.meetId) || 0,
        });
        eventId = String(plan.config.id ?? eventId);
      }
      const { manager, active } = configFor(eventId);
      // The same path an operator edit takes, so running engines are kept and
      // the rest rebuilt exactly as they would be from Setup.
      if (active) updateEvent(eventId, plan.config);
      else manager.update(plan.config);

      for (const c of courseReports) {
        if (c.action === 'created') store.noteCourseSeen(c.file, `sync:${by}`);
      }
      onApplied();
      console.log(
        `[sync] ${request.source ?? 'external'} ${plan.eventAction} "${eventId}" via token "${by}" ` +
          `(${plan.races.length} race(s), ${courseReports.length} course(s))`,
      );
    }

    return {
      ok: true,
      dryRun,
      event: { id: eventId, file, action: plan.eventAction, loaded: apps.has(eventId) },
      candidates,
      courses: courseReports,
      races: plan.races,
      untouched: plan.untouched,
      warnings,
    };
  }

  /** A slug nothing else on disk is using. */
  function uniqueEventId(name: string, known: EventFile[]): string {
    const base = slugify(name) || 'meet';
    const taken = new Set(known.map((e) => e.id));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 500; n++) {
      if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return `${base}-${Date.now()}`;
  }

  /**
   * Put each sent course into the library, reusing one that is already there.
   *
   * Courses outlive the events that use them and are shared between events, so
   * a re-sent meet must not litter the library with copies - and must never
   * overwrite a file another event is snapping to. Matching is on the geometry
   * rather than the name, because the same course arrives named differently
   * from one season to the next.
   */
  function resolveCourses(request: SyncRequest, dryRun: boolean) {
    const courseFiles = new Map<string, string>();
    const courseReports: Array<{ key: string; file: string; action: 'created' | 'reused' }> = [];
    const courseWarnings: string[] = [];

    const library = listCoursesIn(eventsDir);
    const claimed = new Set(library.map((c) => c.file));

    for (const incoming of request.courses ?? []) {
      if (!incoming?.key || typeof incoming.kml !== 'string' || incoming.kml.length === 0) {
        courseWarnings.push(`A course was sent with no KML and was ignored (${incoming?.key ?? 'no key'}).`);
        continue;
      }

      let parsed;
      try {
        parsed = parseCourse(incoming.kml, true, 'miles');
      } catch (err) {
        courseWarnings.push(
          `Course "${incoming.name ?? incoming.key}" could not be read: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      const wanted = fingerprint(parsed.line.geometry.coordinates as number[][]);

      const match = library.find((c) => {
        if (c.points !== parsed.line.geometry.coordinates.length) return false;
        try {
          const existing = parseCourse(readCourseIn(eventsDir, c.file), c.file.toLowerCase().endsWith('.kml'), 'miles');
          return fingerprint(existing.line.geometry.coordinates as number[][]) === wanted;
        } catch {
          return false;
        }
      });

      if (match) {
        courseFiles.set(incoming.key, match.file);
        courseReports.push({ key: incoming.key, file: match.file, action: 'reused' });
        continue;
      }

      // A free name, so an existing course with the same name keeps its file.
      const base = slugify(incoming.name ?? incoming.key) || 'course';
      let name = base;
      for (let n = 2; claimed.has(`courses/${name}.kml`); n++) name = `${base}-${n}`;
      const file = `courses/${name}.kml`;

      if (!dryRun) saveCourseIn(eventsDir, name, incoming.kml);
      claimed.add(file);
      courseFiles.set(incoming.key, file);
      courseReports.push({ key: incoming.key, file, action: 'created' });
    }

    return { courseFiles, courseReports, courseWarnings };
  }
}

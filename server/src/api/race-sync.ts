import express from 'express';
import type { AuthService } from './auth.js';
import type { App } from '../app.js';
import { planLifecycle, type LifecycleAction } from '../sync/lifecycle.js';
import { syncCaller } from './sync-token.js';

/**
 * Starting and finishing a race from the system that holds the gun.
 *
 * The timing system already knows when the race started and when the winner
 * crossed; having an operator here watch for both and press the same buttons a
 * second later is a job nobody needs. So it can push them.
 *
 * What "finish" means here is worth being explicit about, because it is not
 * what it means to the sender. A race is finished by GPS standards once first
 * place is home: the lead vehicle's job is over and it can be moved to the
 * next race. Runners are still on the course and the timing system is still
 * timing them. Nothing on this side reads a finish as "the results are final"
 * - it ends the GPS session and stops publishing distances, which is all it
 * has ever meant here.
 *
 * Arming and resetting stay with the operator at this console. They are how
 * the person watching the course says they are ready, and a machine cannot
 * see the course.
 */

interface LifecycleDeps {
  auth: AuthService;
  apps: Map<string, App>;
}

interface LifecycleBody {
  source?: string;
  eventId?: string;
  raceId?: string;
  externalId?: string;
  action?: string;
  atMs?: number;
  reason?: string;
}

export function registerRaceLifecycleSync(ex: express.Express, deps: LifecycleDeps): void {
  const { auth, apps } = deps;

  ex.post('/api/sync/lifecycle', express.json(), (req, res) => {
    const caller = syncCaller(req, res, auth, 'races');
    if (!caller) return;

    const body = (req.body ?? {}) as LifecycleBody;
    const action = body.action as LifecycleAction;
    if (action !== 'start' && action !== 'finish') {
      // Arming and resetting are deliberately not reachable from here.
      return void res.status(400).json({ ok: false, error: 'action must be "start" or "finish"' });
    }

    const app = body.eventId ? apps.get(body.eventId) : undefined;
    if (!app) {
      // Not 404: the event may well exist on disk. What it is not is open, and
      // that is something an operator here fixes in a second.
      return void res.status(409).json({
        ok: false,
        error: `Event "${body.eventId ?? ''}" is not open on this server`,
        status: null,
      });
    }

    // The race id from the setup push is the usual key; the sender's own id is
    // accepted too, so a sender that never stored ours can still drive a race.
    let raceId = body.raceId && app.engines.has(body.raceId) ? body.raceId : undefined;
    if (!raceId && body.externalId) {
      raceId = app.cfg.races.find((r) => r.externalId === body.externalId)?.id;
    }
    const engine = raceId ? app.engines.get(raceId) : undefined;
    if (!engine || !raceId) {
      return void res.status(404).json({
        ok: false,
        error: `No race "${body.raceId ?? body.externalId ?? ''}" in "${body.eventId}"`,
      });
    }

    const decision = planLifecycle(action, engine.status, body.atMs, Date.now());
    if (decision.error) {
      return void res
        .status(decision.status ?? 409)
        .json({ ok: false, error: decision.error, status: engine.status });
    }

    if (decision.unchanged) {
      return void res.json({
        ok: true,
        status: engine.status,
        sessionId: app.sessions.get(raceId) ?? null,
        unchanged: true,
      });
    }

    // The label the operator here gave the token, so the race timeline names
    // the system that did this rather than whoever happens to be logged in.
    const by = caller.row.label;
    // Read before applying: a finish closes the session and drops it from the
    // map, and the id of the session this call ended is the useful one to hand
    // back - it is what the sender would store against its own race.
    const sessionBefore = app.sessions.get(raceId) ?? null;
    try {
      const status = app.lifecycle(raceId, action, body.atMs, by);
      console.log(
        `[sync] ${body.source ?? 'external'} ${action} "${body.eventId}/${raceId}" ` +
          `at ${new Date(Number(body.atMs)).toISOString()} via token "${by}"` +
          (body.reason ? ` (${body.reason})` : ''),
      );
      res.json({ ok: true, status, sessionId: app.sessions.get(raceId) ?? sessionBefore });
    } catch (err) {
      res.status(409).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: engine.status,
      });
    }
  });
}

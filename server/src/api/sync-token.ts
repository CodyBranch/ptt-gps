import type express from 'express';
import type { AuthService } from './auth.js';
import type { FeedTokenRow } from '../state/store.js';

/**
 * The bearer token on a machine-to-machine sync request, and what it may do.
 *
 * The same tokens that read the live feed, with capabilities granted one at a
 * time in the console. Reading races out, building a meet, and running one are
 * three different jobs - the console already draws that line between an admin
 * and a staff login - so they are three different grants, and a token starts
 * with none of them.
 *
 * The refusal sentences are part of the published contract: senders show them
 * to their own operator, who is usually not the person who can fix it.
 */

export type SyncCapability = 'setup' | 'races';

const REFUSAL: Record<SyncCapability, string> = {
  setup: 'this token cannot write setup',
  races: 'this token cannot run races',
};

export interface SyncCaller {
  row: FeedTokenRow;
  /** The IP, for the token's last-used record. */
  ip: string;
}

export function bearer(req: express.Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Resolve and check the caller, answering the request itself if it fails.
 * Returns undefined once a refusal has been sent.
 */
export function syncCaller(
  req: express.Request,
  res: express.Response,
  auth: AuthService,
  capability: SyncCapability,
): SyncCaller | undefined {
  const ip = (req.socket.remoteAddress ?? '?').replace('::ffff:', '');
  const token = bearer(req);
  const row = token ? auth.feedTokenRow(token) : undefined;
  if (!row) {
    res.status(401).json({ ok: false, error: 'unknown or disabled token' });
    return undefined;
  }
  const allowed = capability === 'setup' ? row.can_write_setup : row.can_run_races;
  if (!allowed) {
    res.status(403).json({ ok: false, error: REFUSAL[capability] });
    return undefined;
  }
  auth.noteFeedTokenUse(row.id, ip);
  return { row, ip };
}

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Store } from '../state/store.js';

/**
 * Console authentication.
 *
 * - Users live in SQLite with scrypt password hashes (managed via the user CLI:
 *   `npm run user -w server -- add <name>`).
 * - Login issues a random token in an HttpOnly cookie; only the token's SHA-256
 *   lands in the DB, and tokens survive server restarts so a race-morning
 *   restart never logs the crew out.
 * - The same check guards REST (middleware) and socket.io (handshake).
 * - Set PTT_AUTH_DISABLED=1 to bypass entirely (local dev / simulators only).
 */

const COOKIE_NAME = 'ptt_auth';
const TOKEN_TTL_MS = 7 * 24 * 3600_000;
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, saltHex, hashHex] = stored.split(':');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

interface Attempts { fails: number; lockedUntil: number }

/**
 * Permission levels:
 *  - admin:  everything, including setup (users, fleet, firebase, tunnel,
 *            events, config, viewer PIN)
 *  - staff:  race operations (lifecycle, failover, windows, publishing) and
 *            read access to everything
 *  - viewer: read-only (shared PIN)
 */
export type Role = 'admin' | 'staff' | 'viewer';
export interface AuthContext {
  username: string;
  role: Role;
  /** Viewer PIN scope: undefined = global (all events), else that event only. */
  eventScope?: string;
}

const VIEWER_PIN_KEY = 'viewer-pin-hash';

export class AuthService {
  readonly disabled = process.env.PTT_AUTH_DISABLED === '1';
  private attempts = new Map<string, Attempts>();

  constructor(private store: Store) {
    if (this.disabled) console.warn('[auth] PTT_AUTH_DISABLED=1 — console is OPEN, dev use only');
    else if (store.listUsers().length === 0) {
      console.warn('[auth] no users exist — create one with: npm run user -w server -- add <name>');
    }
  }

  /** Returns a fresh token on success, null on bad credentials or lockout. */
  login(username: string, password: string, ip: string): string | null {
    const a = this.attempts.get(ip);
    if (a && a.lockedUntil > Date.now()) return null;

    const user = this.store.getUser(username);
    const ok = user !== undefined && verifyPassword(password, user.password_hash);
    if (!ok) {
      const next: Attempts = { fails: (a?.fails ?? 0) + 1, lockedUntil: 0 };
      if (next.fails >= 5) {
        next.lockedUntil = Date.now() + 30_000;
        next.fails = 0;
      }
      this.attempts.set(ip, next);
      return null;
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    this.store.insertToken(sha256(token), username, Date.now() + TOKEN_TTL_MS);
    return token;
  }

  private eventPinKey(eventId: string): string {
    return `${VIEWER_PIN_KEY}:${eventId}`;
  }

  /**
   * PIN entry for view-only access. The global PIN sees every active event;
   * a per-event PIN is scoped to that event only. Rate-limited with the same
   * per-IP lockout as password login.
   */
  loginViewer(pin: string, ip: string): { token: string; eventScope?: string } | null {
    const a = this.attempts.get(ip);
    if (a && a.lockedUntil > Date.now()) return null;

    let scope: string | undefined | false = false;
    const global = this.store.getSetting(VIEWER_PIN_KEY);
    if (global !== undefined && verifyPassword(pin, global)) {
      scope = undefined; // global access
    } else {
      for (const row of this.store.listSettingsByPrefix(`${VIEWER_PIN_KEY}:`)) {
        if (verifyPassword(pin, row.value)) {
          scope = row.key.slice(VIEWER_PIN_KEY.length + 1);
          break;
        }
      }
    }
    if (scope === false) {
      const next: Attempts = { fails: (a?.fails ?? 0) + 1, lockedUntil: 0 };
      if (next.fails >= 5) {
        next.lockedUntil = Date.now() + 30_000;
        next.fails = 0;
      }
      this.attempts.set(ip, next);
      return null;
    }
    this.attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    // Scope rides in the token's username: 'viewer' or 'viewer:<eventId>'.
    this.store.insertToken(sha256(token), scope ? `viewer:${scope}` : 'viewer', Date.now() + TOKEN_TTL_MS, 'viewer');
    return { token, eventScope: scope };
  }

  viewerPinEnabled(eventId?: string): boolean {
    if (eventId !== undefined) return this.store.getSetting(this.eventPinKey(eventId)) !== undefined;
    return this.store.getSetting(VIEWER_PIN_KEY) !== undefined;
  }

  /** Any PIN configured at all (login screen shows the viewer option). */
  anyViewerPinEnabled(): boolean {
    return this.viewerPinEnabled() || this.store.listSettingsByPrefix(`${VIEWER_PIN_KEY}:`).length > 0;
  }

  /**
   * Machine token for external data feeds (e.g. the NYC split-time distance
   * source). Compared in constant time; managed by admins in Setup.
   */
  ingestTokenValid(token: string): boolean {
    const stored = this.store.getSetting('ingest-token');
    if (!stored || token.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(stored));
  }

  ingestToken(): string | undefined {
    return this.store.getSetting('ingest-token');
  }

  regenerateIngestToken(): string {
    const token = crypto.randomBytes(24).toString('hex');
    this.store.setSetting('ingest-token', token);
    return token;
  }

  /**
   * Set (or clear with null) a viewer PIN — global, or scoped to one event.
   * A PIN may not duplicate the global PIN or another scope's PIN (login would
   * be ambiguous — and a global PIN already covers every event). All viewer
   * sessions are revoked on any change.
   */
  setViewerPin(pin: string | null, eventId?: string): void {
    const key = eventId !== undefined ? this.eventPinKey(eventId) : VIEWER_PIN_KEY;
    if (pin === null) {
      this.store.deleteSetting(key);
    } else {
      const global = this.store.getSetting(VIEWER_PIN_KEY);
      if (eventId !== undefined && global !== undefined && verifyPassword(pin, global)) {
        throw new Error('That PIN is already the global viewer PIN — it already works for this event');
      }
      for (const row of this.store.listSettingsByPrefix(`${VIEWER_PIN_KEY}:`)) {
        if (row.key === key) continue;
        if (verifyPassword(pin, row.value)) {
          throw new Error(`That PIN is already used by event "${row.key.slice(VIEWER_PIN_KEY.length + 1)}"`);
        }
      }
      this.store.setSetting(key, hashPassword(pin));
    }
    this.store.deleteTokensByRole('viewer');
  }

  logout(token: string | undefined): void {
    if (token) this.store.deleteToken(sha256(token));
  }

  /**
   * Auth context for a valid token, extending its life when past halfway.
   * User roles are resolved live from the users table, so a level change
   * applies to existing sessions immediately.
   */
  check(token: string | undefined): AuthContext | null {
    if (this.disabled) return { username: 'dev', role: 'admin' };
    if (!token) return null;
    const row = this.store.getToken(sha256(token));
    if (!row || row.expires_at_ms < Date.now()) return null;
    if (row.expires_at_ms - Date.now() < TOKEN_TTL_MS / 2) {
      this.store.touchToken(sha256(token), Date.now() + TOKEN_TTL_MS);
    }
    if (row.role === 'viewer') {
      const eventScope = row.username.startsWith('viewer:') ? row.username.slice('viewer:'.length) : undefined;
      return { username: 'viewer', role: 'viewer', eventScope };
    }
    const user = this.store.getUser(row.username);
    if (!user) return null; // account was removed
    return { username: row.username, role: user.role === 'admin' ? 'admin' : 'staff' };
  }

  tokenFromRequest(req: { headers: Record<string, unknown> }): string | undefined {
    return parseCookies(req.headers['cookie'] as string | undefined)[COOKIE_NAME];
  }

  cookie(token: string): string {
    // No Secure flag yet — the box serves plain HTTP; add it with TLS.
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}`;
  }

  clearCookie(): string {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }

  /**
   * Express middleware guarding everything registered after it.
   * Viewer tokens are read-only at the API level — any non-GET request is
   * refused server-side, so hiding buttons in the UI is cosmetic, not the lock.
   */
  middleware = (
    req: Request & { operator?: string; role?: Role; eventScope?: string },
    res: Response,
    next: NextFunction,
  ): void => {
    const auth = this.check(this.tokenFromRequest(req));
    if (!auth) {
      res.status(401).json({ ok: false, error: 'not authenticated' });
      return;
    }
    if (auth.role === 'viewer' && req.method !== 'GET') {
      res.status(403).json({ ok: false, error: 'view-only access' });
      return;
    }
    // Event-scoped viewers may only read the state snapshot (filtered by the
    // route) and their own event's course geometry.
    if (auth.role === 'viewer' && auth.eventScope !== undefined) {
      const ok =
        req.path === '/state' ||
        new RegExp(`^/events/${auth.eventScope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/races/[^/]+/course$`).test(req.path);
      if (!ok) {
        res.status(403).json({ ok: false, error: 'access limited to your event' });
        return;
      }
    }
    req.operator = auth.username;
    req.role = auth.role;
    req.eventScope = auth.eventScope;
    next();
  };

  /** Route guard for admin-only endpoints — register after `middleware`. */
  adminOnly = (req: Request & { role?: Role }, res: Response, next: NextFunction): void => {
    if (req.role !== 'admin') {
      res.status(403).json({ ok: false, error: 'admin access required' });
      return;
    }
    next();
  };
}

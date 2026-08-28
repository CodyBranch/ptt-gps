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

  logout(token: string | undefined): void {
    if (token) this.store.deleteToken(sha256(token));
  }

  /** Username for a valid token, extending its life when past halfway. */
  check(token: string | undefined): string | null {
    if (this.disabled) return 'dev';
    if (!token) return null;
    const row = this.store.getToken(sha256(token));
    if (!row || row.expires_at_ms < Date.now()) return null;
    if (row.expires_at_ms - Date.now() < TOKEN_TTL_MS / 2) {
      this.store.touchToken(sha256(token), Date.now() + TOKEN_TTL_MS);
    }
    return row.username;
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

  /** Express middleware guarding everything registered after it. */
  middleware = (req: Request & { operator?: string }, res: Response, next: NextFunction): void => {
    const user = this.check(this.tokenFromRequest(req));
    if (!user) {
      res.status(401).json({ ok: false, error: 'not authenticated' });
      return;
    }
    req.operator = user;
    next();
  };
}

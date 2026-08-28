import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, hashPassword, verifyPassword } from '../src/api/auth.js';
import { Store } from '../src/state/store.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces unique salts', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'));
  });
});

describe('AuthService', () => {
  let dir: string;
  let store: Store;
  let auth: AuthService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-auth-'));
    store = new Store(path.join(dir, 'test.db'));
    store.addUser('cody', hashPassword('timing-rules-8'));
    auth = new AuthService(store);
  });

  afterEach(() => {
    store.close();
  });

  it('login → check → logout round trip', () => {
    const token = auth.login('cody', 'timing-rules-8', '10.0.0.1');
    expect(token).toBeTruthy();
    expect(auth.check(token!)).toBe('cody');
    auth.logout(token!);
    expect(auth.check(token!)).toBeNull();
  });

  it('rejects bad credentials and unknown users', () => {
    expect(auth.login('cody', 'nope', '10.0.0.1')).toBeNull();
    expect(auth.login('ghost', 'timing-rules-8', '10.0.0.1')).toBeNull();
  });

  it('rejects garbage tokens', () => {
    expect(auth.check(undefined)).toBeNull();
    expect(auth.check('deadbeef')).toBeNull();
  });

  it('locks out an IP after 5 failures, then recovers', () => {
    for (let i = 0; i < 5; i++) auth.login('cody', 'wrong', '10.9.9.9');
    // locked: even the right password fails from this IP
    expect(auth.login('cody', 'timing-rules-8', '10.9.9.9')).toBeNull();
    // other IPs unaffected
    expect(auth.login('cody', 'timing-rules-8', '10.0.0.2')).toBeTruthy();
  });

  it('tokens survive an AuthService restart (server restart mid-race)', () => {
    const token = auth.login('cody', 'timing-rules-8', '10.0.0.1');
    const auth2 = new AuthService(store);
    expect(auth2.check(token!)).toBe('cody');
  });

  it('removing a user revokes their tokens', () => {
    const token = auth.login('cody', 'timing-rules-8', '10.0.0.1');
    store.deleteUser('cody');
    expect(auth.check(token!)).toBeNull();
  });

  it('parses the auth cookie from request headers', () => {
    const token = auth.login('cody', 'timing-rules-8', '10.0.0.1')!;
    const header = auth.cookie(token).split(';')[0];
    expect(auth.tokenFromRequest({ headers: { cookie: `other=1; ${header}` } })).toBe(token);
  });
});

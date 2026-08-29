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
    expect(auth.check(token!)).toEqual({ username: 'cody', role: 'staff' });
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
    expect(auth2.check(token!)).toEqual({ username: 'cody', role: 'staff' });
  });

  it('viewer PIN: disabled until set, grants viewer role, revoked on change', () => {
    expect(auth.viewerPinEnabled()).toBe(false);
    expect(auth.loginViewer('260426', '10.1.1.1')).toBeNull();

    auth.setViewerPin('260426');
    expect(auth.viewerPinEnabled()).toBe(true);
    expect(auth.loginViewer('999999', '10.1.1.2')).toBeNull();
    const token = auth.loginViewer('260426', '10.1.1.3');
    expect(auth.check(token!)).toEqual({ username: 'viewer', role: 'viewer' });

    // replacing the PIN signs existing viewers out; operators unaffected
    const opToken = auth.login('cody', 'timing-rules-8', '10.0.0.1');
    auth.setViewerPin('111111');
    expect(auth.check(token!)).toBeNull();
    expect(auth.check(opToken!)?.role).toBe('staff');

    // clearing disables viewer login entirely
    auth.setViewerPin(null);
    expect(auth.viewerPinEnabled()).toBe(false);
    expect(auth.loginViewer('111111', '10.1.1.4')).toBeNull();
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

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
    const res = auth.loginViewer('260426', '10.1.1.3');
    expect(res?.eventScope).toBeUndefined(); // global PIN = all events
    expect(auth.check(res!.token)).toEqual({ username: 'viewer', role: 'viewer', eventScope: undefined });

    // replacing the PIN signs existing viewers out; operators unaffected
    const opToken = auth.login('cody', 'timing-rules-8', '10.0.0.1');
    auth.setViewerPin('111111');
    expect(auth.check(res!.token)).toBeNull();
    expect(auth.check(opToken!)?.role).toBe('staff');

    // clearing disables viewer login entirely
    auth.setViewerPin(null);
    expect(auth.viewerPinEnabled()).toBe(false);
    expect(auth.loginViewer('111111', '10.1.1.4')).toBeNull();
  });

  it('event-scoped viewer PINs: scope, no duplication with global or other events', () => {
    auth.setViewerPin('260426'); // global
    auth.setViewerPin('111111', 'boston-2026');

    // event PIN duplicating the global PIN is refused
    expect(() => auth.setViewerPin('260426', 'other-event')).toThrow(/already the global/);
    // another event duplicating an existing event PIN is refused
    expect(() => auth.setViewerPin('111111', 'other-event')).toThrow(/already used by event/);
    // global PIN duplicating an event PIN is refused
    expect(() => auth.setViewerPin('111111')).toThrow(/already used by event/);

    const scoped = auth.loginViewer('111111', '10.2.2.2');
    expect(scoped?.eventScope).toBe('boston-2026');
    expect(auth.check(scoped!.token)).toEqual({ username: 'viewer', role: 'viewer', eventScope: 'boston-2026' });

    const global = auth.loginViewer('260426', '10.2.2.3');
    expect(global?.eventScope).toBeUndefined();

    // removing the event PIN keeps global working
    auth.setViewerPin(null, 'boston-2026');
    expect(auth.loginViewer('111111', '10.2.2.4')).toBeNull();
    expect(auth.loginViewer('260426', '10.2.2.5')).toBeTruthy();
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

describe('a board opening itself', () => {
  let dir: string;
  let store: Store;
  let auth: AuthService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-board-'));
    store = new Store(path.join(dir, 'test.db'));
    auth = new AuthService(store);
  });

  afterEach(() => {
    store.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the same key once issued', () => {
    const key = auth.boardKey('lakefront');
    expect(key.length).toBeGreaterThan(20);
    expect(auth.boardKey('lakefront')).toBe(key);
  });

  it('gives each event its own', () => {
    expect(auth.boardKey('lakefront')).not.toBe(auth.boardKey('gans-creek'));
  });

  it('trades a key for a session scoped to that event and nothing else', () => {
    const key = auth.boardKey('lakefront');
    const token = auth.loginBoard('lakefront', key, '10.0.0.9');
    expect(token).toBeTruthy();
    const who = auth.check(token!);
    expect(who).toEqual({ username: 'viewer', role: 'viewer', eventScope: 'lakefront' });
  });

  it('refuses the wrong key, an unknown event, and another event’s key', () => {
    const key = auth.boardKey('lakefront');
    auth.boardKey('gans-creek');
    expect(auth.loginBoard('lakefront', 'nope', '10.0.0.1')).toBeNull();
    expect(auth.loginBoard('never-heard-of-it', key, '10.0.0.2')).toBeNull();
    expect(auth.loginBoard('gans-creek', key, '10.0.0.3')).toBeNull();
  });

  it('locks an address out after five tries, so the key cannot be asked for', () => {
    const key = auth.boardKey('lakefront');
    for (let i = 0; i < 5; i++) expect(auth.loginBoard('lakefront', `guess-${i}`, '10.0.0.4')).toBeNull();
    // Right key, wrong moment.
    expect(auth.loginBoard('lakefront', key, '10.0.0.4')).toBeNull();
    // Someone else is unaffected.
    expect(auth.loginBoard('lakefront', key, '10.0.0.5')).toBeTruthy();
  });

  it('stops every link already handed out when the key is rotated', () => {
    const old = auth.boardKey('lakefront');
    const fresh = auth.rotateBoardKey('lakefront');
    expect(fresh).not.toBe(old);
    expect(auth.loginBoard('lakefront', old, '10.0.0.6')).toBeNull();
    expect(auth.loginBoard('lakefront', fresh, '10.0.0.7')).toBeTruthy();
  });

  it('refuses a key of the wrong length without comparing it', () => {
    auth.boardKey('lakefront');
    expect(auth.loginBoard('lakefront', '', '10.0.0.8')).toBeNull();
    expect(auth.loginBoard('lakefront', 'x'.repeat(200), '10.0.0.8')).toBeNull();
  });
});

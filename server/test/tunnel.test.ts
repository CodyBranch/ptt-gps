import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TunnelManager } from '../src/api/tunnel.js';
import { Store } from '../src/state/store.js';

/**
 * Remote access coming back on its own.
 *
 * The tunnel used to get exactly one attempt, taken while the service was
 * starting - which on a box that reboots is often before its network is up.
 * One lost race and remote access stayed off until somebody noticed and went
 * to Setup. These are about it trying again.
 */

let dir: string;
let store: Store;

/** A stand-in listener, and a handle on the status callback ngrok would call. */
function fakeListener(url = 'https://ptt-gps.ngrok.app') {
  return { url: () => url, close: vi.fn(async () => {}) };
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-tunnel-'));
  store = new Store(path.join(dir, 'test.db'));
  store.setSetting('ngrok-enabled', '1');
  store.setSetting('ngrok-authtoken', 'tok_test');
});

afterEach(() => {
  vi.useRealTimers();
  store.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bringing the tunnel up', () => {
  it('reports online, with the URL, once it connects', async () => {
    const forward = vi.fn(async () => fakeListener() as never);
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    expect(t.status()).toMatchObject({ state: 'online', url: 'https://ptt-gps.ngrok.app', attempts: 0 });
  });

  it('does not try at all without a token, and says so', async () => {
    store.deleteSetting('ngrok-authtoken');
    const forward = vi.fn();
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    expect(forward).not.toHaveBeenCalled();
    expect(t.status().state).toBe('error');
    expect(t.status().error).toMatch(/authtoken/i);
  });
});

describe('a connect that fails', () => {
  it('tries again instead of giving up', async () => {
    const forward = vi
      .fn()
      .mockRejectedValueOnce(new Error('dial tcp: lookup connect.ngrok-agent.com: no such host'))
      .mockResolvedValue(fakeListener() as never);
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    expect(t.status()).toMatchObject({ state: 'error', attempts: 1 });
    expect(t.status().error).toMatch(/no such host/);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(t.status()).toMatchObject({ state: 'online', attempts: 0 });
  });

  it('backs off, and does not run away', async () => {
    const forward = vi.fn().mockRejectedValue(new Error('refused'));
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();

    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = t.status().retryAtMs!;
      waits.push(before - Date.now());
      await vi.advanceTimersByTimeAsync(before - Date.now());
    }
    expect(waits.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    // Capped, so a box left offline overnight is not hammering it.
    expect(Math.max(...waits)).toBeLessThanOrEqual(5 * 60_000);
    expect(t.status().attempts).toBe(9);
  });

  it('stops retrying the moment remote access is switched off', async () => {
    const forward = vi.fn().mockRejectedValue(new Error('refused'));
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    expect(forward).toHaveBeenCalledTimes(1);

    store.setSetting('ngrok-enabled', '0');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('drops a pending retry when stopped', async () => {
    const forward = vi.fn().mockRejectedValue(new Error('refused'));
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    await t.stop();
    expect(t.status()).toMatchObject({ state: 'off', attempts: 0, retryAtMs: undefined });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

describe('a session that drops after it was up', () => {
  /** Connect, and hand back the status callback ngrok was given. */
  async function connected() {
    let onStatus: ((s: string) => void) | undefined;
    const forward = vi.fn(async (opts: { onStatusChange?: (s: string) => void }) => {
      onStatus = opts.onStatusChange;
      return fakeListener() as never;
    });
    const t = new TunnelManager(store, 8080, forward as never);
    await t.start();
    return { t, forward, status: (s: string) => onStatus!(s) };
  }

  it('no longer claims to be online when the connection is gone', async () => {
    const { t, status } = await connected();
    expect(t.status().state).toBe('online');
    status('closed');
    // This is the bug that made the state untrustworthy: it read "online" for
    // as long as the process lived, whatever had happened underneath.
    expect(t.status().state).toBe('connecting');
    expect(t.status().error).toMatch(/lost/i);
  });

  it('goes back to online when the library reconnects, and rebuilds nothing', async () => {
    const { t, forward, status } = await connected();
    status('closed');
    status('connected');
    expect(t.status()).toMatchObject({ state: 'online', error: undefined });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it('builds a new listener when it has stayed down too long', async () => {
    const { t, forward, status } = await connected();
    status('closed');
    await vi.advanceTimersByTimeAsync(119_000);
    expect(forward).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(forward).toHaveBeenCalledTimes(2);
    expect(t.status().state).toBe('online');
  });
});

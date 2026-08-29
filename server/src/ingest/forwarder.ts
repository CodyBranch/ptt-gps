import net from 'node:net';
import type { Store } from '../state/store.js';

/**
 * Live ping forwarding: every raw frame received from the trackers (and from
 * simulations hitting our listener) is mirrored, byte for byte, to other
 * systems — the same pattern as the Franklin-GPS mirror, with us as the
 * source. This is also the tee for parallel-running the legacy stack: point
 * a forward at it and both systems see identical traffic.
 *
 * One-way, per-target auto-reconnect with backoff, frames dropped (and
 * counted) while a target is down — a dead consumer must never block ingest.
 */

export interface ForwardTarget {
  host: string;
  port: number;
  enabled: boolean;
}

export interface ForwardStatus extends ForwardTarget {
  connected: boolean;
  sent: number;
  dropped: number;
  error?: string;
}

const SETTING_KEY = 'forward-targets';
const RECONNECT_MS = 5000;

interface Conn {
  target: ForwardTarget;
  sock?: net.Socket;
  connected: boolean;
  sent: number;
  dropped: number;
  error?: string;
  timer?: NodeJS.Timeout;
  closed: boolean;
}

export class Forwarder {
  private conns: Conn[] = [];

  constructor(private store: Store) {
    this.reconcile(this.targets());
  }

  targets(): ForwardTarget[] {
    try {
      const raw = this.store.getSetting(SETTING_KEY);
      return raw ? (JSON.parse(raw) as ForwardTarget[]) : [];
    } catch {
      return [];
    }
  }

  setTargets(targets: ForwardTarget[]): void {
    for (const t of targets) {
      if (!t.host || typeof t.host !== 'string') throw new Error('Forward target host is required');
      if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new Error(`Invalid port for ${t.host}`);
    }
    this.store.setSetting(SETTING_KEY, JSON.stringify(targets.map((t) => ({ host: t.host, port: t.port, enabled: !!t.enabled }))));
    this.reconcile(targets);
  }

  /** Mirror one raw frame to every connected target. */
  write(data: string | Buffer): void {
    for (const c of this.conns) {
      if (!c.target.enabled) continue;
      if (c.connected && c.sock) {
        c.sock.write(data);
        c.sent++;
      } else {
        c.dropped++;
      }
    }
  }

  status(): ForwardStatus[] {
    return this.conns.map((c) => ({
      ...c.target,
      connected: c.connected,
      sent: c.sent,
      dropped: c.dropped,
      error: c.error,
    }));
  }

  private reconcile(targets: ForwardTarget[]): void {
    const keep = new Set(targets.map((t) => `${t.host}:${t.port}`));
    for (const c of this.conns) {
      if (!keep.has(`${c.target.host}:${c.target.port}`)) this.teardown(c);
    }
    this.conns = this.conns.filter((c) => keep.has(`${c.target.host}:${c.target.port}`));
    for (const t of targets) {
      const existing = this.conns.find((c) => c.target.host === t.host && c.target.port === t.port);
      if (existing) {
        const wasEnabled = existing.target.enabled;
        existing.target = t;
        if (t.enabled && !wasEnabled) this.connect(existing);
        if (!t.enabled && wasEnabled) this.disconnect(existing);
      } else {
        const conn: Conn = { target: t, connected: false, sent: 0, dropped: 0, closed: false };
        this.conns.push(conn);
        if (t.enabled) this.connect(conn);
      }
    }
  }

  private connect(c: Conn): void {
    if (c.closed || !c.target.enabled) return;
    const sock = net.connect(c.target.port, c.target.host, () => {
      c.connected = true;
      c.error = undefined;
      console.log(`[forward] connected → ${c.target.host}:${c.target.port}`);
    });
    c.sock = sock;
    const retry = () => {
      c.connected = false;
      c.sock = undefined;
      sock.destroy();
      if (!c.closed && c.target.enabled && !c.timer) {
        c.timer = setTimeout(() => {
          c.timer = undefined;
          this.connect(c);
        }, RECONNECT_MS);
      }
    };
    sock.on('error', (err) => {
      c.error = err.message;
      retry();
    });
    sock.on('close', () => retry());
  }

  private disconnect(c: Conn): void {
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = undefined;
    }
    c.sock?.destroy();
    c.sock = undefined;
    c.connected = false;
  }

  private teardown(c: Conn): void {
    c.closed = true;
    this.disconnect(c);
  }
}

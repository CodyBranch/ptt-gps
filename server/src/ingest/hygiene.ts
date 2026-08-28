import type { Fix } from './types.js';

export interface GateResult {
  ok: boolean;
  reason?: 'no-fix' | 'bad-coords' | 'stale' | 'too-old' | 'future';
}

export interface GateOptions {
  /** Reject fixes older than this (history-flood guard). Default 6h. */
  maxAgeMs?: number;
  /** Reject fixes this far in the future (bad clock guard). Default 5min. */
  maxFutureMs?: number;
}

interface ImeiState {
  lastAcceptedT: number;
  gapsDetected: number;
  lastCountNumber?: number;
  rejected: Record<string, number>;
}

/**
 * Per-tracker gate between parsing and the live engine.
 *
 * Everything that reaches this gate is already stored to the fix log (replay
 * keeps the full record, ordered by GPS time) — the gate only decides what the
 * live engine may consume:
 *  - no live GNSS fix → device is repeating last-known coordinates
 *  - out of chronological order → buffered backlog arriving after newer
 *    real-time frames (RPS=1 sends current position first)
 *  - far in the past → first-connect history flood (units dump storage since
 *    manufacture, dates back to 2009)
 */
export class FixGate {
  private perImei = new Map<string, ImeiState>();
  private maxAgeMs: number;
  private maxFutureMs: number;

  constructor(opts: GateOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 3600_000;
    this.maxFutureMs = opts.maxFutureMs ?? 5 * 60_000;
  }

  private state(imei: string): ImeiState {
    let s = this.perImei.get(imei);
    if (!s) {
      s = { lastAcceptedT: 0, gapsDetected: 0, rejected: {} };
      this.perImei.set(imei, s);
    }
    return s;
  }

  accept(fix: Fix): GateResult {
    const s = this.state(fix.imei);

    // Count-number gap detection runs on every frame, accepted or not —
    // a gap means frames were lost upstream (cellular or mirror drop).
    if (fix.countNumber !== undefined) {
      if (s.lastCountNumber !== undefined) {
        const delta = (fix.countNumber - s.lastCountNumber + 0x10000) % 0x10000;
        if (delta > 1 && delta < 0x8000) s.gapsDetected += delta - 1;
      }
      s.lastCountNumber = fix.countNumber;
    }

    const reject = (reason: NonNullable<GateResult['reason']>): GateResult => {
      s.rejected[reason] = (s.rejected[reason] ?? 0) + 1;
      return { ok: false, reason };
    };

    if (!fix.fixValid) return reject('no-fix');
    if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || (fix.lat === 0 && fix.lon === 0)) {
      return reject('bad-coords');
    }
    if (!Number.isFinite(fix.tUtcMs) || fix.tUtcMs <= 0) return reject('too-old');
    if (fix.tUtcMs < fix.receivedAtMs - this.maxAgeMs) return reject('too-old');
    if (fix.tUtcMs > fix.receivedAtMs + this.maxFutureMs) return reject('future');
    if (fix.tUtcMs <= s.lastAcceptedT) return reject('stale');

    s.lastAcceptedT = fix.tUtcMs;
    return { ok: true };
  }

  health(imei: string): { gapsDetected: number; rejected: Record<string, number> } {
    const s = this.perImei.get(imei);
    return { gapsDetected: s?.gapsDetected ?? 0, rejected: s?.rejected ?? {} };
  }

  /** Forget chronological state for a tracker (e.g. device clock was reset). */
  reset(imei: string): void {
    this.perImei.delete(imei);
  }
}

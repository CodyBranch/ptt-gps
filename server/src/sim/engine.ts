import net from 'node:net';
import * as turf from '@turf/turf';

/**
 * Shared race simulation engine: moves simulated trackers along a course and
 * streams real GTFRI packets over TCP — exercising the entire live pipeline
 * (framer → parser → hygiene → snap engine → outputs).
 *
 * Used by the console's Sim panel (targeting the server's own listener) and by
 * the CLI (targeting any host, e.g. the production box from a laptop, using an
 * exported sim package).
 *
 * Timing model: distance comes from elapsed real time × timescale, timestamps
 * are wall clock, and the send cadence is clamped to ≥1s per tracker so the
 * hygiene gate's per-second chronology accepts every ping even at high
 * timescales.
 */

export interface SimTrackerCfg {
  imei: string;
  label: string;
  /** Ground speed in mph (12 ≈ 5:00/mi runner; 20–30 for a lead vehicle). */
  paceMph: number;
  /** Start offset in miles (negative = starts behind the line). */
  startOffsetMi: number;
  battery?: number;
}

export interface SimOptions {
  host: string;
  port: number;
  /** Course path as [lon, lat] pairs. */
  courseCoords: [number, number][];
  trackers: SimTrackerCfg[];
  /** Simulated seconds between reports per tracker (device cadence). */
  intervalS: number;
  /** Race-time speedup: 1 = real time, 30 = 30× faster. */
  timescale: number;
  /** GPS noise in meters. */
  jitterM: number;
}

export interface SimTrackerProgress {
  imei: string;
  label: string;
  distanceMi: number;
  battery: number;
  done: boolean;
}

export interface SimProgress {
  running: boolean;
  startedAtMs: number | null;
  elapsedRealS: number;
  elapsedSimS: number;
  courseMi: number;
  timescale: number;
  trackers: SimTrackerProgress[];
  error?: string;
}

interface SimTrackerState extends SimTrackerCfg {
  battery: number;
  count: number;
  distanceMi: number;
  lastSentMs: number;
}

export class SimEngine {
  private opts: SimOptions;
  private sock?: net.Socket;
  private timer?: NodeJS.Timeout;
  private line: ReturnType<typeof turf.lineString>;
  private courseMi: number;
  private states: SimTrackerState[];
  private startedAtMs: number | null = null;
  private lastError?: string;
  private onProgress?: (p: SimProgress) => void;
  private onEnd?: (reason: string) => void;

  constructor(opts: SimOptions, hooks?: { onProgress?: (p: SimProgress) => void; onEnd?: (reason: string) => void }) {
    if (opts.courseCoords.length < 2) throw new Error('Course has no coordinates');
    if (opts.trackers.length === 0) throw new Error('No trackers to simulate');
    this.opts = opts;
    this.onProgress = hooks?.onProgress;
    this.onEnd = hooks?.onEnd;
    this.line = turf.lineString(opts.courseCoords);
    this.courseMi = turf.length(this.line, { units: 'miles' });
    this.states = opts.trackers.map((t, i) => ({
      ...t,
      battery: t.battery ?? Math.max(20, 95 - i * 6),
      count: 0,
      distanceMi: 0,
      lastSentMs: 0,
    }));
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.opts.port, this.opts.host, () => {
        this.sock = sock;
        this.startedAtMs = Date.now();
        // Tick fast enough for the fastest cadence, but never stamp two packets
        // for one tracker in the same second.
        const tickMs = Math.max(250, Math.min(1000, (this.opts.intervalS * 1000) / this.opts.timescale));
        this.timer = setInterval(() => this.tick(), tickMs);
        resolve();
      });
      sock.on('error', (err) => {
        this.lastError = err.message;
        if (!this.sock) reject(err);
        else this.stop('connection lost');
      });
      sock.on('close', () => {
        if (this.timer) this.stop('connection closed');
      });
    });
  }

  private tick(): void {
    if (!this.sock || this.startedAtMs === null) return;
    const now = Date.now();
    const simHrs = ((now - this.startedAtMs) / 3600_000) * this.opts.timescale;
    const minGapMs = Math.max(1000, (this.opts.intervalS * 1000) / this.opts.timescale);
    let allDone = true;

    for (const s of this.states) {
      const target = Math.min(Math.max(0, simHrs * s.paceMph + s.startOffsetMi), this.courseMi);
      s.distanceMi = target;
      if (target < this.courseMi) allDone = false;
      if (now - s.lastSentMs < minGapMs) continue;
      s.lastSentMs = now;

      const pt = turf.along(this.line, target, { units: 'miles' });
      let [lon, lat] = pt.geometry.coordinates;
      lat += ((Math.random() - 0.5) * 2 * this.opts.jitterM) / 111_320;
      lon += ((Math.random() - 0.5) * 2 * this.opts.jitterM) / (111_320 * Math.cos((lat * Math.PI) / 180));

      const ts = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
      s.battery = Math.max(5, s.battery - 0.0005 * this.opts.timescale);
      s.count = (s.count + 1) % 0x10000;
      const speedKmh = (s.paceMph * 1.60934).toFixed(1);

      const frame =
        `+RESP:GTFRI,F50A01,${s.imei},,0,0,1,1,${speedKmh},90,10.0,` +
        `${lon.toFixed(6)},${lat.toFixed(6)},${ts},0310,0410,9909,06F23911,,` +
        `${Math.round(s.battery)},${ts},${s.count.toString(16).toUpperCase().padStart(4, '0')}$`;
      this.sock.write(frame);
    }

    this.onProgress?.(this.status());
    if (allDone) this.stop('all trackers finished');
  }

  stop(reason = 'stopped'): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.sock?.end();
    this.sock?.destroy();
    this.sock = undefined;
    const wasRunning = this.startedAtMs !== null;
    this.startedAtMs = null;
    if (wasRunning) this.onEnd?.(reason);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  status(): SimProgress {
    const elapsedRealS = this.startedAtMs ? Math.round((Date.now() - this.startedAtMs) / 1000) : 0;
    return {
      running: this.running,
      startedAtMs: this.startedAtMs,
      elapsedRealS,
      elapsedSimS: Math.round(elapsedRealS * this.opts.timescale),
      courseMi: this.courseMi,
      timescale: this.opts.timescale,
      trackers: this.states.map((s) => ({
        imei: s.imei,
        label: s.label,
        distanceMi: s.distanceMi,
        battery: Math.round(s.battery),
        done: s.distanceMi >= this.courseMi - 1e-6,
      })),
      error: this.lastError,
    };
  }
}

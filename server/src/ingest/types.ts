/** A frame extracted from a TCP stream by the MixedFramer. */
export type Frame =
  | { kind: 'ascii'; text: string }
  | { kind: 'binary'; bytes: Buffer }
  | { kind: 'heartbeat'; bytes: Buffer };

/** Canonical normalized GPS fix — every parser produces this shape. */
export interface Fix {
  imei: string;
  lat: number;
  lon: number;
  /** Altitude in meters, when reported. */
  altM?: number;
  /** GPS timestamp (from the device's GNSS chip), unix ms UTC. */
  tUtcMs: number;
  /** Speed as reported by the device, km/h. */
  speedKmh?: number;
  azimuth?: number;
  /** GTFRI accuracy field (GL family). */
  accuracy?: number;
  hdop?: number;
  sats?: number;
  /** Battery percent — absent on vehicle-powered units (GV500CNA). */
  battery?: number;
  /**
   * Whether the device claims a live GNSS fix. Binary Pro frames carry an
   * explicit fix state; ASCII GTFRI has no equivalent, so parsers set true
   * when coordinates are present and plausible.
   */
  fixValid: boolean;
  /** True for store-and-forward frames (+BUFF / 0x2D header) sent after a dropout. */
  buffered: boolean;
  /** Frame count number for gap detection (per-device, monotonic at source). */
  countNumber?: number;
  /** Which listener/source produced this. */
  source: string;
  protocol: 'gtfri-22' | 'gtfri-27' | 'atrack-pro';
  /** Raw frame for the audit log: ASCII text, or hex for binary. */
  raw: string;
  receivedAtMs: number;
}

/** Non-position telemetry worth surfacing (ignition, startup, self-test, acks…). */
export interface Telemetry {
  imei?: string;
  type: string;
  tUtcMs?: number;
  detail?: Record<string, unknown>;
  source: string;
  raw: string;
}

export type ParseResult = { fixes: Fix[]; telemetry: Telemetry[] };

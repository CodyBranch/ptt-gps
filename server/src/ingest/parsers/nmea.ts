import type { Fix, Telemetry } from '../types.js';

/**
 * Parser for NMEA 0183 position sentences, as forwarded by the in-vehicle
 * Peplink routers.
 *
 * These are not trackers. A Peplink is the router already bolted into a lead
 * car for its cellular uplink, and it will forward its own GNSS position to a
 * TCP endpoint - so a vehicle that carries one is reporting whether or not
 * anybody remembered to charge a tracker and clip it to the dash. The legacy
 * server took them on port 2000 and this is the same job, ported from
 * `legacy/gps-v5.js` with its arithmetic fixed (see below).
 *
 * Only RMC produces a position. A router typically emits GGA, GSA, VTG and a
 * wall of GSV alongside it, several times a second and per vehicle; those are
 * already visible in the wire log, and recording each one as telemetry would
 * bury the table under sentences nobody reads. RMC alone carries everything
 * the engine wants: position, speed, course, and a date as well as a time.
 *
 * Three things the legacy got wrong and this does not:
 *  - it read field 8 as altitude. Field 8 is the track angle; RMC has no
 *    altitude at all.
 *  - it published field 7 as "speed" unconverted. RMC speed is in knots.
 *  - it read a frame counter from field 21, which does not exist in an RMC
 *    sentence, so every packet carried NaN.
 */

/** Knots to km/h. */
const KMH_PER_KNOT = 1.852;

/** XOR of every character between '$' and '*', which is the NMEA checksum. */
function checksum(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return sum;
}

/**
 * "3027.5698" → 30.4594967, "08417.9721" → 84.29953.
 *
 * Degrees are whatever precedes the last two digits before the decimal point,
 * which is two for a latitude and three for a longitude - derived rather than
 * hardcoded, so one function reads both without being told which it has.
 */
function degreesFrom(value: string): number | undefined {
  const dot = value.indexOf('.');
  const whole = dot < 0 ? value : value.slice(0, dot);
  if (whole.length < 3) return undefined;
  const degrees = Number(whole.slice(0, whole.length - 2));
  const minutes = Number(value.slice(whole.length - 2));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return undefined;
  return degrees + minutes / 60;
}

/** "230926" + "143512.00" → unix ms UTC. NaN when either is malformed. */
export function parseNmeaTime(date: string, time: string): number {
  if (!/^\d{6}$/.test(date) || !/^\d{6}(\.\d+)?$/.test(time)) return NaN;
  const seconds = Number(time.slice(4));
  return Date.UTC(
    2000 + Number(date.slice(4, 6)),
    Number(date.slice(2, 4)) - 1,
    Number(date.slice(0, 2)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Math.floor(seconds),
    Math.round((seconds % 1) * 1000),
  );
}

export function parseNmeaFrame(
  text: string,
  source: string,
  receivedAtMs: number,
): { fixes: Fix[]; telemetry: Telemetry[] } {
  const raw = text.trim();
  if (raw === '' || raw[0] !== '$') return { fixes: [], telemetry: [] };

  const star = raw.lastIndexOf('*');
  const body = star < 0 ? raw.slice(1) : raw.slice(1, star);
  const stated = star < 0 ? undefined : parseInt(raw.slice(star + 1, star + 3), 16);
  const f = body.split(',');
  const head = `$${f[0] ?? ''}`;

  // GP, GN, GL, GA, GB - the constellation prefix varies by receiver and a
  // modern multi-constellation chip says GN where an older one said GP.
  if (!/^\$G[A-Z]RMC$/.test(head)) return { fixes: [], telemetry: [] };

  if (stated !== undefined && Number.isFinite(stated) && checksum(body) !== stated) {
    // A router that appends its unit id to a finished sentence without
    // recomputing the checksum is a real configuration, and refusing every
    // packet from one would look exactly like a dead device. Accept it when
    // the sentence checksums correctly without that last field, and only then.
    const withoutId = body.slice(0, body.lastIndexOf(','));
    if (checksum(withoutId) !== stated) {
      return {
        fixes: [],
        telemetry: [{ type: `${head}:bad-checksum`, source, raw }],
      };
    }
  }

  // The last field is the router's unit id, appended after the standard ones.
  // A sentence that was not given one ends in a single character instead - the
  // mode indicator, or the magnetic-variation direction on an older receiver -
  // and one character is the whole test, because no id is that short.
  const last = f[f.length - 1] ?? '';
  const imei = f.length > 10 && last.length > 1 ? last : undefined;
  if (!imei) {
    // Without an id there is no way to know which vehicle this is. Worth
    // saying once per sentence rather than dropping it in silence: it means
    // the router is forwarding GPS but has no device name configured.
    return { fixes: [], telemetry: [{ type: `${head}:no-device-id`, source, raw }] };
  }

  const status = f[2] ?? '';
  const lat = degreesFrom(f[3] ?? '');
  const lon = degreesFrom(f[5] ?? '');
  const tUtcMs = parseNmeaTime(f[9] ?? '', f[1] ?? '');

  if (status !== 'A' || lat === undefined || lon === undefined || !Number.isFinite(tUtcMs)) {
    // "V" is the receiver saying it has no lock - a router indoors, or one
    // that has just been switched on. Recorded so the fleet page can show the
    // device as heard from rather than missing.
    return {
      fixes: [],
      telemetry: [{ type: `${head}:no-fix`, imei, tUtcMs: Number.isFinite(tUtcMs) ? tUtcMs : undefined, source, raw }],
    };
  }

  const knots = Number(f[7]);
  const track = Number(f[8]);

  return {
    fixes: [
      {
        imei,
        lat: (f[4] ?? '') === 'S' ? -lat : lat,
        lon: (f[6] ?? '') === 'W' ? -lon : lon,
        tUtcMs,
        speedKmh: Number.isFinite(knots) ? knots * KMH_PER_KNOT : undefined,
        azimuth: Number.isFinite(track) ? track : undefined,
        fixValid: true,
        // A router forwards what its receiver has now; there is no store and
        // forward, so nothing arrives as a backlog.
        buffered: false,
        // No battery field at all: these are wired into the vehicle. The
        // legacy reported a flat 100%, which makes a mains-fed router
        // indistinguishable from a fully charged tracker.
        source,
        protocol: 'nmea-rmc',
        raw,
        receivedAtMs,
      },
    ],
    telemetry: [],
  };
}

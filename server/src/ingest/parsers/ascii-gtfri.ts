import type { Fix, Telemetry } from '../types.js';

/**
 * Parser for Queclink ASCII @Track GTFRI position reports.
 *
 * Two field layouts exist in our fleet, distinguished by field count:
 *  - 22 fields: GL200/GL300 family (battery at 19, sendTime 20, count 21)
 *  - 27 fields: GL30 family (adds csq/battery-volt/mode/motion; battery at 21,
 *    sendTime 25, count 26)
 * Fields 0–13 (through packetTime) are identical in both.
 */

/** "20221028094541" (UTC) → unix ms. Returns NaN when malformed. */
export function parseQueclinkTime(s: string): number {
  if (!/^\d{14}$/.test(s)) return NaN;
  return Date.UTC(
    Number(s.slice(0, 4)),
    Number(s.slice(4, 6)) - 1,
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    Number(s.slice(10, 12)),
    Number(s.slice(12, 14)),
  );
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

export function parseAsciiFrame(
  text: string,
  source: string,
  receivedAtMs: number,
): { fix?: Fix; telemetry?: Telemetry } {
  const raw = text.trim().replace(/\$$/, '');
  if (raw === '') return {};
  const f = raw.split(',');
  const head = f[0] ?? '';

  const isFri = head === '+RESP:GTFRI' || head === '+BUFF:GTFRI';
  if (!isFri) {
    // Command replies, other report types, GV500 ACK/QRY relays — telemetry only.
    // IMEI position varies by frame type (ACKs have no protocol field), so scan.
    const imei = f.find((x) => /^\d{15}$/.test(x));
    return { telemetry: { type: head, imei, source, raw } };
  }

  let battery: number | undefined;
  let countHex: string | undefined;
  if (f.length === 22) {
    battery = num(f[19]);
    countHex = f[21];
  } else if (f.length === 27) {
    battery = num(f[21]);
    countHex = f[26];
  } else {
    // Unknown GTFRI layout — surface it rather than guessing field positions.
    return { telemetry: { type: `${head}:unknown-layout(${f.length})`, imei: f[2], source, raw } };
  }

  const lon = num(f[11]);
  const lat = num(f[12]);
  const tUtcMs = parseQueclinkTime(f[13] ?? '');

  const fix: Fix = {
    imei: f[2] ?? '',
    lat: lat ?? NaN,
    lon: lon ?? NaN,
    altM: num(f[10]),
    tUtcMs,
    speedKmh: num(f[8]),
    azimuth: num(f[9]),
    accuracy: num(f[7]),
    battery,
    fixValid: lat !== undefined && lon !== undefined && Number.isFinite(tUtcMs),
    buffered: head.startsWith('+BUFF'),
    countNumber: countHex && /^[0-9a-fA-F]+$/.test(countHex) ? parseInt(countHex, 16) : undefined,
    source,
    protocol: f.length === 22 ? 'gtfri-22' : 'gtfri-27',
    raw,
    receivedAtMs,
  };
  return { fix };
}

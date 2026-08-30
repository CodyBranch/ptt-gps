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

/**
 * GTFRI carries N position blocks, not one: after an outage a GL3xx clears its
 * backlog by packing several fixes into a single report (the `Number` field at
 * index 6 says how many). Field counts are unambiguous, so N is derived from
 * the length:
 *
 *   header 0..6 (7) + N × block (11) + tail (4 for GL200/GL300, 9 for GL30)
 *
 * Reading only the first block — as the legacy server did — threw away the
 * rest of the backlog; treating the longer frame as an unknown layout, as this
 * parser used to, threw away all of it.
 */
const HEADER = 7;
const BLOCK = 11;
const TAILS = { 'gtfri-22': 4, 'gtfri-27': 9 } as const;
type Layout = keyof typeof TAILS;

/**
 * Which family and point count a frame has.
 *
 * The count comes from the protocol's own `Number` field, not from arithmetic
 * on the field count: inferring it meant any frame whose length happened to
 * satisfy `(len - header - tail) % block === 0` was accepted as a multi-point
 * report, and the phantom extra "points" were read out of tail fields as
 * garbage coordinates and unparseable times. The declared count must agree
 * with the actual length exactly, or the frame is an unknown layout — which is
 * how anything unexpected was treated before multi-point support existed.
 */
function layoutOf(len: number, declared: number): { layout: Layout; points: number } | undefined {
  if (!Number.isInteger(declared) || declared < 0 || declared > 64) return undefined;
  for (const layout of Object.keys(TAILS) as Layout[]) {
    if (len === HEADER + BLOCK * declared + TAILS[layout]) return { layout, points: declared };
  }
  return undefined;
}

export function parseAsciiFrame(
  text: string,
  source: string,
  receivedAtMs: number,
): { fixes: Fix[]; telemetry?: Telemetry } {
  const raw = text.trim().replace(/\$$/, '');
  if (raw === '') return { fixes: [] };
  const f = raw.split(',');
  const head = f[0] ?? '';

  const isFri = head === '+RESP:GTFRI' || head === '+BUFF:GTFRI';
  if (!isFri) {
    // Command replies, other report types, GV500 ACK/QRY relays — telemetry only.
    // IMEI position varies by frame type (ACKs have no protocol field), so scan.
    const imei = f.find((x) => /^\d{15}$/.test(x));
    return { fixes: [], telemetry: { type: head, imei, source, raw } };
  }

  const shape = layoutOf(f.length, Number(f[6]));
  if (!shape) {
    // Unknown GTFRI layout — surface it rather than guessing field positions.
    return {
      fixes: [],
      telemetry: { type: `${head}:unknown-layout(${f.length} fields, Number=${f[6]})`, imei: f[2], source, raw },
    };
  }
  const { layout, points } = shape;
  const tail = HEADER + BLOCK * points;
  const battery = num(layout === 'gtfri-22' ? f[tail + 1] : f[tail + 3]);
  const countHex = layout === 'gtfri-22' ? f[tail + 3] : f[tail + 8];
  const countNumber = countHex && /^[0-9a-fA-F]+$/.test(countHex) ? parseInt(countHex, 16) : undefined;
  const imei = f[2] ?? '';

  const fixes: Fix[] = [];
  for (let b = 0; b < points; b++) {
    const i = HEADER + BLOCK * b;
    const lon = num(f[i + 4]);
    const lat = num(f[i + 5]);
    const tUtcMs = parseQueclinkTime(f[i + 6] ?? '');
    fixes.push({
      imei,
      lat: lat ?? NaN,
      lon: lon ?? NaN,
      altM: num(f[i + 3]),
      tUtcMs,
      speedKmh: num(f[i + 1]),
      azimuth: num(f[i + 2]),
      accuracy: num(f[i + 0]),
      battery,
      fixValid: lat !== undefined && lon !== undefined && Number.isFinite(tUtcMs),
      buffered: head.startsWith('+BUFF'),
      // The count number identifies the frame, so it belongs to the last block:
      // gap detection must not see one frame as several missing ones.
      countNumber: b === points - 1 ? countNumber : undefined,
      source,
      protocol: layout,
      raw,
      receivedAtMs,
    });
  }
  // Backlog blocks are packed oldest-first by some firmware and newest-first by
  // others; the engine wants them in time order either way.
  fixes.sort((a, b2) => a.tUtcMs - b2.tUtcMs);
  if (points === 0) {
    return { fixes: [], telemetry: { type: `${head}:no-fix`, imei, source, raw } };
  }
  return { fixes };
}

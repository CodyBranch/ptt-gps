import type { Fix, ParseResult, Telemetry } from '../types.js';

/**
 * Parser for Queclink @Track Protocol Pro binary frames (GV500CNA).
 * Frame integrity (length, CRC-8, 0x24 tail) is already verified by the framer.
 *
 * Layout (all multi-byte integers big-endian):
 *   header(1) id(1) length(2) flags(1) [frameCount(1) frameNo(1) if flags bit7]
 *   imei(8, packed BCD w/ pad nibble) deviceType(2) protocolVer(2) customVer(1)
 *   reservedLen(1) reserved(N) records... countNumber(2) crc(1) 0x24
 */

const RECORD_NAMES: Record<number, string> = {
  0x01: 'device-startup',
  0x03: 'connection-start',
  0x04: 'connection-end',
  0x12: 'realtime-location',
  0x1c: 'gnss-state',
  0x21: 'motion',
  0x30: 'ignition-on',
  0x31: 'ignition-off',
  0x50: 'fixed-report',
  0xe0: 'self-test',
};

/** 1- or 2-byte variable length/ID: high bit set = 15-bit value across two bytes. */
function readVar(buf: Buffer, i: number): [value: number, next: number] {
  if (buf[i] & 0x80) return [((buf[i] & 0x7f) << 8) | buf[i + 1], i + 2];
  return [buf[i], i + 1];
}

interface ProPosition {
  fixValid: boolean;
  lat: number;
  lon: number;
  tUtcMs: number;
  speedKmh: number;
  hdop?: number;
  azimuth?: number;
  altM?: number;
  sats?: number;
}

function decodePosition(c: Buffer): ProPosition | undefined {
  if (c.length !== 15 && c.length !== 22) return undefined; // Data 81 = 15 bytes, Data 82 = 22
  const fixState = (c[0] >> 2) & 0x03; // 0b10 = live fix; anything else repeats last known
  const pos: ProPosition = {
    fixValid: fixState === 0b10,
    lon: c.readInt32BE(1) / 1e6,
    lat: c.readInt32BE(5) / 1e6,
    tUtcMs: c.readUInt32BE(9) * 1000,
    speedKmh: c.readUInt16BE(13) / 10,
  };
  if (c.length === 22) {
    pos.hdop = c[15] / 10;
    pos.azimuth = c.readUInt16BE(16);
    // altitude: int24, ×0.1 m
    const altRaw = (c[18] << 16) | (c[19] << 8) | c[20];
    pos.altM = (altRaw & 0x800000 ? altRaw - 0x1000000 : altRaw) / 10;
    pos.sats = c[21];
  }
  return pos;
}

export function parseHeartbeat(f: Buffer, source: string, receivedAtMs: number): Telemetry {
  return {
    type: 'heartbeat',
    imei: f.subarray(3, 11).toString('hex').slice(1),
    tUtcMs: f.readUInt32BE(16) * 1000,
    detail: { countNumber: f.readUInt16BE(20) },
    source,
    raw: f.toString('hex'),
  };
}

export function parseBinaryFrame(f: Buffer, source: string, receivedAtMs: number): ParseResult {
  const fixes: Fix[] = [];
  const telemetry: Telemetry[] = [];
  const buffered = f[0] === 0x2d;
  const rawHex = f.toString('hex');

  let p = 4;
  const multi = (f[p] & 0x80) !== 0;
  p += 1 + (multi ? 2 : 0);
  const imei = f.subarray(p, p + 8).toString('hex').slice(1);
  p += 8;
  p += 2 + 2 + 1; // device type, protocol version, custom version
  p += 1 + f[p]; // reserved field, skipped by its own length — do not assume 0
  const countNumber = f.readUInt16BE(f.length - 4);

  const end = f.length - 4;
  while (p < end) {
    const [recLen, q0] = readVar(f, p);
    const recEnd = p + recLen;
    if (recLen <= 0 || recEnd > end) break; // malformed record — stop rather than misparse
    let q = q0;
    const genUtcMs = f.readUInt32BE(q) * 1000;
    const recordId = f[q + 6];
    const eventCode = f[q + 7];
    q += 8;

    let position: ProPosition | undefined;
    let deviceName: string | undefined;
    while (q < recEnd) {
      const [dataId, q1] = readVar(f, q);
      const [dataLen, q2] = readVar(f, q1);
      const content = f.subarray(q2, q2 + dataLen); // dataLen 0 is legal: item unavailable
      q = q2 + dataLen;
      if (dataId === 81 || dataId === 82) position = decodePosition(content) ?? position;
      else if (dataId === 2) deviceName = content.toString('ascii');
    }

    if (recordId === 0x50 && position) {
      fixes.push({
        imei,
        lat: position.lat,
        lon: position.lon,
        altM: position.altM,
        tUtcMs: position.tUtcMs,
        speedKmh: position.speedKmh,
        azimuth: position.azimuth,
        hdop: position.hdop,
        sats: position.sats,
        fixValid: position.fixValid,
        buffered,
        countNumber,
        source,
        protocol: 'atrack-pro',
        raw: rawHex,
        receivedAtMs,
      });
    } else {
      telemetry.push({
        type: RECORD_NAMES[recordId] ?? `record-0x${recordId.toString(16)}`,
        imei,
        tUtcMs: genUtcMs,
        detail: {
          eventCode,
          buffered,
          ...(deviceName ? { deviceName } : {}),
          ...(position ? { position } : {}),
        },
        source,
        raw: rawHex,
      });
    }
    p = recEnd;
  }

  return { fixes, telemetry };
}

import { describe, expect, it } from 'vitest';
import { parseAsciiFrame, parseQueclinkTime } from '../src/ingest/parsers/ascii-gtfri.js';
import { parseBinaryFrame } from '../src/ingest/parsers/binary-pro.js';
import { GTFRI_27, MIRROR_ACK, MIRROR_ASCII, PRO_REPORT, REAL_GTFRI_22 } from './fixtures.js';

const NOW = 1666951600000;

describe('parseQueclinkTime', () => {
  it('parses YYYYMMDDHHmmss as UTC', () => {
    expect(parseQueclinkTime('20221028094541')).toBe(Date.UTC(2022, 9, 28, 9, 45, 41));
  });
  it('rejects malformed input', () => {
    expect(parseQueclinkTime('')).toBeNaN();
    expect(parseQueclinkTime('2022102809454')).toBeNaN();
  });
});

describe('ascii GTFRI parser', () => {
  it('parses a real 22-field GL300 frame from the 2022 logs', () => {
    const { fix } = parseAsciiFrame(REAL_GTFRI_22, 'test', NOW);
    expect(fix).toBeDefined();
    expect(fix!.imei).toBe('015181000128000');
    expect(fix!.lon).toBeCloseTo(-113.582319, 6);
    expect(fix!.lat).toBeCloseTo(37.063092, 6);
    expect(fix!.altM).toBeCloseTo(811.5);
    expect(fix!.tUtcMs).toBe(Date.UTC(2022, 9, 28, 9, 45, 41));
    expect(fix!.battery).toBe(100);
    expect(fix!.accuracy).toBe(1);
    expect(fix!.countNumber).toBe(0x75c4);
    expect(fix!.protocol).toBe('gtfri-22');
    expect(fix!.fixValid).toBe(true);
    expect(fix!.buffered).toBe(false);
  });

  it('parses the mirror @Track dialect (still 22 fields)', () => {
    const { fix } = parseAsciiFrame(MIRROR_ASCII, 'mirror', NOW);
    expect(fix!.imei).toBe('860931070051250');
    expect(fix!.lat).toBeCloseTo(33.849298, 6);
    expect(fix!.battery).toBe(95);
  });

  it('parses the 27-field GL30 layout (battery at 21, count at 26)', () => {
    const { fix } = parseAsciiFrame(GTFRI_27, 'test', NOW);
    expect(fix!.imei).toBe('860201060067272');
    expect(fix!.lat).toBeCloseTo(42.229944, 6);
    expect(fix!.battery).toBe(87);
    expect(fix!.countNumber).toBe(0x0a2b);
    expect(fix!.protocol).toBe('gtfri-27');
  });

  it('treats +BUFF as buffered', () => {
    const { fix } = parseAsciiFrame(REAL_GTFRI_22.replace('+RESP', '+BUFF'), 'test', NOW);
    expect(fix!.buffered).toBe(true);
  });

  it('routes non-GTFRI frames to telemetry (GV500 ACK relays etc.)', () => {
    const { fix, telemetry } = parseAsciiFrame(MIRROR_ACK, 'mirror', NOW);
    expect(fix).toBeUndefined();
    expect(telemetry!.type).toBe('+ACK:RTO');
    expect(telemetry!.imei).toBe('865134050946566');
  });

  it('flags unknown GTFRI layouts instead of misreading fields', () => {
    const weird = REAL_GTFRI_22.replace(/\$$/, '') + ',extra$';
    const { fix, telemetry } = parseAsciiFrame(weird, 'test', NOW);
    expect(fix).toBeUndefined();
    expect(telemetry!.type).toContain('unknown-layout(23)');
  });

  it('marks empty coordinates as fixValid=false', () => {
    const noCoords =
      '+RESP:GTFRI,F50A01,015181000128000,,0,0,1,0,0.0,0,,,,20221028094541,0310,0410,9909,06F23911,,100,20221028094542,75C4$';
    const { fix } = parseAsciiFrame(noCoords, 'test', NOW);
    expect(fix!.fixValid).toBe(false);
  });
});

describe('binary Protocol Pro parser', () => {
  it('decodes the spec worked example (50H fixed report)', () => {
    const { fixes, telemetry } = parseBinaryFrame(PRO_REPORT, 'mirror', NOW);
    expect(telemetry).toHaveLength(0);
    expect(fixes).toHaveLength(1);
    const fix = fixes[0];
    expect(fix.imei).toBe('123456789012345');
    expect(fix.lon).toBeCloseTo(-115.300127, 6);
    expect(fix.lat).toBeCloseTo(-13.778794, 6);
    expect(fix.tUtcMs).toBe(1595383200_000);
    expect(fix.speedKmh).toBeCloseTo(38.1, 1);
    expect(fix.hdop).toBeCloseTo(1.0, 1);
    expect(fix.azimuth).toBe(37);
    expect(fix.altM).toBeCloseTo(43.5, 1);
    expect(fix.sats).toBe(12);
    expect(fix.fixValid).toBe(true);
    expect(fix.buffered).toBe(false);
    expect(fix.countNumber).toBe(291);
    expect(fix.protocol).toBe('atrack-pro');
  });

  it('marks 0x2D-header frames as buffered', () => {
    const buffered = Buffer.from(PRO_REPORT);
    buffered[0] = 0x2d; // CRC not re-checked here — framer's job
    const { fixes } = parseBinaryFrame(buffered, 'mirror', NOW);
    expect(fixes[0].buffered).toBe(true);
  });

  it('reports no-fix frames with fixValid=false (repeated last-known coords)', () => {
    const f = Buffer.from(PRO_REPORT);
    // fix state bits 3–2 of the Data82 first byte (offset: records start at 19;
    // record head 9 bytes incl. len; data id 0x52, len 0x16 → content at 19+1+8+2 = 30)
    f[30] = f[30] & 0b11110011; // GNSS off
    const { fixes } = parseBinaryFrame(f, 'mirror', NOW);
    expect(fixes[0].fixValid).toBe(false);
  });
});

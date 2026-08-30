import { describe, expect, it } from 'vitest';
import { parseAsciiFrame, parseQueclinkTime } from '../src/ingest/parsers/ascii-gtfri.js';
import { parseBinaryFrame } from '../src/ingest/parsers/binary-pro.js';
import { FixGate } from '../src/ingest/hygiene.js';
import { GTFRI_22_MULTI, GTFRI_27, MIRROR_ACK, MIRROR_ASCII, PRO_REPORT, REAL_GTFRI_22, REAL_GTFRI_NO_FIX } from './fixtures.js';

/** Most frames carry one position; these tests assert on that one. */
const fixesOf = (...args: Parameters<typeof parseAsciiFrame>) => parseAsciiFrame(...args).fixes;

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
    const [fix] = fixesOf(REAL_GTFRI_22, 'test', NOW);
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
    const [fix] = fixesOf(MIRROR_ASCII, 'mirror', NOW);
    expect(fix!.imei).toBe('860931070051250');
    expect(fix!.lat).toBeCloseTo(33.849298, 6);
    expect(fix!.battery).toBe(95);
  });

  it('parses the 27-field GL30 layout (battery at 21, count at 26)', () => {
    const [fix] = fixesOf(GTFRI_27, 'test', NOW);
    expect(fix!.imei).toBe('860201060067272');
    expect(fix!.lat).toBeCloseTo(42.229944, 6);
    expect(fix!.battery).toBe(87);
    expect(fix!.countNumber).toBe(0x0a2b);
    expect(fix!.protocol).toBe('gtfri-27');
  });

  it('treats +BUFF as buffered', () => {
    const [fix] = fixesOf(REAL_GTFRI_22.replace('+RESP', '+BUFF'), 'test', NOW);
    expect(fix!.buffered).toBe(true);
  });

  it('reads every position in a backlog frame, not just the first', () => {
    const { fixes } = parseAsciiFrame(GTFRI_22_MULTI, 'test', NOW);
    expect(fixes).toHaveLength(3);
    expect(fixes.map((f) => f.tUtcMs)).toEqual([
      Date.UTC(2022, 9, 28, 9, 45, 41),
      Date.UTC(2022, 9, 28, 9, 45, 51),
      Date.UTC(2022, 9, 28, 9, 46, 1),
    ]);
    // the shared tail applies to all of them
    expect(fixes.every((f) => f.battery === 100)).toBe(true);
    expect(fixes.every((f) => f.imei === '015181000128000')).toBe(true);
    expect(fixes[2].lat).toBeCloseTo(37.065, 6);
    // one frame = one count number, or gap detection sees phantom losses
    expect(fixes.filter((f) => f.countNumber !== undefined)).toHaveLength(1);
    expect(fixes[2].countNumber).toBe(0x75c4);
  });

  it('a backlog frame feeds the gate in time order', () => {
    const { fixes } = parseAsciiFrame(GTFRI_22_MULTI, 'test', NOW);
    const gate = new FixGate();
    expect(fixes.map((f) => gate.accept(f).ok)).toEqual([true, true, true]);
  });

  it('refuses a frame whose length disagrees with its declared point count', () => {
    // 33 fields satisfies (33 - 7 - 4) % 11 === 0, so inferring the count from
    // the length alone read this as two points and produced garbage from the
    // tail. Number says 1, which does not fit 33 fields, so it is unknown.
    const declaredOne = REAL_GTFRI_22.replace('$', '') + ',x,x,x,x,x,x,x,x,x,x,x$';
    const { fixes, telemetry } = parseAsciiFrame(declaredOne, 'test', NOW);
    expect(fixes).toHaveLength(0);
    expect(telemetry!.type).toContain('unknown-layout');
  });

  it('never emits a fix without a usable GPS time', () => {
    const noTime = REAL_GTFRI_22.replace('20221028094541', 'NOTATIME');
    const { fixes } = parseAsciiFrame(noTime, 'test', NOW);
    // it still parses as a frame, but the time is unusable and flagged
    for (const f of fixes) {
      expect(Number.isFinite(f.tUtcMs) || f.fixValid === false).toBe(true);
    }
  });

  it('reports a device with no satellite lock as live telemetry, not a fix', () => {
    const { fixes, telemetry } = parseAsciiFrame(REAL_GTFRI_NO_FIX, 'queclink', NOW);
    expect(fixes).toHaveLength(0); // no position: nothing for the engine
    expect(telemetry!.type).toBe('+RESP:GTFRI:no-fix');
    expect(telemetry!.imei).toBe('860931070051870');
    // the parts that are real still come through, so the crew sees a charged
    // tracker waiting for a lock rather than a silent one
    expect(telemetry!.detail!.battery).toBe(100);
    expect(telemetry!.detail!.batteryMv).toBe(4186);
    expect(telemetry!.tUtcMs).toBe(Date.UTC(2026, 7, 30, 5, 22, 30));
  });

  it('treats accuracy 0 as no live fix, even with coordinates present', () => {
    // Real frame from Philadelphia: the unit has no lock and is repeating a
    // position from eight hours earlier. Coordinates are there; a fix is not.
    const repeat =
      '+RESP:GTFRI,930402,860931070051201,,0,1,1,0,3.8,308,3.6,-75.177145,39.962538,20260829210408,' +
      '0310,0260,56E3,00AE340C,31,0,3800,54,1,0,0,20260830052802,0AB6';
    const [fix] = fixesOf(repeat, 'queclink', NOW);
    expect(fix).toBeDefined();
    expect(fix.fixValid).toBe(false); // the gate drops it before the engine
    expect(fix.battery).toBe(54); // but the battery is real and still useful
    expect(new FixGate().accept(fix)).toEqual({ ok: false, reason: 'no-fix' });
  });

  it('routes non-GTFRI frames to telemetry (GV500 ACK relays etc.)', () => {
    const { fixes, telemetry } = parseAsciiFrame(MIRROR_ACK, 'mirror', NOW);
    expect(fixes).toHaveLength(0);
    expect(telemetry!.type).toBe('+ACK:RTO');
    expect(telemetry!.imei).toBe('865134050946566');
  });

  it('flags unknown GTFRI layouts instead of misreading fields', () => {
    const weird = REAL_GTFRI_22.replace(/\$$/, '') + ',extra$';
    const { fixes, telemetry } = parseAsciiFrame(weird, 'test', NOW);
    expect(fixes).toHaveLength(0);
    expect(telemetry!.type).toContain('unknown-layout(23 fields');
  });

  it('emits no fix at all when the coordinates are empty', () => {
    // Even with a GPS time present, a frame carrying no position is not a fix;
    // it is a device reporting in without a lock.
    const noCoords =
      '+RESP:GTFRI,F50A01,015181000128000,,0,0,1,0,0.0,0,,,,20221028094541,0310,0410,9909,06F23911,,100,20221028094542,75C4$';
    const { fixes, telemetry } = parseAsciiFrame(noCoords, 'test', NOW);
    expect(fixes).toHaveLength(0);
    expect(telemetry!.type).toBe('+RESP:GTFRI:no-fix');
    expect(telemetry!.detail!.battery).toBe(100);
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

import { describe, expect, it } from 'vitest';
import { LineFramer } from '../src/ingest/framer.js';
import { parseNmeaFrame, parseNmeaTime } from '../src/ingest/parsers/nmea.js';

/**
 * NMEA from the in-vehicle Peplink routers.
 *
 * The arithmetic is the part worth pinning: a position that is wrong by a
 * factor of sixty still looks like a position, and the legacy server this was
 * ported from published a track angle as an altitude and knots as km/h for
 * years without anyone noticing, because nothing downstream reads those.
 */

/** Tallahassee, 30°27.5698'N 84°17.9721'W, 11.2 knots, 187.4°, 23 Sep 2026. */
const body = 'GPRMC,143512.00,A,3027.5698,N,08417.9721,W,11.2,187.4,230926,,,A,PEP-LEAD1';

/** The NMEA checksum: XOR of everything between the $ and the *. */
const withChecksum = (b: string): string => {
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum ^= b.charCodeAt(i);
  return `$${b}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
};

const parse = (sentence: string) => parseNmeaFrame(sentence, 'peplink', 1_800_000_000_000);
const fixOf = (sentence: string) => parse(sentence).fixes[0];

describe('reading a position out of an RMC sentence', () => {
  it('converts degrees-and-minutes to decimal degrees', () => {
    const fix = fixOf(withChecksum(body));
    // 30 + 27.5698/60, and 84 + 17.9721/60 negated for W.
    expect(fix.lat).toBeCloseTo(30.4594967, 6);
    expect(fix.lon).toBeCloseTo(-84.2995350, 6);
  });

  it('reads three-digit longitude degrees and two-digit latitude from the same rule', () => {
    // A longitude past 100° is where a hardcoded field width goes wrong.
    const fix = fixOf(withChecksum(body.replace('08417.9721,W', '11730.0000,W')));
    expect(fix.lon).toBeCloseTo(-117.5, 6);
  });

  it('negates the southern and western hemispheres', () => {
    const fix = fixOf(withChecksum(body.replace(',N,', ',S,').replace(',W,', ',E,')));
    expect(fix.lat).toBeLessThan(0);
    expect(fix.lon).toBeGreaterThan(0);
  });

  it('converts speed from knots, which the legacy published raw', () => {
    // 11.2 knots is 20.7 km/h, not 11.2 of anything.
    expect(fixOf(withChecksum(body)).speedKmh).toBeCloseTo(20.74, 2);
  });

  it('takes the track angle as the azimuth and reports no altitude', () => {
    const fix = fixOf(withChecksum(body));
    expect(fix.azimuth).toBe(187.4);
    // The legacy read this same field as altitude. RMC has no altitude.
    expect(fix.altM).toBeUndefined();
  });

  it('reports no battery at all, rather than the legacy flat 100%', () => {
    expect(fixOf(withChecksum(body)).battery).toBeUndefined();
  });

  it('builds the timestamp from the date and the time together', () => {
    expect(parseNmeaTime('230926', '143512.00')).toBe(Date.UTC(2026, 8, 23, 14, 35, 12));
    expect(parseNmeaTime('230926', '143512.25')).toBe(Date.UTC(2026, 8, 23, 14, 35, 12, 250));
    expect(fixOf(withChecksum(body)).tUtcMs).toBe(Date.UTC(2026, 8, 23, 14, 35, 12));
  });

  it('refuses a malformed date or time rather than inventing one', () => {
    expect(parseNmeaTime('', '143512.00')).toBeNaN();
    expect(parseNmeaTime('230926', '')).toBeNaN();
  });
});

describe('which sentences are acted on', () => {
  it('accepts any constellation prefix, because a modern receiver says GN', () => {
    for (const head of ['GPRMC', 'GNRMC', 'GLRMC', 'GARMC']) {
      expect(fixOf(withChecksum(body.replace('GPRMC', head)))).toBeDefined();
    }
  });

  it('ignores the other sentence types entirely, without recording telemetry', () => {
    // A router emits GGA, GSA, VTG and a wall of GSV alongside RMC. They are in
    // the wire log already; recording each as telemetry would bury the table.
    const out = parse(withChecksum('GPGGA,143512.00,3027.5698,N,08417.9721,W,1,09,0.9,41.2,M,,M,,'));
    expect(out.fixes).toEqual([]);
    expect(out.telemetry).toEqual([]);
  });

  it('produces nothing at all from a blank line or a non-sentence', () => {
    for (const junk of ['', '   ', 'hello', 'GPRMC,no,dollar']) {
      expect(parse(junk)).toEqual({ fixes: [], telemetry: [] });
    }
  });
});

describe('what stops a bad sentence becoming a bad position', () => {
  it('drops a sentence whose checksum does not match', () => {
    const out = parse(`${withChecksum(body).slice(0, -2)}FF`);
    expect(out.fixes).toEqual([]);
    expect(out.telemetry[0].type).toBe('$GPRMC:bad-checksum');
  });

  it('accepts one whose id was appended without recomputing the checksum', () => {
    // A real router configuration: the sentence is finished, then the unit
    // name is added. Refusing these looks exactly like a dead device.
    const standard = 'GPRMC,143512.00,A,3027.5698,N,08417.9721,W,11.2,187.4,230926,,,A';
    const sentence = withChecksum(standard);
    const star = sentence.lastIndexOf('*');
    const appended = `${sentence.slice(0, star)},PEP-LEAD1${sentence.slice(star)}`;

    const out = parse(appended);
    expect(out.fixes).toHaveLength(1);
    expect(out.fixes[0].imei).toBe('PEP-LEAD1');
  });

  it('reports a receiver with no lock rather than a position at zero', () => {
    const out = parse(withChecksum(body.replace(',A,3027', ',V,3027')));
    expect(out.fixes).toEqual([]);
    expect(out.telemetry[0]).toMatchObject({ type: '$GPRMC:no-fix', imei: 'PEP-LEAD1' });
  });

  it('says so when a router forwards GPS with no device name set', () => {
    const standard = 'GPRMC,143512.00,A,3027.5698,N,08417.9721,W,11.2,187.4,230926,,,A';
    const out = parse(withChecksum(standard));
    expect(out.fixes).toEqual([]);
    // Without an id there is no way to know which vehicle this is.
    expect(out.telemetry[0].type).toBe('$GPRMC:no-device-id');
  });

  it('is not fooled by the mode indicator into reading it as a device id', () => {
    for (const tail of [',,,A', ',,,D', ',,E']) {
      const out = parse(withChecksum(`GPRMC,143512.00,A,3027.5698,N,08417.9721,W,11.2,187.4,230926${tail}`));
      expect(out.fixes).toEqual([]);
      expect(out.telemetry[0].type).toBe('$GPRMC:no-device-id');
    }
  });
});

describe('framing a router stream', () => {
  const framer = new LineFramer();
  const push = (s: string) => framer.push(Buffer.from(s, 'ascii')).map((f) => (f.kind === 'ascii' ? f.text : '?'));

  it('emits a sentence as soon as its line ends, not when the next one starts', () => {
    // The whole reason this framer exists: the ASCII framer terminates on '$',
    // which an NMEA sentence begins with, so every fix would wait for its
    // successor and the last one before a stop would never arrive.
    expect(push(`${withChecksum(body)}\r\n`)).toHaveLength(1);
  });

  it('reassembles a sentence split across TCP packets', () => {
    const sentence = withChecksum(body);
    expect(push(sentence.slice(0, 20))).toEqual([]);
    expect(push(`${sentence.slice(20)}\r\n`)).toEqual([sentence]);
  });

  it('handles several sentences in one packet, and bare newlines', () => {
    const a = withChecksum(body);
    const b = withChecksum(body.replace('11.2', '0.0'));
    expect(push(`${a}\n${b}\r\n`)).toEqual([a, b]);
  });
});

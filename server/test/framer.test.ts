import { describe, expect, it } from 'vitest';
import { MixedFramer } from '../src/ingest/framer.js';
import { crc8 } from '../src/ingest/crc8.js';
import { MIRROR_ACK, PRO_REPORT, REAL_GTFRI_22 } from './fixtures.js';

function heartbeat(): Buffer {
  // 2B 10 18, imei(8), 5 pad, time(4), count(2), crc, $  — 24 bytes
  const b = Buffer.alloc(24);
  b[0] = 0x2b;
  b[1] = 0x10;
  b[2] = 0x18;
  Buffer.from('0123456789012345', 'hex').copy(b, 3);
  b.writeUInt32BE(1720600567, 16);
  b.writeUInt16BE(7, 20);
  b[22] = crc8(b.subarray(0, 22));
  b[23] = 0x24;
  return b;
}

describe('MixedFramer', () => {
  it('frames a pure-ASCII stream (legacy GL-family)', () => {
    const f = new MixedFramer();
    const frames = f.push(Buffer.from(REAL_GTFRI_22 + MIRROR_ACK));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ kind: 'ascii', text: REAL_GTFRI_22 });
    expect(frames[1]).toEqual({ kind: 'ascii', text: MIRROR_ACK });
  });

  it('frames binary among ASCII without splitting on $ inside binary', () => {
    const f = new MixedFramer();
    // PRO_REPORT contains no interior 0x24 by luck of the example; force one via
    // an ASCII frame after binary and binary after ASCII.
    const stream = Buffer.concat([
      Buffer.from(REAL_GTFRI_22),
      Buffer.from('\r\n'),
      PRO_REPORT,
      Buffer.from(MIRROR_ACK),
    ]);
    const frames = f.push(stream);
    expect(frames.map((x) => x.kind)).toEqual(['ascii', 'binary', 'ascii']);
  });

  it('handles interior 0x24 bytes in binary frames', () => {
    // Build a valid frame whose length field low byte is 0x24 (36 bytes long),
    // guaranteeing a $ inside the frame head itself.
    const len = 0x24;
    const b = Buffer.alloc(len);
    b[0] = 0x2b;
    b[1] = 0x00;
    b.writeUInt16BE(len, 2);
    b[4] = 0; // flags
    Buffer.from('0123456789012345', 'hex').copy(b, 5);
    b.writeUInt16BE(0x8203, 13);
    b.writeUInt16BE(0x0003, 15);
    b[17] = 0; // custom version
    b[18] = 0; // reserved length
    // record: len 13, time, count, id 0xE0 self-test, event 0, no data units
    b[19] = 13;
    b.writeUInt32BE(1720600567, 20);
    b.writeUInt16BE(1, 24);
    b[26] = 0xe0;
    b[27] = 0x00;
    // pad 4 bytes of record data as a zero-length data unit set… keep record exactly 13: 19..31
    b.writeUInt16BE(291, len - 4);
    b[len - 2] = crc8(b.subarray(0, len - 2));
    b[len - 1] = 0x24;

    const f = new MixedFramer();
    const frames = f.push(Buffer.concat([b, Buffer.from(REAL_GTFRI_22)]));
    expect(frames.map((x) => x.kind)).toEqual(['binary', 'ascii']);
  });

  it('reassembles frames split across arbitrary chunk boundaries', () => {
    const stream = Buffer.concat([Buffer.from(REAL_GTFRI_22), PRO_REPORT, Buffer.from(MIRROR_ACK)]);
    for (const chunkSize of [1, 3, 7, 20, 64]) {
      const f = new MixedFramer();
      const frames = [];
      for (let i = 0; i < stream.length; i += chunkSize) {
        frames.push(...f.push(stream.subarray(i, i + chunkSize)));
      }
      expect(frames.map((x) => x.kind), `chunk=${chunkSize}`).toEqual(['ascii', 'binary', 'ascii']);
    }
  });

  it('recognizes heartbeats as fixed 24-byte frames', () => {
    const f = new MixedFramer();
    const frames = f.push(Buffer.concat([heartbeat(), Buffer.from(REAL_GTFRI_22)]));
    expect(frames.map((x) => x.kind)).toEqual(['heartbeat', 'ascii']);
  });

  it('drops corrupt binary frames and counts them', () => {
    const bad = Buffer.from(PRO_REPORT);
    bad[30] ^= 0xff; // flip a byte → CRC fails
    const f = new MixedFramer();
    const frames = f.push(Buffer.concat([bad, Buffer.from(REAL_GTFRI_22)]));
    expect(frames.map((x) => x.kind)).toEqual(['ascii']);
    expect(f.corruptFrames).toBe(1);
  });

  it('skips inter-frame filler', () => {
    const f = new MixedFramer();
    const frames = f.push(Buffer.from('\r\n  ' + REAL_GTFRI_22 + '\r\n'));
    expect(frames).toHaveLength(1);
  });

  it('resyncs after implausible binary length', () => {
    const noise = Buffer.from([0x2b, 0x00, 0xff, 0xff]); // declared length 65535 > 1440
    const f = new MixedFramer();
    const frames = f.push(Buffer.concat([noise, Buffer.from(REAL_GTFRI_22)]));
    // resync walks forward and eventually finds the ASCII frame
    expect(frames.some((x) => x.kind === 'ascii')).toBe(true);
  });
});

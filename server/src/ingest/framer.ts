import { crc8 } from './crc8.js';
import type { Frame } from './types.js';

const MAX_BUFFER = 64 * 1024; // runaway guard: no legal frame is anywhere near this

/**
 * Stateful framer for the mixed Queclink stream: printable ASCII @Track frames
 * ($-terminated) interleaved with binary @Track Protocol Pro frames
 * (length-framed; may legally contain 0x24). One instance per TCP connection.
 *
 * Never split this stream on '$' — binary frames are framed by their length
 * field, and the discriminator is the second byte (0x00/0x10 are unprintable
 * and never begin an ASCII command word).
 */
export class MixedFramer {
  private buf: Buffer = Buffer.alloc(0);
  /** Frames whose CRC or tail check failed — discarded but counted for health. */
  corruptFrames = 0;

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    let i = 0;
    const buf = this.buf;

    while (i < buf.length) {
      const b0 = buf[i];

      // Inter-frame filler
      if (b0 === 0x0d || b0 === 0x0a || b0 === 0x20) {
        i += 1;
        continue;
      }

      const b1 = i + 1 < buf.length ? buf[i + 1] : undefined;
      if ((b0 === 0x2b || b0 === 0x2d) && b1 === undefined) break; // need more bytes

      if ((b0 === 0x2b || b0 === 0x2d) && (b1 === 0x00 || b1 === 0x10)) {
        // Binary Protocol Pro frame
        let need: number;
        if (b1 === 0x10) {
          need = 24; // heartbeat is fixed-size
        } else {
          if (i + 4 > buf.length) break; // wait for length field
          need = (buf[i + 2] << 8) | buf[i + 3];
          if (need < 20 || need > 1440) {
            // implausible length — noise; resync one byte forward
            i += 1;
            continue;
          }
        }
        if (i + need > buf.length) break; // wait for the full frame
        const f = buf.subarray(i, i + need);
        if (f[f.length - 1] === 0x24 && crc8(f.subarray(0, f.length - 2)) === f[f.length - 2]) {
          frames.push(b1 === 0x10 ? { kind: 'heartbeat', bytes: Buffer.from(f) } : { kind: 'binary', bytes: Buffer.from(f) });
        } else {
          this.corruptFrames++;
        }
        i += need;
        continue;
      }

      // ASCII frame: up to and including the next '$'
      const j = buf.indexOf(0x24, i);
      if (j < 0) break; // wait for terminator
      frames.push({ kind: 'ascii', text: buf.subarray(i, j + 1).toString('ascii') });
      i = j + 1;
    }

    this.buf = buf.subarray(i);
    if (this.buf.length > MAX_BUFFER) {
      // Something is wrong (binary garbage with no terminator) — drop and resync.
      this.corruptFrames++;
      this.buf = Buffer.alloc(0);
    }
    return frames;
  }
}

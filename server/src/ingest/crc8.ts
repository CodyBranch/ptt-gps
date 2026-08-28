/** CRC-8 for @Track Protocol Pro frames: poly 0x31, init 0xFF, no reflection, no final XOR. */
export function crc8(data: Buffer | Uint8Array): number {
  let crc = 0xff;
  for (const b of data) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

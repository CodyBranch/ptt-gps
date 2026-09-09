import { describe, expect, it } from 'vitest';
import { scoreboardDistance } from '../src/outputs/publisher.js';

/**
 * The scoreboard prints this string as it arrives, so the exact characters are
 * the contract - spacing included.
 */
describe('the distance as the scoreboard shows it', () => {
  it('closes up kilometres and spaces miles, as the boards are set out', () => {
    expect(scoreboardDistance(1.2, 'kilometers')).toBe('1.2k');
    expect(scoreboardDistance(1.2, 'miles')).toBe('1.2 mi');
  });

  it('always shows one decimal, so the width does not jump as a race runs', () => {
    // A scoreboard that reflows between "5 mi" and "5.4 mi" is worse to read
    // than one that always shows the same shape.
    expect(scoreboardDistance(5, 'miles')).toBe('5.0 mi');
    expect(scoreboardDistance(0, 'kilometers')).toBe('0.0k');
    expect(scoreboardDistance(26.2, 'miles')).toBe('26.2 mi');
  });

  it('rounds rather than truncating', () => {
    expect(scoreboardDistance(1.26, 'miles')).toBe('1.3 mi');
    expect(scoreboardDistance(1.24, 'miles')).toBe('1.2 mi');
    expect(scoreboardDistance(9.99, 'kilometers')).toBe('10.0k');
  });

  it('handles a distance long enough to matter', () => {
    expect(scoreboardDistance(100.4, 'kilometers')).toBe('100.4k');
    expect(scoreboardDistance(160.9, 'kilometers')).toBe('160.9k');
  });

  it('rounds a hairline value the way toFixed does, which is down', () => {
    // 100.05 is not exactly representable in binary floating point, so it
    // lands a hair under and rounds down. Left as it is: this is what the
    // legacy publisher did, and half a tenth of a mile is not visible on a
    // scoreboard. Pinned so nobody "fixes" it into a difference later.
    expect(scoreboardDistance(100.05, 'kilometers')).toBe('100.0k');
  });
});

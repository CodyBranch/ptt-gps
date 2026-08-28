import { describe, expect, it } from 'vitest';
import { FixGate } from '../src/ingest/hygiene.js';
import type { Fix } from '../src/ingest/types.js';

const NOW = 1756400000000;

function fix(over: Partial<Fix>): Fix {
  return {
    imei: '015181000128000',
    lat: 42.23,
    lon: -71.51,
    tUtcMs: NOW,
    fixValid: true,
    buffered: false,
    source: 'test',
    protocol: 'gtfri-22',
    raw: '',
    receivedAtMs: NOW,
    ...over,
  };
}

describe('FixGate', () => {
  it('accepts a normal live fix', () => {
    expect(new FixGate().accept(fix({}))).toEqual({ ok: true });
  });

  it('rejects no-fix frames (device repeating last-known position)', () => {
    expect(new FixGate().accept(fix({ fixValid: false })).reason).toBe('no-fix');
  });

  it('rejects 0,0 and non-finite coordinates', () => {
    expect(new FixGate().accept(fix({ lat: 0, lon: 0 })).reason).toBe('bad-coords');
    expect(new FixGate().accept(fix({ lat: NaN })).reason).toBe('bad-coords');
  });

  it('rejects out-of-order fixes (buffered backlog after real-time)', () => {
    const g = new FixGate();
    expect(g.accept(fix({ tUtcMs: NOW })).ok).toBe(true);
    expect(g.accept(fix({ tUtcMs: NOW - 30_000, buffered: true })).reason).toBe('stale');
    expect(g.accept(fix({ tUtcMs: NOW })).reason).toBe('stale'); // duplicate timestamp
    expect(g.accept(fix({ tUtcMs: NOW + 10_000 })).ok).toBe(true);
  });

  it('keeps chronology per-IMEI, not global', () => {
    const g = new FixGate();
    expect(g.accept(fix({ tUtcMs: NOW })).ok).toBe(true);
    expect(g.accept(fix({ imei: '860201060067272', tUtcMs: NOW - 60_000 })).ok).toBe(true);
  });

  it('rejects the first-connect history flood (fixes far in the past)', () => {
    const g = new FixGate();
    // GV500 empties storage since manufacture — dates back to 2009
    expect(g.accept(fix({ tUtcMs: Date.UTC(2009, 0, 1), receivedAtMs: NOW })).reason).toBe('too-old');
    expect(g.accept(fix({ tUtcMs: 0, receivedAtMs: NOW })).reason).toBe('too-old');
  });

  it('rejects future-dated fixes (bad device clock)', () => {
    expect(new FixGate().accept(fix({ tUtcMs: NOW + 3600_000 })).reason).toBe('future');
  });

  it('detects count-number gaps, with 16-bit wraparound', () => {
    const g = new FixGate();
    g.accept(fix({ tUtcMs: NOW, countNumber: 10 }));
    g.accept(fix({ tUtcMs: NOW + 1000, countNumber: 11 }));
    g.accept(fix({ tUtcMs: NOW + 2000, countNumber: 15 })); // lost 12,13,14
    expect(g.health('015181000128000').gapsDetected).toBe(3);
    const g2 = new FixGate();
    g2.accept(fix({ tUtcMs: NOW, countNumber: 0xffff }));
    g2.accept(fix({ tUtcMs: NOW + 1000, countNumber: 0x0000 })); // clean wrap
    expect(g2.health('015181000128000').gapsDetected).toBe(0);
  });

  it('tracks rejection counts for health reporting', () => {
    const g = new FixGate();
    g.accept(fix({ fixValid: false }));
    g.accept(fix({ fixValid: false }));
    expect(g.health('015181000128000').rejected['no-fix']).toBe(2);
  });
});

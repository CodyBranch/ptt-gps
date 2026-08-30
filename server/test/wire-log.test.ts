import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/state/store.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wire-')), 'w.db');

describe('wire log retention', () => {
  it('keeps the newest N frames and drops the rest', () => {
    const s = new Store(tmp());
    // real frames are stamped with the wall clock; epoch-1970 times would be
    // swept by the age limit before the count limit was exercised at all
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      s.queueWireFrame({ tMs: now - (50 - i) * 1000, source: 'queclink', ip: '1.2.3.4', binary: false, bytes: 10, text: `f${i}` });
    }
    s.flushWireFrames();
    expect(s.wireStats().frames).toBe(50);

    s.pruneWireFrames(10, 24 * 3600_000);
    const left = s.wireHistory({ limit: 100 });
    expect(left).toHaveLength(10);
    // newest survive, oldest go
    expect(left[0].text).toBe('f49');
    expect(left[9].text).toBe('f40');
  });

  it('drops frames past the age limit whatever the count', () => {
    const s = new Store(tmp());
    const old = Date.now() - 10 * 24 * 3600_000;
    s.queueWireFrame({ tMs: old, source: 'q', ip: '1.1.1.1', binary: false, bytes: 5, text: 'ancient' });
    s.queueWireFrame({ tMs: Date.now(), source: 'q', ip: '1.1.1.1', binary: false, bytes: 5, text: 'fresh' });
    s.flushWireFrames();

    s.pruneWireFrames(1000, 7 * 24 * 3600_000);
    const left = s.wireHistory({ limit: 10 });
    expect(left.map((f) => f.text)).toEqual(['fresh']);
  });

  it('pages backwards without repeating or skipping a frame', () => {
    const s = new Store(tmp());
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      s.queueWireFrame({ tMs: t0 - (25 - i) * 1000, source: 'q', ip: '1.1.1.1', binary: false, bytes: 5, text: `f${i}` });
    }
    const first = s.wireHistory({ limit: 10 });
    const second = s.wireHistory({ limit: 10, before: first[first.length - 1].id });
    const third = s.wireHistory({ limit: 10, before: second[second.length - 1].id });
    const seen = [...first, ...second, ...third].map((f) => f.text);
    expect(new Set(seen).size).toBe(25); // no repeats
    expect(seen).toHaveLength(25); // and nothing missed
  });

  it('filters by imei and by free text', () => {
    const s = new Store(tmp());
    s.queueWireFrame({ tMs: Date.now(), source: 'q', ip: '10.0.0.1', binary: false, bytes: 5, imei: '111111111111111', text: 'a' });
    s.queueWireFrame({ tMs: Date.now(), source: 'q', ip: '10.0.0.2', binary: false, bytes: 5, imei: '222222222222222', text: 'b' });
    expect(s.wireHistory({ imei: '111111111111111' }).map((f) => f.text)).toEqual(['a']);
    expect(s.wireHistory({ q: '10.0.0.2' }).map((f) => f.text)).toEqual(['b']);
  });
});

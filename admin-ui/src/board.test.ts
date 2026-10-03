import { describe, expect, it } from 'vitest';
import { defaultBoardConfig, type BoardConfig } from './types';
import {
  atFraction,
  bestRotation,
  cumulativeFractions,
  metresBetween,
  project,
  smoothPath,
  thin,
  toUnits,
  unitPosts,
  unproject,
  withBoardDefaults,
  isLight,
  type Box,
} from './board';

/**
 * The course board's maths.
 *
 * This is the half that can be wrong without looking wrong: a course drawn
 * stretched, a vehicle a hundred metres off the line it is driving down, a
 * mile post at the kilometre. All of it reads as "the GPS is bad" to everyone
 * watching, so it is pinned here rather than eyeballed on a monitor.
 */

const BOX: Box = { x: 40, y: 132, w: 1216, h: 856, pad: 72 };

/** A square-ish loop near Tallahassee, in [lon, lat]. */
const loop: number[][] = [
  [-84.3, 30.44],
  [-84.29, 30.44],
  [-84.29, 30.45],
  [-84.3, 30.45],
  [-84.3, 30.44],
];

describe('measuring along a course', () => {
  it('measures a degree of latitude at about 111 km', () => {
    expect(metresBetween(-84.3, 30.0, -84.3, 31.0)).toBeCloseTo(111195, -2);
  });

  it('squashes longitude by latitude, so east-west is shorter than north-south', () => {
    const northSouth = metresBetween(-84.3, 30.44, -84.3, 30.45);
    const eastWest = metresBetween(-84.3, 30.44, -84.29, 30.44);
    // cos(30.44°) ≈ 0.862
    expect(eastWest / northSouth).toBeCloseTo(0.862, 2);
  });

  it('spaces fractions by real distance, not by index', () => {
    // Three points where the second leg is three times the first.
    const line = [[0, 0], [0, 0.01], [0, 0.04]];
    const f = cumulativeFractions(line);
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(0.25, 3);
    expect(f[2]).toBe(1);
  });

  it('survives a course whose points are all the same', () => {
    expect(cumulativeFractions([[0, 0], [0, 0]])).toEqual([0, 0]);
    expect(cumulativeFractions([])).toEqual([]);
  });
});

describe('placing a distance on the line', () => {
  const fractions = cumulativeFractions(loop);

  it('finds the start, the end and a point between', () => {
    expect(atFraction(loop, fractions, 0)).toEqual([-84.3, 30.44]);
    expect(atFraction(loop, fractions, 1)).toEqual([-84.3, 30.44]);
    const mid = atFraction(loop, fractions, 0.5)!;
    expect(mid[0]).toBeGreaterThanOrEqual(-84.3);
    expect(mid[0]).toBeLessThanOrEqual(-84.29);
  });

  it('clamps rather than running off the end of the course', () => {
    expect(atFraction(loop, fractions, -5)).toEqual([-84.3, 30.44]);
    expect(atFraction(loop, fractions, 5)).toEqual([-84.3, 30.44]);
  });
});

describe('fitting the course to the board', () => {
  it('keeps the whole course inside the box', () => {
    const p = project(loop, BOX);
    for (const [lon, lat] of loop) {
      const [x, y] = p.point(lon, lat);
      expect(x).toBeGreaterThanOrEqual(BOX.x);
      expect(x).toBeLessThanOrEqual(BOX.x + BOX.w);
      expect(y).toBeGreaterThanOrEqual(BOX.y);
      expect(y).toBeLessThanOrEqual(BOX.y + BOX.h);
    }
  });

  it('does not stretch the course: a square loop stays square', () => {
    const p = project(loop, BOX);
    const [x0, y0] = p.point(-84.3, 30.44);
    const [x1] = p.point(-84.29, 30.44);
    const [, y1] = p.point(-84.3, 30.45);
    // The loop is 0.01° each way, which on the ground is 0.862 as wide as tall.
    expect(Math.abs(x1 - x0) / Math.abs(y1 - y0)).toBeCloseTo(0.862, 2);
  });

  it('puts north at the top', () => {
    const p = project(loop, BOX);
    expect(p.point(-84.3, 30.45)[1]).toBeLessThan(p.point(-84.3, 30.44)[1]);
  });

  it('zooming keeps the centre still and spreads the course', () => {
    const fit = project(loop, BOX);
    const close = project(loop, BOX, 4);
    expect(close.scale).toBeCloseTo(fit.scale * 4, 5);
    const c: [number, number] = [-84.295, 30.445];
    // The centre of the course stays in the middle of the box at any zoom.
    expect(fit.point(...c)[0]).toBeCloseTo(close.point(...c)[0], 0);
  });

  it('a pan and the drag that produced it are inverses', () => {
    const p = project(loop, BOX, 3, [-84.295, 30.445]);
    const px = BOX.x + BOX.w / 2 + 120;
    const py = BOX.y + BOX.h / 2 - 80;
    const [lon, lat] = unproject(p, loop, BOX, px, py);
    const [backX, backY] = p.point(lon, lat);
    expect(backX).toBeCloseTo(px, 3);
    expect(backY).toBeCloseTo(py, 3);
  });
});

describe('drawing the line', () => {
  it('thins points that are on top of each other, keeping the ends', () => {
    const dense: [number, number][] = [[0, 0], [1, 0], [2, 0], [300, 0], [301, 0]];
    const out = thin(dense, 5);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([301, 0]);
    expect(out.length).toBeLessThan(dense.length);
  });

  it('writes a curve through every point it was given', () => {
    const d = smoothPath([[0, 0], [10, 10], [20, 0], [30, 10]]);
    expect(d.startsWith('M 0.0 0.0')).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
  });

  it('draws something sane for one or two points', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[5, 5]])).toBe('M 5.0 5.0');
    expect(smoothPath([[0, 0], [10, 10]])).toContain('L');
  });
});

describe('distance posts', () => {
  it('counts in the units asked for, not the course units', () => {
    // A 5 km course is 3.107 miles, so 1 and 2 fit; 3 miles lands 170 m from
    // the finish and is left out by the rule below.
    const posts = unitPosts(5, 'kilometers', 'miles');
    expect(posts.map((p) => p.label)).toEqual(['1 MI', '2 MI']);
    // ...and each is placed back in the course's own units.
    expect(posts[0].at).toBeCloseTo(toUnits(1, 'miles', 'kilometers'), 5);
  });

  it('leaves no post sitting on the finish line', () => {
    // Exactly 5 km: a post at 5 would land on the finish marker.
    expect(unitPosts(5, 'kilometers', 'kilometers').map((p) => p.label)).toEqual(['1K', '2K', '3K', '4K']);
    // 5.4 km has room for one at 5.
    expect(unitPosts(5.4, 'kilometers', 'kilometers').map((p) => p.label)).toContain('5K');
  });

  it('gives a short course no posts at all', () => {
    expect(unitPosts(0.8, 'kilometers', 'miles')).toEqual([]);
  });
});

describe('turning the course to fit the frame', () => {
  /** A lakefront out-and-back: 2.5 km north to south, 400 m across. */
  const outAndBack: number[][] = [
    [-87.89903, 43.03662],
    [-87.90028, 43.03114],
    [-87.89508, 43.01442],
    [-87.89714, 43.0194],
    [-87.89903, 43.03662],
  ];

  it('turns a tall course a quarter so it runs across a wide frame', () => {
    expect(bestRotation(outAndBack, BOX)).toBe(90);
  });

  it('leaves a course that already fits the right way up', () => {
    // The square loop needs no help, and north up is worth keeping.
    expect(bestRotation(loop, BOX)).toBe(0);
  });

  it('turning fills more of the frame than not turning', () => {
    const upright = project(outAndBack, BOX, 1, null, 0);
    const turned = project(outAndBack, BOX, 1, null, 90);
    expect(turned.scale).toBeGreaterThan(upright.scale * 1.1);
  });

  it('keeps every point inside the box once turned', () => {
    const p = project(outAndBack, BOX, 1, null, 90);
    for (const [lon, lat] of outAndBack) {
      const [x, y] = p.point(lon, lat);
      expect(x).toBeGreaterThanOrEqual(BOX.x);
      expect(x).toBeLessThanOrEqual(BOX.x + BOX.w);
      expect(y).toBeGreaterThanOrEqual(BOX.y);
      expect(y).toBeLessThanOrEqual(BOX.y + BOX.h);
    }
  });

  it('a drag still lands where it was dropped, at any rotation', () => {
    for (const deg of [0, 90, 180, 270] as const) {
      const p = project(outAndBack, BOX, 2, [-87.897, 43.025], deg);
      const px = BOX.x + BOX.w / 2 + 90;
      const py = BOX.y + BOX.h / 2 - 50;
      const [lon, lat] = unproject(p, outAndBack, BOX, px, py);
      const [backX, backY] = p.point(lon, lat);
      expect(backX).toBeCloseTo(px, 3);
      expect(backY).toBeCloseTo(py, 3);
    }
  });
});

describe('a config saved before today', () => {
  it('fills in fields that did not exist when it was stored', () => {
    // Twice now a new switch has read as off on every board set up before it
    // shipped, because a missing boolean is falsy.
    const old = { units: 'kilometers', zoom: 2 } as unknown as BoardConfig;
    const out = withBoardDefaults(old);
    expect(out.units).toBe('kilometers');
    expect(out.zoom).toBe(2);
    expect(out.layout.logo).toBe('right');
    expect(out.rotate).toBe('auto');
    expect(out.theme.bg).toBe(defaultBoardConfig().theme.bg);
  });

  it('keeps a half-filled nested block rather than replacing it', () => {
    const out = withBoardDefaults({ theme: { bg: '#000000' }, layout: { footer: false } } as unknown as BoardConfig);
    expect(out.theme.bg).toBe('#000000');
    expect(out.theme.text).toBe(defaultBoardConfig().theme.text);
    expect(out.layout.footer).toBe(false);
    expect(out.layout.logo).toBe('right');
  });

  it('gives a board with no config at all the defaults', () => {
    expect(withBoardDefaults(undefined)).toEqual(defaultBoardConfig());
  });
});

describe('picking the readable copy of the wordmark', () => {
  it('knows a dark footer from a light one', () => {
    expect(isLight('#0c1a2c')).toBe(false);
    expect(isLight('#152b4d')).toBe(false);
    expect(isLight('#ffffff')).toBe(true);
    expect(isLight('#f1f5f9')).toBe(true);
  });

  it('weights green the way the eye does', () => {
    // Pure blue is dark to look at; pure green is not, at the same value.
    expect(isLight('#0000ff')).toBe(false);
    expect(isLight('#00ff00')).toBe(true);
  });

  it('treats anything that is not a colour as dark, which is the common case', () => {
    expect(isLight('rgb(255,255,255)')).toBe(false);
    expect(isLight('')).toBe(false);
  });
});

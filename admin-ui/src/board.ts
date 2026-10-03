import type { BoardConfig, PlacedMarker, RaceSnap, RoleState, TrackerPub, Units } from './types';

/**
 * The maths behind the course board.
 *
 * Kept out of the component because it is the part that can be wrong in ways
 * nobody sees until a vehicle is drawn in a field: a projection off by a
 * cosine, a distance compared in the wrong units, a marker placed by index
 * instead of by distance. All of it is pure, so it can be checked without a
 * browser.
 *
 * Everything positional works in fractions of the course rather than in metres
 * or miles. The course's own units, the race's units and the board's chosen
 * display units are three different things, and a fraction is none of them.
 */

export const MI_PER_KM = 0.621371;

export const toUnits = (value: number, from: Units, to: Units): number =>
  from === to ? value : from === 'miles' ? value / MI_PER_KM : value * MI_PER_KM;

export const unitLabel = (u: Units): string => (u === 'miles' ? 'mi' : 'km');

/** Metres between two points, good to a metre at course scale. */
export function metresBetween(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const lat = ((aLat + bLat) / 2) * rad;
  const x = dLon * Math.cos(lat);
  return Math.sqrt(x * x + dLat * dLat) * R;
}

/**
 * Where each point sits along the course, as a fraction from 0 to 1.
 *
 * Measured from the trace itself rather than assumed even: a course is traced
 * by walking it, so its points are dense on the bends and sparse on the
 * straights, and spacing them evenly would put every marker in the wrong place.
 */
export function cumulativeFractions(coords: number[][]): number[] {
  if (coords.length === 0) return [];
  const running: number[] = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += metresBetween(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    running.push(total);
  }
  if (total <= 0) return coords.map(() => 0);
  return running.map((m) => m / total);
}

export interface Projection {
  /** Course coordinates [lon, lat] to board pixels. */
  point: (lon: number, lat: number) => [number, number];
  /** The projected centre currently in the middle of the box. */
  center: [number, number];
  scale: number;
  rotation: Rotation;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  pad: number;
}

/**
 * Fit the course into the box, then apply the operator's zoom and pan.
 *
 * Longitude is squashed by the cosine of latitude so the course is not
 * stretched sideways - at 40 degrees north a degree of longitude is three
 * quarters of a degree of latitude, which is the difference between a running
 * track and an oval.
 */
export type Rotation = 0 | 90 | 180 | 270;

/** Turn the projected plane a quarter at a time. Shape is preserved. */
const turn = (x: number, y: number, deg: Rotation): [number, number] =>
  deg === 90 ? [-y, x] : deg === 180 ? [-x, -y] : deg === 270 ? [y, -x] : [x, y];

/**
 * Which way round the course fits the box best.
 *
 * An out-and-back along a lakefront is two and a half kilometres north to
 * south and four hundred metres across, and drawn north-up on a 16:9 screen it
 * is a sliver using a tenth of the frame. Turning it a quarter is what anyone
 * drawing this by hand would do, and it costs nothing but north being sideways
 * - which the operator can override either way.
 */
export function bestRotation(coords: number[][], box: Box): Rotation {
  if (coords.length < 2) return 0;
  const lats = coords.map((c) => c[1]);
  const lat0 = lats.reduce((a, b) => a + b, 0) / lats.length;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const fitFor = (deg: Rotation): number => {
    const pts = coords.map((c) => turn(c[0] * k, -c[1], deg));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const spanX = Math.max(...xs) - Math.min(...xs) || 1e-9;
    const spanY = Math.max(...ys) - Math.min(...ys) || 1e-9;
    return Math.min((box.w - 2 * box.pad) / spanX, (box.h - 2 * box.pad) / spanY);
  };
  // The gain has to be worth putting north on its side for. A near-square park
  // loop picks up about 15% from turning, which is not; a lakefront
  // out-and-back picks up half as much again, which is.
  return fitFor(90) > fitFor(0) * 1.25 ? 90 : 0;
}

export function project(
  coords: number[][],
  box: Box,
  zoom = 1,
  center: [number, number] | null = null,
  rotation: Rotation = 0,
): Projection {
  const lats = coords.map((c) => c[1]);
  const lat0 = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const turned = coords.map((c) => turn(c[0] * k, -c[1], rotation));
  const xs = turned.map((p) => p[0]);
  const ys = turned.map((p) => p[1]);

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;

  const fit = Math.min((box.w - 2 * box.pad) / spanX, (box.h - 2 * box.pad) / spanY);
  const scale = fit * Math.max(1, zoom);

  const focus: [number, number] = center
    ? turn(center[0] * k, -center[1], rotation)
    : [(minX + maxX) / 2, (minY + maxY) / 2];

  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    scale,
    center: focus,
    rotation,
    point: (lon, lat) => {
      const [tx, ty] = turn(lon * k, -lat, rotation);
      return [cx + (tx - focus[0]) * scale, cy + (ty - focus[1]) * scale];
    },
  };
}

/** Turn board pixels back into [lon, lat] — what a drag on the preview means. */
export function unproject(p: Projection, coords: number[][], box: Box, px: number, py: number): [number, number] {
  const lats = coords.map((c) => c[1]);
  const lat0 = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0;
  const k = Math.cos((lat0 * Math.PI) / 180) || 1;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const tx = (px - cx) / p.scale + p.center[0];
  const ty = (py - cy) / p.scale + p.center[1];
  // Undo the quarter turn before undoing the projection.
  const [x, y] = turn(tx, ty, ((360 - p.rotation) % 360) as Rotation);
  return [x / k, -y];
}

/**
 * A Catmull-Rom spline as cubic Béziers.
 *
 * A traced course drawn as straight segments is visibly faceted on a 1080p
 * canvas wherever the trace is sparse, and the faceting reads as the course
 * being wrong rather than the drawing being coarse.
 */
export function smoothPath(points: [number, number][]): string {
  if (points.length === 0) return '';
  if (points.length < 3) return `M ${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;

  const at = (i: number): [number, number] => points[Math.min(points.length - 1, Math.max(0, i))];
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Thin out points closer together than `minPx`, always keeping the last. */
export function thin(points: [number, number][], minPx = 5): [number, number][] {
  if (points.length < 3) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(points[i][0] - last[0], points[i][1] - last[1]) >= minPx) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** The point a fraction of the way along the course. */
export function atFraction(coords: number[][], fractions: number[], f: number): [number, number] | null {
  if (coords.length === 0) return null;
  const t = Math.min(1, Math.max(0, f));
  for (let i = 1; i < fractions.length; i++) {
    if (fractions[i] >= t) {
      const span = fractions[i] - fractions[i - 1] || 1;
      const r = (t - fractions[i - 1]) / span;
      const a = coords[i - 1], b = coords[i];
      return [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
    }
  }
  return [coords[coords.length - 1][0], coords[coords.length - 1][1]];
}

/** Whole-unit distance posts, in the units asked for rather than the course's. */
export function unitPosts(courseLength: number, courseUnits: Units, want: Units): Array<{ at: number; label: string }> {
  const total = toUnits(courseLength, courseUnits, want);
  const out: Array<{ at: number; label: string }> = [];
  // Nothing within the last 15% of a step: a post sitting on the finish line
  // is two labels on one spot and neither reads.
  for (let n = 1; n < total - 0.15; n++) {
    out.push({ at: toUnits(n, want, courseUnits), label: `${n}${want === 'miles' ? ' MI' : 'K'}` });
  }
  return out;
}

export interface BoardGroupView {
  key: string;
  label: string;
  color: string;
  vehicle: string;
  /** The reporting tracker, if the role has one covering it. */
  tracker?: TrackerPub;
  /** Fraction of the course covered, or null when nothing has been reported. */
  fraction: number | null;
  /** Covered distance in the course's units. */
  covered: number | null;
  stale: boolean;
  showDistance: boolean;
  showMarker: boolean;
}

const DEFAULTS = { shown: true, distance: true, marker: true };

/**
 * The groups to draw, in the operator's order.
 *
 * A role with no vehicle is still a group: at a marathon the wheelchair lead
 * car is assigned an hour before anybody drives it, and a panel that only
 * grows as vehicles appear is a panel that moves under the operator while the
 * race is on.
 */
export function boardGroups(race: RaceSnap, config: BoardConfig, colors: string[]): BoardGroupView[] {
  const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
  const ordered: RoleState[] = [];
  for (const key of config.order) {
    const role = race.roles.find((r) => r.key === key);
    if (role) ordered.push(role);
  }
  for (const role of race.roles) if (!ordered.includes(role)) ordered.push(role);

  return ordered
    .map((role, i) => {
      const g = config.groups[role.key] ?? DEFAULTS;
      const tracker = role.activeImei ? byImei.get(role.activeImei) : undefined;
      const covered = tracker?.distance ?? null;
      return {
        key: role.key,
        label: role.label,
        color: config.groups[role.key]?.color ?? colors[i % colors.length],
        vehicle: race.vehicles.find((v) => v.key === role.vehicle)?.label ?? '',
        tracker,
        covered,
        fraction: covered === null || race.courseLength <= 0 ? null : Math.min(1, covered / race.courseLength),
        stale: !!tracker?.suspect,
        showDistance: g.distance !== false,
        showMarker: g.marker !== false,
        shown: g.shown !== false,
      };
    })
    .filter((g) => (g as { shown: boolean }).shown)
    .map(({ ...g }) => g as BoardGroupView);
}

/** The figure under a group's name, in the board's units and mode. */
export function groupValue(
  g: BoardGroupView,
  race: RaceSnap,
  config: BoardConfig,
): { text: string; unit: string } {
  if (g.covered === null) return { text: '—', unit: '' };
  if (config.value === 'percent') {
    return { text: `${Math.round((g.fraction ?? 0) * 100)}`, unit: '%' };
  }
  const raw = config.value === 'remaining' ? Math.max(0, race.courseLength - g.covered) : g.covered;
  return {
    text: toUnits(raw, race.units, config.units).toFixed(config.decimals),
    unit: unitLabel(config.units),
  };
}

/** Which markers to draw, after the operator's choices. */
export function visibleMarkers(markers: PlacedMarker[], config: BoardConfig): PlacedMarker[] {
  return markers.filter((m) => {
    if (m.kind === 'start') return config.markers.start;
    if (m.kind === 'finish') return config.markers.finish;
    if (m.kind === 'timing') return config.markers.timing;
    if (m.kind === 'custom') return config.markers.custom;
    // Distance posts are drawn from the board's own choice of units, not from
    // whatever the course happens to carry.
    return false;
  });
}

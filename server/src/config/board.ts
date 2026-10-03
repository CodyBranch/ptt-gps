/**
 * What the course board is showing.
 *
 * The board is a 1920x1080 graphic with no controls on it - it goes to a
 * capture card, a projector or a monitor in a truck, and anything drawn on top
 * of it is in shot. So what it shows is state here, set from a control page
 * that may be in another room, and pushed to the board the moment it changes.
 *
 * One board per meet. A marathon runs its men's, women's and wheelchair
 * leaders as separate roles of one race, and the board is built around showing
 * several of those at once - which is why nearly everything here is per role
 * rather than per race.
 */

export type UnitSystem = 'miles' | 'kilometers';

/** What a role's figure counts. */
export type ValueMode = 'covered' | 'remaining' | 'percent';

export interface BoardGroup {
  /** On the panel at all. A role nobody is following is just noise. */
  shown: boolean;
  /** Its figure. Off leaves the name and the bar, which is how you show that a
   *  group is being tracked without putting a number on air. */
  distance: boolean;
  /** Its dot on the course. */
  marker: boolean;
  /** Panel accent and dot colour. */
  color: string;
}

export interface BoardConfig {
  /** The race on the board, or null to follow whichever one is running. */
  raceId: string | null;
  /** Overrides the race name in the header. Blank uses the race's own. */
  title: string;
  units: UnitSystem;
  decimals: number;
  value: ValueMode;
  /** Which distance posts to draw, independent of the course's own units. */
  posts: 'none' | 'miles' | 'kilometers' | 'both';
  markers: { start: boolean; finish: boolean; timing: boolean; custom: boolean };
  /** Per role key. Roles with no entry fall back to the default below. */
  groups: Record<string, BoardGroup>;
  /** Panel order, by role key. Anything not listed follows in race order. */
  order: string[];
  /** Whose progress lights the course and whom the map follows. */
  lead: string | null;
  /** Keep the lead group centred as it moves. */
  follow: boolean;
  /** 1 fits the whole course; above that zooms in. */
  zoom: number;
  /** Centre, in course coordinates [lon, lat]. Null centres on the course. */
  center: [number, number] | null;
  /** Light the course behind the lead group. */
  showDone: boolean;
  /** The clock, when a race is running. */
  showClock: boolean;
}

/** Colours assigned to groups in order; chosen to read at a distance. */
export const GROUP_COLORS = ['#e11d48', '#38bdf8', '#f59e0b', '#22c55e', '#a78bfa', '#f472b6'];

export const DEFAULT_GROUP: BoardGroup = { shown: true, distance: true, marker: true, color: GROUP_COLORS[0] };

export function defaultBoard(): BoardConfig {
  return {
    raceId: null,
    title: '',
    units: 'miles',
    decimals: 2,
    value: 'covered',
    posts: 'none',
    markers: { start: true, finish: true, timing: true, custom: true },
    groups: {},
    order: [],
    lead: null,
    follow: false,
    zoom: 1,
    center: null,
    showDone: true,
    showClock: true,
  };
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : fallback;

/**
 * Take whatever arrived and return something the board can draw.
 *
 * Deliberately forgiving rather than strict: this is read on every snapshot by
 * a page with no controls and nobody watching it, and a board that refuses to
 * render because a saved field is the wrong shape is a black rectangle on air.
 * Anything unrecognised falls back to the default for that field.
 */
export function normaliseBoard(input: unknown): BoardConfig {
  const d = defaultBoard();
  if (!input || typeof input !== 'object') return d;
  const raw = input as Record<string, unknown>;
  const markers = (raw.markers ?? {}) as Record<string, unknown>;

  const groups: Record<string, BoardGroup> = {};
  if (raw.groups && typeof raw.groups === 'object') {
    for (const [key, value] of Object.entries(raw.groups as Record<string, unknown>)) {
      const g = (value ?? {}) as Record<string, unknown>;
      groups[key] = {
        shown: bool(g.shown, DEFAULT_GROUP.shown),
        distance: bool(g.distance, DEFAULT_GROUP.distance),
        marker: bool(g.marker, DEFAULT_GROUP.marker),
        color: str(g.color, DEFAULT_GROUP.color),
      };
    }
  }

  const center = Array.isArray(raw.center) && raw.center.length === 2 && raw.center.every((n) => typeof n === 'number')
    ? ([raw.center[0], raw.center[1]] as [number, number])
    : null;

  return {
    raceId: typeof raw.raceId === 'string' && raw.raceId ? raw.raceId : null,
    title: str(raw.title, d.title),
    units: oneOf(raw.units, ['miles', 'kilometers'] as const, d.units),
    decimals: Math.round(num(raw.decimals, d.decimals, 0, 3)),
    value: oneOf(raw.value, ['covered', 'remaining', 'percent'] as const, d.value),
    posts: oneOf(raw.posts, ['none', 'miles', 'kilometers', 'both'] as const, d.posts),
    markers: {
      start: bool(markers.start, d.markers.start),
      finish: bool(markers.finish, d.markers.finish),
      timing: bool(markers.timing, d.markers.timing),
      custom: bool(markers.custom, d.markers.custom),
    },
    groups,
    order: Array.isArray(raw.order) ? raw.order.filter((k): k is string => typeof k === 'string') : d.order,
    lead: typeof raw.lead === 'string' && raw.lead ? raw.lead : null,
    follow: bool(raw.follow, d.follow),
    zoom: num(raw.zoom, d.zoom, 1, 12),
    center,
    showDone: bool(raw.showDone, d.showDone),
    showClock: bool(raw.showClock, d.showClock),
  };
}

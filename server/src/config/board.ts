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

/**
 * The board's colours.
 *
 * Every one of these reaches the page as a CSS custom property on the SVG, so
 * a meet can be given its own scheme without a rebuild. They are validated as
 * hex and nothing else: they end up in a style attribute, and a field that
 * accepts arbitrary text there is a way to put arbitrary CSS on a screen that
 * is going out live.
 */
export interface BoardTheme {
  bg: string;
  panel: string;
  text: string;
  dim: string;
  /** The untravelled course line, and the halo under it. */
  course: string;
  glow: string;
  /** Start, finish and timing-point markers. */
  start: string;
  finish: string;
  timing: string;
  /** Whole-unit distance posts. */
  post: string;
  milePost: string;
  /** The wordmark in the footer. Blank hides it. */
  brand: string;
  brandText: string;
}

export interface BoardLayout {
  /** Which side the group panel sits on, or none for a full-bleed map. */
  panel: 'right' | 'left' | 'none';
  header: boolean;
  footer: boolean;
  /**
   * Where the Primetime mark sits in the footer. On the right it stands in
   * for the wordmark, which is the corner a brand usually occupies; on the
   * left it leads and the wordmark keeps the right.
   */
  logo: 'left' | 'right' | 'none';
  /**
   * The map's credit line in the footer.
   *
   * Off by default, because it is clutter on a graphic going to air. It is
   * also the credit Mapbox and OpenStreetMap are owed for the imagery, and
   * turning the map's own corner logo off is only allowed where that credit
   * appears somewhere - so with this off it has to live somewhere else, on
   * the broadcast or on the event page. That is a call for whoever is running
   * the meet, which is why it is a switch rather than a decision taken here.
   */
  credit: boolean;
  /** Scales every figure and label together, for a screen further away. */
  typeScale: number;
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
  /**
   * Turn the course a quarter at a time to fit the frame, or 'auto' to let it
   * choose. An out-and-back drawn north-up on a 16:9 screen is a sliver.
   */
  rotate: 'auto' | 0 | 90 | 180 | 270;
  /** Centre, in course coordinates [lon, lat]. Null centres on the course. */
  center: [number, number] | null;
  /** Light the course behind the lead group. */
  /**
   * A map under the course, or a flat field.
   *
   * A traced line on an empty background says where the leaders are on the
   * course and nothing about where the course is. On a board going out to a
   * crowd who know the town, the lake, the park and the bridge do more work
   * than any label would.
   */
  imagery: 'none' | 'satellite' | 'streets' | 'dark' | 'outdoors';
  /** How far to knock the map back so the course and its labels still read. */
  imageryDim: number;
  showDone: boolean;
  /** The clock, when a race is running. */
  showClock: boolean;
  theme: BoardTheme;
  layout: BoardLayout;
}

/**
 * Ready-made schemes.
 *
 * `chroma` is the one that earns its place: a flat key colour behind the
 * graphic so the board can be keyed over a camera feed, with the panel and
 * course kept off that exact hue so they do not key out with the background.
 */
export const BOARD_THEMES: Record<string, BoardTheme> = {
  primetime: {
    bg: '#060d18', panel: '#0c1a2c', text: '#ffffff', dim: '#7e93b4',
    course: '#2e4a6e', glow: '#2563eb', start: '#16a34a', finish: '#ffffff',
    timing: '#38bdf8', post: '#64748b', milePost: '#eab308',
    brand: '#e11d48', brandText: 'PRIMETIME',
  },
  midnight: {
    bg: '#000000', panel: '#101418', text: '#ffffff', dim: '#8b949e',
    course: '#30363d', glow: '#58a6ff', start: '#2ea043', finish: '#ffffff',
    timing: '#58a6ff', post: '#6e7681', milePost: '#d29922',
    brand: '#f0f6fc', brandText: 'PRIMETIME',
  },
  daylight: {
    bg: '#f1f5f9', panel: '#ffffff', text: '#0f172a', dim: '#64748b',
    course: '#cbd5e1', glow: '#3b82f6', start: '#16a34a', finish: '#0f172a',
    timing: '#2563eb', post: '#94a3b8', milePost: '#ca8a04',
    brand: '#e11d48', brandText: 'PRIMETIME',
  },
  chroma: {
    bg: '#00b140', panel: '#0c1a2c', text: '#ffffff', dim: '#b8c6da',
    course: '#2e4a6e', glow: '#2563eb', start: '#ffffff', finish: '#ffffff',
    timing: '#38bdf8', post: '#94a3b8', milePost: '#eab308',
    brand: '#ffffff', brandText: 'PRIMETIME',
  },
};

export const defaultTheme = (): BoardTheme => ({ ...BOARD_THEMES.primetime });
export const defaultLayout = (): BoardLayout => ({
  panel: 'right', header: true, footer: true, logo: 'right', credit: false, typeScale: 1,
});

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
    rotate: 'auto',
    center: null,
    imagery: 'none',
    imageryDim: 0.45,
    showDone: true,
    showClock: true,
    theme: defaultTheme(),
    layout: defaultLayout(),
  };
}

/**
 * A colour we are willing to put in a style attribute.
 *
 * Hex only. These are written straight onto the board as custom properties,
 * and anything that is not a colour there is a way to put CSS of someone's
 * choosing on a screen that is going out live.
 */
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const color = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v : fallback);

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
/**
 * Does this look like a board at all?
 *
 * normaliseBoard fills in whatever is missing, which is what lets a board
 * saved by an older version load without a migration step. On a write that
 * same tolerance is a trap: a body in the wrong shape - a config wrapped in an
 * envelope, a client posting something else entirely - normalises cleanly to
 * the defaults and silently blanks whatever was on air, mid-race, with an ok
 * in the reply. So a write has to carry at least one field a board owns.
 */
export function isBoardLike(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.keys(defaultBoard()).some((key) => key in (input as Record<string, unknown>));
}

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
    rotate:
      raw.rotate === 0 || raw.rotate === 90 || raw.rotate === 180 || raw.rotate === 270 ? raw.rotate : 'auto',
    center,
    imagery: oneOf(raw.imagery, ['none', 'satellite', 'streets', 'dark', 'outdoors'] as const, d.imagery),
    imageryDim: num(raw.imageryDim, d.imageryDim, 0, 0.9),
    showDone: bool(raw.showDone, d.showDone),
    showClock: bool(raw.showClock, d.showClock),
    theme: normaliseTheme(raw.theme),
    layout: normaliseLayout(raw.layout),
  };
}

export function normaliseTheme(input: unknown): BoardTheme {
  const d = defaultTheme();
  if (!input || typeof input !== 'object') return d;
  const t = input as Record<string, unknown>;
  return {
    bg: color(t.bg, d.bg),
    panel: color(t.panel, d.panel),
    text: color(t.text, d.text),
    dim: color(t.dim, d.dim),
    course: color(t.course, d.course),
    glow: color(t.glow, d.glow),
    start: color(t.start, d.start),
    finish: color(t.finish, d.finish),
    timing: color(t.timing, d.timing),
    post: color(t.post, d.post),
    milePost: color(t.milePost, d.milePost),
    brand: color(t.brand, d.brand),
    // A wordmark is text rather than a colour, so it is length-capped instead.
    brandText: typeof t.brandText === 'string' ? t.brandText.slice(0, 24) : d.brandText,
  };
}

export function normaliseLayout(input: unknown): BoardLayout {
  const d = defaultLayout();
  if (!input || typeof input !== 'object') return d;
  const l = input as Record<string, unknown>;
  return {
    panel: oneOf(l.panel, ['right', 'left', 'none'] as const, d.panel),
    header: bool(l.header, d.header),
    footer: bool(l.footer, d.footer),
    // Was a boolean before the mark could sit on either side; a board saved
    // then meant "on", which is now the right-hand corner.
    logo: l.logo === true ? 'right' : l.logo === false ? 'none' : oneOf(l.logo, ['left', 'right', 'none'] as const, d.logo),
    credit: bool(l.credit, d.credit),
    typeScale: num(l.typeScale, d.typeScale, 0.6, 1.8),
  };
}

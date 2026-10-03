import { useMemo } from 'react';
import {
  atFraction,
  bestRotation,
  boardGroups,
  cumulativeFractions,
  groupValue,
  project,
  smoothPath,
  thin,
  toUnits,
  unitLabel,
  unitPosts,
  visibleMarkers,
  type Box,
} from '../board';
import { BOARD_COLORS, type BoardConfig, type CoursePayload, type EventMeta, type RaceSnap } from '../types';

/**
 * The course board: one race, its groups, on a 1920x1080 canvas.
 *
 * Drawn as an SVG at a fixed size rather than as a slippy map, because this
 * goes to a capture card or a projector. There are no tiles to wait for, no
 * attribution to keep in shot, nothing that looks different on the machine in
 * the truck than it did on the one it was set up on, and the whole frame can
 * be scaled to any output by scaling one element.
 *
 * It has no controls, deliberately. Everything it shows comes from the board
 * config on the server, which the control page writes - see BoardControl.
 */

export const BOARD_W = 1920;
export const BOARD_H = 1080;

const PANEL_W = 592;
const GUTTER = 40;

/**
 * Where the map and the panel sit, which the operator can change.
 *
 * A panel on the left suits a board whose lower right is covered by a
 * broadcaster's own furniture; no panel at all turns the whole frame into a
 * course map for a wall. The map takes whatever is left either way.
 */
function layoutFor(config: BoardConfig): { map: Box; panelX: number | null; top: number; bottom: number } {
  const top = config.layout.header ? 132 : GUTTER;
  const bottom = config.layout.footer ? 92 : GUTTER;
  const h = BOARD_H - top - bottom;
  if (config.layout.panel === 'none') {
    return { map: { x: GUTTER, y: top, w: BOARD_W - GUTTER * 2, h, pad: 72 }, panelX: null, top, bottom };
  }
  const mapW = BOARD_W - PANEL_W - GUTTER * 3;
  const left = config.layout.panel === 'left';
  return {
    map: { x: left ? GUTTER * 2 + PANEL_W : GUTTER, y: top, w: mapW, h, pad: 72 },
    panelX: left ? GUTTER : BOARD_W - GUTTER - PANEL_W,
    top,
    bottom,
  };
}

/** Elapsed since the gun, as a clock reads it. */
function elapsed(sinceMs: number | null): string | null {
  if (sinceMs === null) return null;
  const total = Math.max(0, Math.floor(sinceMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function CourseBoard({
  event,
  race,
  course,
  config,
  startedMs,
  now,
}: {
  event: EventMeta;
  race: RaceSnap | null;
  course: CoursePayload | null;
  config: BoardConfig;
  /** When the race went off, for the clock. Null when it has not. */
  startedMs?: number | null;
  now?: number;
}) {
  const coords = course?.line?.geometry?.coordinates ?? [];
  const { map: MAP, panelX, top, bottom } = useMemo(() => layoutFor(config), [config.layout]);
  const theme = config.theme;
  const scale = config.layout.typeScale;

  const groups = useMemo(
    () => (race ? boardGroups(race, config, BOARD_COLORS) : []),
    [race, config],
  );

  const lead = groups.find((g) => g.key === config.lead) ?? groups.find((g) => g.fraction !== null) ?? groups[0];

  /**
   * Following keeps the lead group in the middle of the map as it runs, which
   * is the only way a zoomed-in board stays useful without somebody panning it
   * by hand for two hours. It falls back to the operator's pan the moment the
   * group has no position, rather than snapping to the course centre.
   */
  const leadLat = lead?.tracker?.pathLat ?? lead?.tracker?.lastFix?.lat;
  const leadLon = lead?.tracker?.pathLon ?? lead?.tracker?.lastFix?.lon;
  const center: [number, number] | null =
    config.follow && leadLat !== undefined && leadLon !== undefined ? [leadLon, leadLat] : config.center;

  const geom = useMemo(() => {
    if (coords.length < 2) return null;
    const fractions = cumulativeFractions(coords);
    const fixed = config.rotate === 0 || config.rotate === 90 || config.rotate === 180 || config.rotate === 270;
    const rotation = fixed ? (config.rotate as 0 | 90 | 180 | 270) : bestRotation(coords, MAP);
    const p = project(coords, MAP, config.zoom, center, rotation);
    const screen = coords.map(([lon, lat]) => p.point(lon, lat) as [number, number]);
    return { fractions, projection: p, path: smoothPath(thin(screen)) };
  }, [coords, config.zoom, center?.[0], center?.[1], config.rotate, MAP]);
  const clock = config.showClock ? elapsed(startedMs ? (now ?? Date.now()) - startedMs : null) : null;

  const posts = useMemo(() => {
    if (!race || !course || config.posts === 'none') return [];
    const wanted: Array<'miles' | 'kilometers'> =
      config.posts === 'both' ? ['kilometers', 'miles'] : [config.posts];
    return wanted.flatMap((u) =>
      unitPosts(course.length, course.units, u).map((post) => ({ ...post, units: u })),
    );
  }, [race, course, config.posts]);

  const markers = course ? visibleMarkers(course.markers, config) : [];

  /**
   * Where each group's dot goes, and where its label can go without landing on
   * another one.
   *
   * Groups bunch: at the gun all three leaders are on the same start line, and
   * through the first mile of a marathon the men's and women's lead vehicles
   * are often within a few hundred metres. Left alone the labels print on top
   * of each other and none of them can be read, which is worse than showing
   * one. Labels are lifted in turn and tied back to their dot.
   */
  const placed = useMemo(() => {
    if (!geom) return [];
    const out: Array<{
      g: (typeof groups)[number];
      x: number;
      y: number;
      labelY: number;
      labelX: number;
      anchor: 'middle' | 'start' | 'end';
    }> = [];
    for (const g of groups) {
      if (!g.showMarker) continue;
      const lat = g.tracker?.pathLat ?? g.tracker?.lastFix?.lat;
      const lon = g.tracker?.pathLon ?? g.tracker?.lastFix?.lon;
      if (lat === undefined || lon === undefined) continue;
      const [x, y] = geom.projection.point(lon, lat);
      let labelY = -32;
      // 170px apart horizontally is roughly a label's width at this size.
      while (out.some((o) => Math.abs(o.x - x) < 170 && Math.abs(o.y + o.labelY - (y + labelY)) < 30)) {
        labelY -= 34;
      }
      // A label centred on a dot near the edge runs off the map and is clipped
      // mid-word, which reads as broken rather than as cramped. Pull it back
      // inside and anchor it to whichever edge it was about to cross.
      const half = (g.label.length * 13 * scale) / 2 + 12;
      const anchor: 'middle' | 'start' | 'end' =
        x - half < MAP.x ? 'start' : x + half > MAP.x + MAP.w ? 'end' : 'middle';
      const labelX = anchor === 'start' ? MAP.x + 12 - x : anchor === 'end' ? MAP.x + MAP.w - 12 - x : 0;
      out.push({ g, x, y, labelY, labelX, anchor });
    }
    return out;
  }, [geom, groups, MAP, scale]);
  const title = config.title.trim() || race?.name || event.name;

  return (
    <svg
      className="course-board"
      viewBox={`0 0 ${BOARD_W} ${BOARD_H}`}
      width={BOARD_W}
      height={BOARD_H}
      xmlns="http://www.w3.org/2000/svg"
      /* The scheme reaches the stylesheet as custom properties, so a meet gets
         its own colours without a rebuild. Every value here has been through
         the hex check on the server - they land in a style attribute. */
      style={
        {
          '--cb-bg': theme.bg,
          '--cb-panel': theme.panel,
          '--cb-text': theme.text,
          '--cb-dim': theme.dim,
          '--cb-course': theme.course,
          '--cb-glow': theme.glow,
          '--cb-start': theme.start,
          '--cb-finish': theme.finish,
          '--cb-timing': theme.timing,
          '--cb-post': theme.post,
          '--cb-mile': theme.milePost,
          '--cb-brand': theme.brand,
          '--cb-scale': scale,
        } as React.CSSProperties
      }
    >
      <defs>
        <clipPath id="board-map-clip">
          <rect x={MAP.x} y={MAP.y} width={MAP.w} height={MAP.h} rx={18} />
        </clipPath>
      </defs>

      <rect x={0} y={0} width={BOARD_W} height={BOARD_H} className="cb-bg" />

      {/* ---------------------------------------------------------- header */}
      {config.layout.header && <g className="cb-header">
        <rect x={0} y={0} width={BOARD_W} height={104} className="cb-header-bg" />
        <text x={40} y={68} className="cb-title">
          {title.toUpperCase()}
        </text>
        <text x={40} y={94} className="cb-subtitle">
          {event.name}
          {race?.status ? ` · ${race.status.toUpperCase()}` : ''}
        </text>
        {clock && (
          <text x={BOARD_W - 40} y={72} className="cb-clock" textAnchor="end">
            {clock}
          </text>
        )}
      </g>}

      {/* ------------------------------------------------------------- map */}
      <rect x={MAP.x} y={MAP.y} width={MAP.w} height={MAP.h} rx={18} className="cb-map-bg" />

      {geom ? (
        <g clipPath="url(#board-map-clip)">
          {/* The course: a wide soft glow, the line, then the part covered. */}
          <path d={geom.path} className="cb-course-glow" />
          <path d={geom.path} className="cb-course" />
          {config.showDone && lead?.fraction !== null && lead?.fraction !== undefined && (
            <path
              d={geom.path}
              className="cb-course-done"
              pathLength={1000}
              style={{ strokeDasharray: `${(lead.fraction * 1000).toFixed(1)} 1000`, stroke: lead.color }}
            />
          )}

          {/* Distance posts, under the named markers so a label wins. */}
          {posts.map((post, i) => {
            const at = atFraction(coords, geom.fractions, post.at / (course?.length || 1));
            if (!at) return null;
            const [x, y] = geom.projection.point(at[0], at[1]);
            return (
              <g key={`post-${post.units}-${i}`} className={`cb-post ${post.units === 'miles' ? 'mile' : 'km'}`}>
                {post.units === 'miles' ? (
                  <rect x={x - 7} y={y - 7} width={14} height={14} transform={`rotate(45 ${x} ${y})`} />
                ) : (
                  <circle cx={x} cy={y} r={7} />
                )}
                <text x={x} y={y + 30} textAnchor="middle">
                  {post.label}
                </text>
              </g>
            );
          })}

          {markers.map((m, i) => {
            const [x, y] = geom.projection.point(m.lon, m.lat);
            return (
              <g key={`m-${m.kind}-${i}`} className={`cb-marker ${m.kind}`}>
                <circle cx={x} cy={y} r={m.kind === 'timing' ? 13 : 15} />
                <text x={x} y={y + 42} textAnchor="middle">
                  {m.label.toUpperCase()}
                </text>
              </g>
            );
          })}

          {/* Vehicles last, so a group is never hidden behind course furniture. */}
          {placed.map(({ g, x, y, labelY, labelX, anchor }) => (
            <g key={g.key} className={`cb-vehicle ${g.stale ? 'stale' : ''}`} transform={`translate(${x} ${y})`}>
              {!g.stale && <circle className="cb-vehicle-pulse" r={18} style={{ fill: g.color }} />}
              <circle className="cb-vehicle-dot" r={17} style={{ fill: g.color }} />
              {/* A leader line when the label had to be lifted clear of the
                  others, so it still obviously belongs to this dot. */}
              {labelY < -40 && <line className="cb-vehicle-tie" x1={0} y1={-20} x2={labelX} y2={labelY + 8} />}
              <text className="cb-vehicle-label" x={labelX} y={labelY} textAnchor={anchor}>
                {g.label.toUpperCase()}
              </text>
            </g>
          ))}
        </g>
      ) : (
        <text x={MAP.x + MAP.w / 2} y={MAP.y + MAP.h / 2} className="cb-empty" textAnchor="middle">
          {race ? 'No course traced for this race' : 'No race on the board'}
        </text>
      )}

      {/* ----------------------------------------------------------- panel */}
      <g className="cb-panel">
        {panelX !== null && groups.length === 0 && race && (
          <text x={panelX} y={MAP.y + 48} className="cb-empty-panel">
            No groups shown
          </text>
        )}
        {panelX === null ? null : groups.map((g, i) => {
          const y = MAP.y + i * 152;
          const v = race ? groupValue(g, race, config) : { text: '—', unit: '' };
          return (
            <g key={g.key} transform={`translate(${panelX} ${y})`} className={`cb-group ${g.stale ? 'stale' : ''}`}>
              <rect x={0} y={0} width={PANEL_W} height={132} rx={12} className="cb-group-bg" />
              <rect x={0} y={0} width={8} height={132} rx={4} style={{ fill: g.color }} />
              <text x={28} y={40} className="cb-group-label">
                {g.label.toUpperCase()}
              </text>
              {g.vehicle && (
                <text x={PANEL_W - 24} y={40} className="cb-group-vehicle" textAnchor="end">
                  {g.vehicle}
                </text>
              )}

              {g.showDistance ? (
                <>
                  <text x={28} y={108} className="cb-group-value">
                    {v.text}
                  </text>
                  <text x={28 + v.text.length * 40 + 12} y={108} className="cb-group-unit">
                    {v.unit}
                  </text>
                </>
              ) : (
                <text x={28} y={98} className="cb-group-hidden">
                  TRACKING
                </text>
              )}

              {/* The same number as a bar: it reads from across a room, and it
                  is the only thing left when the figure is turned off. */}
              <rect x={28} y={116} width={PANEL_W - 52} height={8} rx={4} className="cb-group-bar-bg" />
              <rect
                x={28}
                y={116}
                width={Math.max(0, Math.min(1, g.fraction ?? 0)) * (PANEL_W - 52)}
                height={8}
                rx={4}
                style={{ fill: g.color }}
              />
            </g>
          );
        })}
      </g>

      {/* ---------------------------------------------------------- footer */}
      {config.layout.footer && <g className="cb-footer">
        <rect x={0} y={BOARD_H - 56} width={BOARD_W} height={56} className="cb-footer-bg" />
        <text x={40} y={BOARD_H - 19} className="cb-footer-text">
          {race && course
            ? `${toUnits(race.courseLength, race.units, config.units).toFixed(config.decimals)} ${unitLabel(config.units)} COURSE`
            : ''}
        </text>
        <text x={BOARD_W - 40} y={BOARD_H - 19} className="cb-footer-brand" textAnchor="end">
          {theme.brandText}
        </text>
      </g>}
    </svg>
  );
}

/** The board scaled to whatever space it is given, letterboxed and centred. */
export function BoardFrame({ width, children }: { width: number; children: React.ReactNode }) {
  const scale = width / BOARD_W;
  return (
    <div className="board-frame" style={{ width, height: BOARD_H * scale }}>
      <div style={{ width: BOARD_W, height: BOARD_H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {children}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { project, unproject, type Box } from '../board';
import { BOARD_COLORS, defaultBoardConfig, type BoardConfig, type CoursePayload, type EventSnap, type RaceSnap } from '../types';
import { BOARD_H, BOARD_W, BoardFrame, CourseBoard } from './CourseBoard';
import { raceLabel } from '../format';

/**
 * Driving the course board.
 *
 * The board has no controls on it - it is going to a capture card, and
 * anything drawn over it is in shot - so this is where it is driven from, and
 * the preview above the controls is the same component the board renders,
 * scaled down. Not a mock-up of it: the same code, the same data, the same
 * config, so what is on the monitor is what is on air.
 *
 * Every change is live. There is no take step, because the things an operator
 * reaches for here - hide that group's number, follow the women's lead, pan
 * left - are all things they are doing *because* of what is happening in the
 * race, and a rehearsal step between the decision and the screen is a step
 * taken while the moment passes.
 */

const MAP_BOX: Box = { x: 40, y: 132, w: 1216, h: 856, pad: 72 };

export function BoardControl({ ev, onMsg }: { ev: EventSnap; onMsg: (text: string, bad?: boolean) => void }) {
  const [config, setConfig] = useState<BoardConfig>(ev.board ?? defaultBoardConfig());
  const [course, setCourse] = useState<CoursePayload | null>(null);
  const [now, setNow] = useState(Date.now());
  const previewRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; center: [number, number] | null } | null>(null);

  // The board is shared state: another tab, or another operator, may have
  // moved it. Follow the snapshot rather than only our own edits.
  useEffect(() => {
    if (ev.board) setConfig(ev.board);
  }, [ev.board]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /** The race the board is on: the operator's pick, else whatever is running. */
  const race: RaceSnap | null = useMemo(() => {
    if (config.raceId) return ev.races.find((r) => r.raceId === config.raceId) ?? null;
    return ev.races.find((r) => r.status === 'live') ?? ev.races.find((r) => r.status === 'armed') ?? null;
  }, [ev.races, config.raceId]);

  useEffect(() => {
    if (!race) return void setCourse(null);
    let live = true;
    api
      .course(race.eventId, race.raceId)
      .then((c: CoursePayload) => {
        if (live) setCourse(c);
      })
      .catch(() => {
        if (live) setCourse(null);
      });
    return () => {
      live = false;
    };
  }, [race?.eventId, race?.raceId]);

  const push = async (next: BoardConfig) => {
    setConfig(next);
    try {
      await api.setBoard(ev.event.id, next);
    } catch (err) {
      onMsg((err as Error).message, true);
    }
  };

  const patch = (changes: Partial<BoardConfig>) => void push({ ...config, ...changes });
  const patchGroup = (key: string, changes: Partial<BoardConfig['groups'][string]>) => {
    const current = config.groups[key] ?? {
      shown: true,
      distance: true,
      marker: true,
      color: BOARD_COLORS[Object.keys(config.groups).length % BOARD_COLORS.length],
    };
    void push({ ...config, groups: { ...config.groups, [key]: { ...current, ...changes } } });
  };

  const roles = race?.roles ?? [];
  const ordered = useMemo(() => {
    const out = config.order.map((k) => roles.find((r) => r.key === k)).filter(Boolean) as typeof roles;
    for (const r of roles) if (!out.includes(r)) out.push(r);
    return out;
  }, [roles, config.order]);

  const move = (key: string, by: number) => {
    const keys = ordered.map((r) => r.key);
    const i = keys.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    patch({ order: keys });
  };

  /** Drag the preview to move the board. Written once, on release. */
  const coords = course?.line?.geometry?.coordinates ?? [];
  const onDown = (e: React.MouseEvent) => {
    if (coords.length < 2) return;
    drag.current = { x: e.clientX, y: e.clientY, center: config.center };
    e.preventDefault();
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    const box = previewRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const scale = box.width / BOARD_W;
    const p = project(coords, MAP_BOX, config.zoom, d.center);
    // A drag moves the course under the window, so the centre moves the other
    // way by the same amount, in board pixels rather than screen pixels.
    const cx = MAP_BOX.x + MAP_BOX.w / 2 - (e.clientX - d.x) / scale;
    const cy = MAP_BOX.y + MAP_BOX.h / 2 - (e.clientY - d.y) / scale;
    setConfig((c) => ({ ...c, center: unproject(p, coords, MAP_BOX, cx, cy) }));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    void push(config);
  };

  const boardUrl = `${window.location.origin}/board?event=${encodeURIComponent(ev.event.id)}`;

  return (
    <div className="board-control">
      <div className="board-preview-wrap">
        <div
          className={`board-preview ${coords.length > 1 ? 'draggable' : ''}`}
          ref={previewRef}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={onUp}
        >
          <BoardFrame width={880}>
            <CourseBoard
              event={ev.event}
              race={race}
              course={course}
              config={config}
              startedMs={null}
              now={now}
            />
          </BoardFrame>
        </div>
        <div className="board-preview-bar">
          <span className="dim">Live — what this shows is what the board is showing.</span>
          <span className="spacer" />
          <button
            className="mini"
            onClick={() => {
              void navigator.clipboard?.writeText(boardUrl);
              onMsg('Board link copied. Open it full screen on the output machine.');
            }}
          >
            Copy board link
          </button>
          <a className="mini linklike" href={boardUrl} target="_blank" rel="noreferrer">
            Open board ↗
          </a>
        </div>
      </div>

      <div className="board-controls">
        <section>
          <h4>Race</h4>
          <select value={config.raceId ?? ''} onChange={(e) => patch({ raceId: e.target.value || null })}>
            <option value="">Follow the running race</option>
            {ev.races.map((r) => (
              <option key={r.raceId} value={r.raceId}>
                {raceLabel(r)}
              </option>
            ))}
          </select>
          <label className="board-field">
            Title
            <input
              value={config.title}
              placeholder={race?.name ?? 'Race name'}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </label>
          <label className="dialog-check">
            <input type="checkbox" checked={config.showClock} onChange={(e) => patch({ showClock: e.target.checked })} />
            Race clock
          </label>
        </section>

        <section>
          <h4>Distances</h4>
          <div className="board-row">
            {(['miles', 'kilometers'] as const).map((u) => (
              <button key={u} className={`mini ${config.units === u ? 'on' : ''}`} onClick={() => patch({ units: u })}>
                {u === 'miles' ? 'Miles' : 'Kilometres'}
              </button>
            ))}
          </div>
          <div className="board-row">
            {(['covered', 'remaining', 'percent'] as const).map((v) => (
              <button key={v} className={`mini ${config.value === v ? 'on' : ''}`} onClick={() => patch({ value: v })}>
                {v === 'covered' ? 'Covered' : v === 'remaining' ? 'To go' : 'Percent'}
              </button>
            ))}
          </div>
          <div className="board-row">
            <span className="dim">Decimals</span>
            {[0, 1, 2].map((d) => (
              <button key={d} className={`mini ${config.decimals === d ? 'on' : ''}`} onClick={() => patch({ decimals: d })}>
                {d}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h4>Groups</h4>
          {ordered.length === 0 && <p className="hint">This race has no roles yet.</p>}
          {ordered.map((role, i) => {
            const g = config.groups[role.key] ?? {
              shown: true,
              distance: true,
              marker: true,
              color: BOARD_COLORS[i % BOARD_COLORS.length],
            };
            return (
              <div className={`board-group ${g.shown ? '' : 'off'}`} key={role.key}>
                <div className="board-group-head">
                  <span className="board-swatch" style={{ background: g.color }} />
                  <span className="board-group-name">{role.label}</span>
                  <span className="spacer" />
                  <button className="mini" title="Move up" disabled={i === 0} onClick={() => move(role.key, -1)}>
                    ↑
                  </button>
                  <button
                    className="mini"
                    title="Move down"
                    disabled={i === ordered.length - 1}
                    onClick={() => move(role.key, 1)}
                  >
                    ↓
                  </button>
                </div>
                <div className="board-row">
                  <button className={`mini ${g.shown ? 'on' : ''}`} onClick={() => patchGroup(role.key, { shown: !g.shown })}>
                    On board
                  </button>
                  <button
                    className={`mini ${g.distance ? 'on' : ''}`}
                    disabled={!g.shown}
                    onClick={() => patchGroup(role.key, { distance: !g.distance })}
                  >
                    Distance
                  </button>
                  <button
                    className={`mini ${g.marker ? 'on' : ''}`}
                    disabled={!g.shown}
                    onClick={() => patchGroup(role.key, { marker: !g.marker })}
                  >
                    On map
                  </button>
                  <button
                    className={`mini ${config.lead === role.key ? 'on' : ''}`}
                    disabled={!g.shown}
                    title="Whose progress lights the course"
                    onClick={() => patch({ lead: config.lead === role.key ? null : role.key })}
                  >
                    Lead
                  </button>
                </div>
                <div className="board-row board-colors">
                  {BOARD_COLORS.map((c) => (
                    <button
                      key={c}
                      className={`board-color ${g.color === c ? 'on' : ''}`}
                      style={{ background: c }}
                      title="Colour"
                      onClick={() => patchGroup(role.key, { color: c })}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        <section>
          <h4>Course</h4>
          <div className="board-row">
            {(['start', 'finish', 'timing', 'custom'] as const).map((k) => (
              <button
                key={k}
                className={`mini ${config.markers[k] ? 'on' : ''}`}
                onClick={() => patch({ markers: { ...config.markers, [k]: !config.markers[k] } })}
              >
                {k === 'custom' ? 'Course marks' : k[0].toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <div className="board-row">
            <span className="dim">Posts</span>
            {(['none', 'miles', 'kilometers', 'both'] as const).map((p) => (
              <button key={p} className={`mini ${config.posts === p ? 'on' : ''}`} onClick={() => patch({ posts: p })}>
                {p === 'none' ? 'None' : p === 'miles' ? 'Mile' : p === 'kilometers' ? 'KM' : 'Both'}
              </button>
            ))}
          </div>
          <label className="dialog-check">
            <input type="checkbox" checked={config.showDone} onChange={(e) => patch({ showDone: e.target.checked })} />
            Light the course behind the lead
          </label>
        </section>

        <section>
          <h4>View</h4>
          <div className="board-row">
            <span className="dim">Zoom</span>
            <input
              type="range"
              min={1}
              max={8}
              step={0.1}
              value={config.zoom}
              onChange={(e) => patch({ zoom: Number(e.target.value) })}
            />
            <span className="mono">{config.zoom.toFixed(1)}×</span>
          </div>
          <div className="board-row">
            <button className="mini" onClick={() => patch({ zoom: 1, center: null })}>
              Fit course
            </button>
            <button
              className={`mini ${config.follow ? 'on' : ''}`}
              title="Keep the lead group centred as it moves"
              onClick={() => patch({ follow: !config.follow })}
            >
              Follow lead
            </button>
          </div>
          <p className="hint">Drag the preview to move the map.</p>
        </section>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export interface RawFrame {
  /** Set on frames read back from the server's log; live ones have none yet. */
  id?: number;
  tMs: number;
  source: string;
  ip: string;
  binary: boolean;
  bytes: number;
  imei?: string;
  text: string;
}

/** Frames held in the browser at once. Older ones are on the server, a
 *  "load older" away, so this only bounds the tab's memory. */
const KEEP = 4000;
const PAGE = 500;

/**
 * Everything arriving on the tracker ports, exactly as it arrives.
 *
 * When a device is missing at a start line the first question is whether it is
 * reaching us at all, and that is invisible once a frame has been parsed,
 * gated and snapped. This is deliberately upstream of all of it: no filtering
 * by roster, no hygiene, no interpretation — if it came in on a port it shows
 * up here, including frames from devices in no event at all.
 *
 * The server records every frame whether or not anyone is watching, so opening
 * this page starts with what already happened rather than a blank screen: the
 * reason to come here is nearly always something that went wrong earlier.
 */
export function WireLog({ socket }: { socket: Socket | null }) {
  const [frames, setFrames] = useState<RawFrame[]>([]);
  const [paused, setPaused] = useState(false);
  const [live, setLive] = useState(true);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [sources, setSources] = useState<string[]>([]);
  const [stats, setStats] = useState<{ frames: number; oldestMs: number | null }>();
  const [loading, setLoading] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [error, setError] = useState<string>();
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** Ask the server for a page of the log; `before` walks backwards. */
  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setError(undefined);
      try {
        const p = new URLSearchParams({ limit: String(PAGE) });
        if (before !== undefined) p.set('before', String(before));
        if (source !== 'all') p.set('source', source);
        if (query.trim()) p.set('q', query.trim());
        const r = await fetch(`/api/wire/history?${p}`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error ?? 'could not read the log');
        // the API answers newest-first; the view reads oldest-at-top
        const page: RawFrame[] = (j.frames as RawFrame[]).slice().reverse();
        setSources(j.sources ?? []);
        setStats(j.stats);
        setNoMore(page.length < PAGE);
        setFrames((prev) => (before === undefined ? page : [...page, ...prev]).slice(-KEEP));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [source, query],
  );

  // Re-read whenever the filter changes: the server holds far more than this
  // view does, so filtering only what is on screen would miss most of it.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!socket || !live) return;
    const onRaw = (f: RawFrame) => {
      // While paused the feed keeps running on the server and is still being
      // recorded; we simply stop appending, so the lines on screen stay put.
      if (pausedRef.current) return;
      setFrames((prev) => {
        const next = prev.length >= KEEP ? prev.slice(prev.length - KEEP + 1) : prev.slice();
        next.push(f);
        return next;
      });
    };
    // The room lives on the server, so a reconnect (a restart mid-race, say)
    // drops the subscription while this same socket object carries on. Asking
    // again on every connect keeps the log alive across one.
    const subscribe = () => socket.emit('raw:subscribe');
    socket.on('raw', onRaw);
    socket.on('connect', subscribe);
    subscribe();
    return () => {
      socket.emit('raw:unsubscribe');
      socket.off('raw', onRaw);
      socket.off('connect', subscribe);
    };
  }, [socket, live]);

  // Live frames arrive unfiltered; the same filter is applied here so the view
  // stays consistent with what the server was asked for.
  const q = query.trim().toLowerCase();
  const shown = frames.filter(
    (f) => (source === 'all' || f.source === source) && (!q || f.text.toLowerCase().includes(q) || f.ip.includes(q)),
  );

  // follow the tail unless the operator paused, or scrolled back to read
  useEffect(() => {
    if (!paused && live) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, paused, live]);

  const olderId = frames.find((f) => f.id !== undefined)?.id;
  const loadOlder = async () => {
    const el = listRef.current;
    const anchor = el ? el.scrollHeight - el.scrollTop : 0;
    await load(olderId);
    // keep the line you were reading under the cursor after prepending
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight - anchor));
  };

  const time = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  const day = (ms: number) => new Date(ms).toLocaleDateString();

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Wire log</span>
        <span className="spacer" />
        <input
          className="fleet-search"
          placeholder="Filter by IMEI, text, IP…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="fleet-filter" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="all">All ports</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          className={`mini ${live ? 'on' : ''}`}
          title={live ? 'Stop following new frames' : 'Follow new frames again'}
          onClick={() => setLive(!live)}
        >
          {live ? '⏺ Live' : '⏸ History'}
        </button>
        <button className={`mini ${paused ? 'on' : ''}`} disabled={!live} onClick={() => setPaused(!paused)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="mini" title="Clear this view only" onClick={() => setFrames([])}>
          Clear view
        </button>
      </div>

      <div className="wire-count">
        {shown.length === frames.length
          ? `${frames.length} frame${frames.length === 1 ? '' : 's'} shown`
          : `${shown.length} of ${frames.length} shown`}
        {stats && (
          <span className="dim">
            {' · '}
            {stats.frames.toLocaleString()} recorded
            {stats.oldestMs !== null && ` back to ${day(stats.oldestMs)}`}
          </span>
        )}
        {!live && <span className="warn-text"> · history only, not following new frames</span>}
        {live && paused && <span className="warn-text"> · paused — frames are still being recorded</span>}
        {error && <span className="warn-text"> · {error}</span>}
      </div>

      <div className="wire-log" ref={listRef}>
        <div className="wire-older">
          {noMore ? (
            <span className="dim">{frames.length === 0 ? '' : 'start of the recorded log'}</span>
          ) : (
            <button className="mini" disabled={loading} onClick={loadOlder}>
              {loading ? 'Loading…' : `↑ Load ${PAGE} older`}
            </button>
          )}
        </div>

        {frames.length === 0 && !loading && (
          <p className="hint">
            Nothing recorded yet. Frames appear here the moment a tracker sends one to port 1000 or 1001 —
            no roster or event filtering, so a device you have not set up anywhere still shows. Everything is
            kept, so you can come back later and look for it.
          </p>
        )}

        {shown.map((f, i) => (
          <div className={`wire-line ${f.binary ? 'binary' : ''}`} key={f.id ?? `live-${f.tMs}-${i}`}>
            <span className="wire-time" title={day(f.tMs)}>
              {time(f.tMs)}
            </span>
            <span className="wire-src">{f.source}</span>
            <span className="wire-ip dim">{f.ip}</span>
            <span className="wire-text">{f.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

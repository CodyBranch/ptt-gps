import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

export interface RawFrame {
  tMs: number;
  source: string;
  ip: string;
  binary: boolean;
  bytes: number;
  text: string;
}

/** Frames kept in the browser. Enough to scroll back through a backlog flush
 *  without letting a busy meet grow the tab forever. */
const KEEP = 1000;

/**
 * Everything arriving on the tracker ports, exactly as it arrives.
 *
 * When a device is missing at a start line the first question is whether it is
 * reaching us at all, and that is invisible once a frame has been parsed,
 * gated and snapped. This is deliberately upstream of all of it: no filtering
 * by roster, no hygiene, no interpretation — if it came in on a port it shows
 * up here, including frames from devices in no event at all.
 */
export function WireLog({ socket }: { socket: Socket | null }) {
  const [frames, setFrames] = useState<RawFrame[]>([]);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!socket) return;
    const onRaw = (f: RawFrame) => {
      // While paused the feed keeps running on the server; we simply stop
      // collecting, so the lines on screen stay put for reading.
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
  }, [socket]);

  const sources = [...new Set(frames.map((f) => f.source))].sort();
  const q = query.trim().toLowerCase();
  const shown = frames.filter(
    (f) =>
      (source === 'all' || f.source === source) &&
      (!q || f.text.toLowerCase().includes(q) || f.ip.includes(q)),
  );

  // follow the tail unless the operator paused to read something
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, paused]);

  const time = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

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
        <button className={`mini ${paused ? 'on' : ''}`} onClick={() => setPaused(!paused)}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button className="mini" onClick={() => setFrames([])}>
          Clear
        </button>
      </div>
      <div className="wire-count">
        {shown.length === frames.length
          ? `${frames.length} frame${frames.length === 1 ? '' : 's'}`
          : `${shown.length} of ${frames.length} frames`}
        {paused && <span className="warn-text"> · paused, new frames are being dropped from this view</span>}
        {frames.length >= KEEP && <span className="dim"> · showing the most recent {KEEP}</span>}
      </div>
      <div className="wire-log">
        {frames.length === 0 && (
          <p className="hint">
            Nothing has arrived yet. Frames appear here the moment a tracker sends one to port 1000 or 1001 —
            no roster or event filtering, so a device you have not set up anywhere still shows.
          </p>
        )}
        {shown.map((f, i) => (
          <div className={`wire-line ${f.binary ? 'binary' : ''}`} key={`${f.tMs}-${i}`}>
            <span className="wire-time">{time(f.tMs)}</span>
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

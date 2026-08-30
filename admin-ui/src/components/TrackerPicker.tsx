import { useRef, useState } from 'react';
import { useDismissOnOutside } from '../hooks';
import type { FleetRow } from '../types';

/**
 * Pick a tracker out of a fleet that is now dozens deep.
 *
 * A plain <select> listed every device in whatever order the API returned and
 * offered no way to narrow it, so finding "PTT-14" meant scrolling past 57
 * others. This filters as you type — on name, IMEI, model or owner — and can be
 * pinned to one owner. Names sort naturally, so PTT-10 follows PTT-9 rather
 * than sitting between PTT-1 and PTT-2.
 */
export function TrackerPicker({
  options,
  placeholder,
  eventId,
  onPick,
}: {
  options: FleetRow[];
  placeholder: string;
  /** Devices already committed to another event are flagged, not hidden. */
  eventId: string;
  onPick: (imei: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('all');
  const wrapRef = useRef<HTMLDivElement>(null);

  useDismissOnOutside(wrapRef, open, () => setOpen(false));

  const owners = [...new Set(options.map((f) => f.owner).filter(Boolean))].sort() as string[];
  const q = query.trim().toLowerCase();
  const shown = options
    .filter((f) => (owner === 'all' ? true : (f.owner ?? '') === owner))
    .filter((f) =>
      !q ? true : [f.label, f.imei, f.model, f.owner].some((v) => (v ?? '').toString().toLowerCase().includes(q)),
    )
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));

  const choose = (imei: string) => {
    onPick(imei);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="tracker-picker" ref={wrapRef}>
      <div className="tracker-picker-bar">
        <input
          value={query}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            // Enter takes the only remaining match — the usual end of typing
            if (e.key === 'Enter' && shown.length === 1) choose(shown[0].imei);
          }}
        />
        {owners.length > 1 && open && (
          <select value={owner} onChange={(e) => setOwner(e.target.value)} onMouseDown={(e) => e.stopPropagation()}>
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
      </div>
      {open && (
        <div className="picker-list tracker-picker-list">
          {shown.length === 0 && <div className="tracker-picker-empty">No matching device</div>}
          {shown.map((f) => {
            const elsewhere = f.events.some((e) => e.id !== eventId);
            return (
              <button key={f.imei} className="tracker-picker-row" onClick={() => choose(f.imei)}>
                <span className="tp-label">{f.label}</span>
                <span className="tp-owner dim">{f.owner ?? '—'}</span>
                <span className="tp-imei dim">{f.imei}</span>
                {elsewhere && (
                  <span className="tp-warn" title={`Already in ${f.events.map((e) => e.name).join(', ')}`}>
                    ⚠
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

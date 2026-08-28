import type { TrackerPub } from '../types';

/** Battery level bar — legacy color bands: <20 low, 20–60 mid, ≥60 high. */
export function BatteryBar({ tracker }: { tracker: TrackerPub }) {
  if (!tracker.hasBattery) return <span className="batt-ext" title="Vehicle powered">EXT</span>;
  const pct = tracker.lastFix?.battery;
  if (pct === undefined) return <span className="dim">—</span>;
  const cls = pct < 20 ? 'low' : pct < 60 ? 'mid' : 'high';
  return (
    <span className={`batt ${cls}`} title={`${pct}%`}>
      <span className="batt-shell">
        <span className="batt-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="batt-pct">{Math.round(pct)}%</span>
    </span>
  );
}

/**
 * GNSS lock certainty. GL family: GTFRI accuracy (1 good, ≥2 degraded,
 * 0 repeating last-known). GV500: HDOP + satellites.
 */
export function GpsChip({ tracker }: { tracker: TrackerPub }) {
  const q = tracker.gpsQuality;
  if (!q) return <span className="dim">—</span>;
  const f = tracker.lastFix;
  const detail =
    f?.hdop !== undefined
      ? `HDOP ${f.hdop.toFixed(1)}${f.sats !== undefined ? ` · ${f.sats} sats` : ''}`
      : f?.accuracy !== undefined
        ? `accuracy ${f.accuracy}`
        : '';
  const label = q === 'good' ? 'LOCK' : q === 'ok' ? 'FAIR' : 'POOR';
  return (
    <span className={`gps-chip ${q}`} title={detail}>
      {label}
      {f?.sats !== undefined && <span className="gps-sats">{f.sats}</span>}
    </span>
  );
}

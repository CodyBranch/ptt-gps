import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, Units } from '../types';
import { BatteryBar, GpsChip } from './Health';
import { ageClass, fmtAge, packetAgeS } from './RolesPanel';

export function TrackerTable({
  race,
  displayUnits,
  lastSeen,
  intervalS,
  selectedImei,
  onSelect,
  onWindow,
}: {
  race: RaceSnap;
  displayUnits: Units;
  lastSeen: Record<string, number>;
  intervalS: number;
  selectedImei?: string;
  onSelect: (imei: string) => void;
  onWindow: (imei: string) => void;
}) {
  const d = (v: number) => toDisplay(v, race.units, displayUnits);
  return (
    <div className="tracker-table">
      <table>
        <thead>
          <tr>
            <th>Tracker</th>
            <th>Dist ({unitAbbr(displayUnits)})</th>
            <th>Off</th>
            <th>GPS</th>
            <th>Batt</th>
            <th>Age</th>
            <th>Window</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {race.trackers.map((t) => {
            const age = packetAgeS(t.imei, lastSeen, t);
            const offM = t.offCourse !== undefined
              ? Math.round(t.offCourse * (race.units === 'miles' ? 1609.34 : 1000))
              : undefined;
            const gaps = t.health?.gapsDetected ?? 0;
            return (
              <tr
                key={t.imei}
                className={t.imei === selectedImei ? 'selected' : ''}
                onClick={() => onSelect(t.imei)}
              >
                <td>
                  <div className="t-label">
                    {t.label}
                    {gaps > 0 && <span className="gap-badge" title={`${gaps} frames lost upstream`}>{gaps}⚡</span>}
                  </div>
                  <div className="t-imei">{t.imei}</div>
                </td>
                <td className="num">{t.distance !== undefined ? d(t.distance).toFixed(2) : '—'}</td>
                <td className={`num ${t.suspect ? 'warn' : ''}`}>{offM !== undefined ? `${offM}m` : '—'}</td>
                <td><GpsChip tracker={t} /></td>
                <td><BatteryBar tracker={t} /></td>
                <td className={`num ${ageClass(age, intervalS)}`}>{fmtAge(age)}</td>
                <td className="num window-cell">
                  {t.window.mode === 'clamped' && <span className="clamp-badge">HOLD</span>}
                  {d(t.window.min).toFixed(1)}–{d(t.window.max).toFixed(1)}
                </td>
                <td>
                  <button
                    className="mini"
                    onClick={(e) => {
                      e.stopPropagation();
                      onWindow(t.imei);
                    }}
                  >
                    Window
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

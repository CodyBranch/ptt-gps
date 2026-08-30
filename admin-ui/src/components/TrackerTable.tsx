import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, Units } from '../types';
import { BatteryBar, GpsChip } from './Health';
import { ageClass, fmtAge, packetAgeS } from './RolesPanel';

export function TrackerTable({
  race,
  displayUnits,
  colors,
  lastSeen,
  intervalS,
  readonly,
  selectedImei,
  onSelect,
  onWindow,
}: {
  race: RaceSnap;
  displayUnits: Units;
  /** Per-IMEI colour, matching the tracker's dot on the map. */
  colors: Record<string, string>;
  lastSeen: Record<string, number>;
  intervalS: number;
  readonly?: boolean;
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
            <th className="col-name">Tracker</th>
            <th className="col-dist">Dist</th>
            <th className="col-gps">GPS</th>
            <th className="col-batt">Batt</th>
            <th className="col-age">Age</th>
            <th className="col-window">Window</th>
            {!readonly && <th></th>}
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
                    <span className="t-swatch" style={{ background: colors[t.imei] }} />
                    {t.label}
                    {gaps > 0 && <span className="gap-badge" title={`${gaps} frames lost upstream`}>{gaps}⚡</span>}
                  </div>
                  <div className="t-imei">{t.imei}</div>
                </td>
                <td className={`num col-dist ${t.suspect ? 'warn' : ''}`} title={offM !== undefined ? `${offM} m off course` : undefined}>
                  {t.distance !== undefined ? `${d(t.distance).toFixed(2)} ${unitAbbr(displayUnits)}` : '—'}
                </td>
                <td className="col-gps"><GpsChip tracker={t} /></td>
                <td className="col-batt"><BatteryBar tracker={t} /></td>
                <td className={`num col-age ${ageClass(age, intervalS)}`}>{fmtAge(age)}</td>
                <td className="num window-cell col-window">
                  {t.window.mode === 'clamped' && <span className="clamp-badge">HOLD</span>}
                  {d(t.window.min).toFixed(1)}–{d(t.window.max).toFixed(1)} {unitAbbr(displayUnits)}
                </td>
                {!readonly && (
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
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

import type { RaceSnap } from '../types';
import { ageClass, fixAgeS, fmtAge } from './RolesPanel';

export function TrackerTable({
  race,
  selectedImei,
  onSelect,
  onWindow,
}: {
  race: RaceSnap;
  selectedImei?: string;
  onSelect: (imei: string) => void;
  onWindow: (imei: string) => void;
}) {
  return (
    <div className="tracker-table">
      <table>
        <thead>
          <tr>
            <th>Tracker</th>
            <th>Dist</th>
            <th>Off</th>
            <th>Batt</th>
            <th>Age</th>
            <th>Gaps</th>
            <th>Window</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {race.trackers.map((t) => {
            const age = fixAgeS(t);
            const offM = t.offCourse !== undefined
              ? Math.round(t.offCourse * (race.units === 'miles' ? 1609.34 : 1000))
              : undefined;
            return (
              <tr
                key={t.imei}
                className={t.imei === selectedImei ? 'selected' : ''}
                onClick={() => onSelect(t.imei)}
              >
                <td>
                  <div className="t-label">{t.label}</div>
                  <div className="t-imei">{t.imei}</div>
                </td>
                <td className="num">{t.distance !== undefined ? t.distance.toFixed(2) : '—'}</td>
                <td className={`num ${t.suspect ? 'warn' : ''}`}>{offM !== undefined ? `${offM}m` : '—'}</td>
                <td className="num">
                  {t.hasBattery ? (t.lastFix?.battery !== undefined ? `${t.lastFix.battery}%` : '—') : 'ext'}
                </td>
                <td className={`num ${ageClass(age)}`}>{fmtAge(age)}</td>
                <td className="num">{t.health?.gapsDetected || ''}</td>
                <td className="num window-cell">
                  {t.window.mode === 'clamped' && <span className="clamp-badge">HOLD</span>}
                  {t.window.min.toFixed(1)}–{t.window.max.toFixed(1)}
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

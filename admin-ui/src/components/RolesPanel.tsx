import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, TrackerPub, Units } from '../types';
import { BatteryBar, GpsChip } from './Health';

/** Fix age in seconds, from server receive time. */
export function fixAgeS(t: TrackerPub | undefined): number | undefined {
  if (!t?.lastFix) return undefined;
  return Math.max(0, Math.round((Date.now() - t.lastFix.receivedAtMs) / 1000));
}

export function ageClass(age: number | undefined): string {
  if (age === undefined) return 'nodata';
  if (age < 30) return 'fresh';
  if (age < 60) return 'aging';
  return 'stale';
}

export function fmtAge(age: number | undefined): string {
  if (age === undefined) return '—';
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m${age % 60}s`;
  return `${Math.floor(age / 3600)}h+`;
}

export function RolesPanel({
  race,
  displayUnits,
  onActivate,
}: {
  race: RaceSnap;
  displayUnits: Units;
  onActivate: (roleKey: string, imei: string) => void;
}) {
  const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
  const d = (v: number) => toDisplay(v, race.units, displayUnits);
  return (
    <div className="roles-panel">
      {race.roles.map((role) => {
        const active = byImei.get(role.activeImei);
        const activeAge = fixAgeS(active);
        const activeStale = activeAge !== undefined && activeAge >= 60;
        return (
          <div key={role.key} className={`role-card ${activeStale ? 'alert' : ''}`}>
            <div className="role-head">
              <span className="role-label">{role.label}</span>
              <span className="role-dist">
                {active?.distance !== undefined ? `${d(active.distance).toFixed(2)} ${unitAbbr(displayUnits)}` : '—'}
              </span>
            </div>
            {activeStale && role.trackers.length > 1 && (
              <div className="failover-hint">Active tracker stale — switch to backup?</div>
            )}
            {role.trackers.map((imei) => {
              const t = byImei.get(imei);
              const age = fixAgeS(t);
              const isActive = imei === role.activeImei;
              return (
                <div key={imei} className={`role-tracker ${isActive ? 'is-active' : ''}`}>
                  <label>
                    <input
                      type="radio"
                      name={`role-${race.raceId}-${role.key}`}
                      checked={isActive}
                      onChange={() => {
                        if (window.confirm(`Make ${t?.label ?? imei} the active ${role.label}?`)) {
                          onActivate(role.key, imei);
                        }
                      }}
                    />
                    <span className="t-label">{t?.label ?? imei}</span>
                  </label>
                  {t && <GpsChip tracker={t} />}
                  {t && <BatteryBar tracker={t} />}
                  <span className="t-dist">{t?.distance !== undefined ? d(t.distance).toFixed(2) : '—'}</span>
                  <span className={`t-age ${ageClass(age)}`}>{fmtAge(age)}</span>
                  {t?.suspect && <span className="t-suspect" title="Snapped far from course">⚠</span>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

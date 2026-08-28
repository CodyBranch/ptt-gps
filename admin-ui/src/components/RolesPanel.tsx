import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, TrackerPub, Units } from '../types';
import type { ConfirmRequest } from './Confirm';
import { BatteryBar, GpsChip } from './Health';

/**
 * Packet age in seconds: time since ANY frame arrived from the device
 * (lastSeen, race-independent), falling back to the engine's last accepted fix.
 * With a 5–10 s report cadence this is the "is one behind?" number.
 */
export function packetAgeS(
  imei: string,
  lastSeen: Record<string, number>,
  t?: TrackerPub,
): number | undefined {
  const ms = lastSeen[imei] ?? t?.lastFix?.receivedAtMs;
  if (ms === undefined) return undefined;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

/** Thresholds scale with the event's expected report interval (default 10 s):
 *  fresh ≤ 2 missed reports, aging ≤ 4, stale beyond that. */
export function ageClass(age: number | undefined, intervalS: number): string {
  if (age === undefined) return 'nodata';
  if (age <= intervalS * 2) return 'fresh';
  if (age <= intervalS * 4) return 'aging';
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
  lastSeen,
  intervalS,
  readonly,
  ask,
  onActivate,
}: {
  race: RaceSnap;
  displayUnits: Units;
  lastSeen: Record<string, number>;
  intervalS: number;
  readonly?: boolean;
  ask: (req: ConfirmRequest) => void;
  onActivate: (roleKey: string, imei: string) => void;
}) {
  const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
  const d = (v: number) => toDisplay(v, race.units, displayUnits);
  return (
    <div className="roles-panel">
      {race.roles.map((role) => {
        const active = byImei.get(role.activeImei);
        const activeAge = packetAgeS(role.activeImei, lastSeen, active);
        const activeStale = activeAge !== undefined && activeAge > intervalS * 6;
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
              const age = packetAgeS(imei, lastSeen, t);
              const isActive = imei === role.activeImei;
              return (
                <div key={imei} className={`role-tracker ${isActive ? 'is-active' : ''}`}>
                  <label>
                    {readonly ? (
                      <span className={`active-dot ${isActive ? 'on' : ''}`} />
                    ) : (
                      <input
                        type="radio"
                        name={`role-${race.raceId}-${role.key}`}
                        checked={isActive}
                        onChange={() =>
                          ask({
                            title: `Make ${t?.label ?? imei} the active ${role.label}?`,
                            body:
                              race.status === 'live'
                                ? 'Published distances switch to this tracker immediately.'
                                : undefined,
                            confirmLabel: 'Switch',
                            onConfirm: () => onActivate(role.key, imei),
                          })
                        }
                      />
                    )}
                    <span className="t-label">{t?.label ?? imei}</span>
                  </label>
                  {t && <GpsChip tracker={t} />}
                  {t && <BatteryBar tracker={t} />}
                  <span className="t-dist">{t?.distance !== undefined ? d(t.distance).toFixed(2) : '—'}</span>
                  <span className={`t-age ${ageClass(age, intervalS)}`}>{fmtAge(age)}</span>
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

import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, SimulatedDistance, TrackerPub, Units } from '../types';
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
  simulated,
  readonly,
  ask,
  onActivate,
  onSetSource,
  onVehicle,
}: {
  race: RaceSnap;
  displayUnits: Units;
  lastSeen: Record<string, number>;
  intervalS: number;
  simulated?: Record<string, SimulatedDistance>;
  readonly?: boolean;
  ask: (req: ConfirmRequest) => void;
  onActivate: (roleKey: string, imei: string) => void;
  onSetSource: (roleKey: string, source: 'gps' | 'splits') => void;
  onVehicle: (roleKey: string, vehicle: string) => void;
}) {
  const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
  const vehicleLabel = (key: string) => race.vehicles.find((v) => v.key === key)?.label || key;
  const d = (v: number) => toDisplay(v, race.units, displayUnits);
  return (
    <div className="roles-panel">
      {race.roles.map((role) => {
        const active = byImei.get(role.activeImei);
        const activeAge = packetAgeS(role.activeImei, lastSeen, active);
        const activeStale = activeAge !== undefined && activeAge > intervalS * 6;
        const roleSim =
          simulated?.[role.key] ??
          simulated?.[role.activeImei] ??
          (role.cmd !== undefined ? simulated?.[String(role.cmd)] : undefined);
        const onSplits = role.source === 'splits';
        const switchSource = (source: 'gps' | 'splits') => {
          if (source === role.source) return;
          ask({
            title: source === 'splits' ? `Publish ${role.label} from the split feed?` : `Publish ${role.label} from GPS?`,
            body:
              source === 'splits'
                ? 'The headline distance comes from the external split-time feed; the active tracker’s GPS stops publishing it (tracker data keeps flowing).'
                : 'The active tracker’s GPS resumes publishing the headline distance.',
            confirmLabel: source === 'splits' ? 'Use splits' : 'Use GPS',
            danger: source === 'splits',
            onConfirm: () => onSetSource(role.key, source),
          });
        };
        return (
          <div key={role.key} className={`role-card ${activeStale ? 'alert' : ''}`}>
            <div className="role-head">
              <span className="role-label">{role.label}</span>
              {!readonly && (
                <span className="source-toggle" title="Which feed publishes this role's distance">
                  <button className={!onSplits ? 'on' : ''} onClick={() => switchSource('gps')}>
                    GPS
                  </button>
                  <button className={onSplits ? 'on' : ''} onClick={() => switchSource('splits')}>
                    ⏱
                  </button>
                </span>
              )}
              <span className={`role-dist ${onSplits ? 'from-splits' : ''}`}>
                {onSplits
                  ? roleSim
                    ? `⏱ ${roleSim.distance.toFixed(2)}`
                    : '⏱ waiting for feed'
                  : active?.distance !== undefined
                    ? `${d(active.distance).toFixed(2)} ${unitAbbr(displayUnits)}`
                    : '—'}
              </span>
            </div>
            {/* Which vehicle is covering this role — the swap that moves
                coverage between motos without touching the output bindings. */}
            <div className="role-vehicle-line">
              <span className="dim">Covered by</span>
              {readonly ? (
                <span className="role-vehicle-name">{vehicleLabel(role.vehicle)}</span>
              ) : (
                <select
                  value={role.vehicle}
                  onChange={(e) => {
                    const to = e.target.value;
                    if (to === role.vehicle) return;
                    ask({
                      title: `Hand ${role.label} to ${vehicleLabel(to)}?`,
                      body:
                        `${vehicleLabel(to)} takes over this role's output immediately. ` +
                        'Its scoreboard slot and map channel do not change.',
                      confirmLabel: 'Reassign',
                      onConfirm: () => onVehicle(role.key, to),
                    });
                  }}
                >
                  {race.vehicles.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label || v.key}
                    </option>
                  ))}
                </select>
              )}
              {race.roles.filter((r) => r.vehicle === role.vehicle).length > 1 && (
                <span className="warn-text" title="This vehicle is covering more than one role">
                  ⚠ also on {race.roles.filter((r) => r.vehicle === role.vehicle && r.key !== role.key).map((r) => r.label).join(', ')}
                </span>
              )}
            </div>
            {activeStale && role.trackers.length > 1 && (
              <div className="failover-hint">Active tracker stale — switch to backup?</div>
            )}
            {roleSim && (
              <div className="splits-line" title="Simulated distance from the external split-time feed">
                ⏱ splits: {roleSim.distance.toFixed(2)}
                {roleSim.raceTime ? ` @ ${roleSim.raceTime}` : ''} · {fmtAge(Math.round((Date.now() - roleSim.tMs) / 1000))} ago
              </div>
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
                  <span className="t-dist">
                    {t?.distance !== undefined ? `${d(t.distance).toFixed(2)} ${unitAbbr(displayUnits)}` : '—'}
                  </span>
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

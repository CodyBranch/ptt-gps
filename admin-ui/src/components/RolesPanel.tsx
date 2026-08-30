import { useState } from 'react';
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
  colors,
  decimals = 2,
  lastSeen,
  intervalS,
  simulated,
  readonly,
  ask,
  onActivate,
  onSetSource,
  onVehicle,
  onMoveTracker,
}: {
  race: RaceSnap;
  displayUnits: Units;
  /** Per-IMEI colour, matching the tracker's dot on the map. */
  colors: Record<string, string>;
  /** Decimals on distances; viewer pages can be set coarser in Setup. */
  decimals?: number;
  lastSeen: Record<string, number>;
  intervalS: number;
  simulated?: Record<string, SimulatedDistance>;
  readonly?: boolean;
  ask: (req: ConfirmRequest) => void;
  onActivate: (roleKey: string, imei: string) => void;
  onSetSource: (roleKey: string, source: 'gps' | 'splits') => void;
  onVehicle: (roleKey: string, vehicle: string) => void;
  onMoveTracker: (imei: string, vehicle: string) => void;
}) {
  const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
  const vehicles = race.vehicles ?? [];
  const vehicleLabel = (key: string) => vehicles.find((v) => v.key === key)?.label || key;
  const d = (v: number) => toDisplay(v, race.units, displayUnits);
  // which tracker row has its "move to another vehicle" picker open
  const [moving, setMoving] = useState<string | null>(null);
  return (
    <div className="roles-panel">
      {/* Vehicle-first: a moto is a physical thing carrying trackers, and it is
          assigned to cover a role. Leading with the role hid that — the
          trackers read as belonging to "Lead Men" rather than to the bike. */}
      {vehicles.map((vehicle) => {
        const covering = race.roles.filter((r) => r.vehicle === vehicle.key);
        const role = covering[0];
        const active = role?.activeImei ? byImei.get(role.activeImei) : undefined;
        const activeAge = packetAgeS(role?.activeImei ?? '', lastSeen, active);
        const activeStale = activeAge !== undefined && activeAge > intervalS * 6;
        const onSplits = role?.source === 'splits';
        const roleSim = role
          ? (simulated?.[role.key] ??
            (role.activeImei ? simulated?.[role.activeImei] : undefined) ??
            (role.cmd !== undefined ? simulated?.[String(role.cmd)] : undefined))
          : undefined;

        const switchSource = (source: 'gps' | 'splits') => {
          if (!role || source === role.source) return;
          ask({
            title:
              source === 'splits'
                ? `Publish ${role.label} from the split feed?`
                : `Publish ${role.label} from GPS?`,
            body:
              source === 'splits'
                ? 'The headline distance comes from the external split-time feed; the active tracker stops publishing it (tracker data keeps flowing).'
                : 'The active tracker resumes publishing the headline distance.',
            confirmLabel: source === 'splits' ? 'Use splits' : 'Use GPS',
            danger: source === 'splits',
            onConfirm: () => onSetSource(role.key, source),
          });
        };

        /** Put this vehicle on a role, displacing whoever was on it. */
        const assign = (roleKey: string) => {
          if (roleKey === '') {
            if (!role) return;
            ask({
              title: `Stand ${vehicle.label} down from ${role.label}?`,
              body: `${role.label} publishes nothing until a vehicle is put back on it. Its scoreboard slot and map channel are untouched.`,
              confirmLabel: 'Stand down',
              danger: true,
              onConfirm: () => onVehicle(role.key, ''),
            });
            return;
          }
          const target = race.roles.find((r) => r.key === roleKey)!;
          const displaced = vehicles.find((v) => v.key === target.vehicle && v.key !== vehicle.key);
          ask({
            title: `Put ${vehicle.label} on ${target.label}?`,
            body: displaced
              ? `${displaced.label} comes off ${target.label}. The role keeps its scoreboard slot and map channel.`
              : `${target.label} keeps its scoreboard slot and map channel; only the vehicle behind it changes.`,
            confirmLabel: 'Assign',
            onConfirm: () => {
              onVehicle(target.key, vehicle.key);
              // a vehicle can only be in one place, so it leaves its old role
              if (role && role.key !== target.key) onVehicle(role.key, '');
            },
          });
        };

        return (
          <div key={vehicle.key} className={`role-card ${activeStale ? 'alert' : ''} ${role ? '' : 'idle'}`}>
            <div className="role-head">
              <span className="role-label">{vehicle.label || vehicle.key}</span>
              {role && !readonly && (
                <span className="source-toggle" title="Which feed publishes this role's distance">
                  <button className={onSplits ? '' : 'on'} onClick={() => switchSource('gps')}>
                    GPS
                  </button>
                  <button className={onSplits ? 'on' : ''} onClick={() => switchSource('splits')}>
                    ⏱
                  </button>
                </span>
              )}
              <span className={`role-dist ${onSplits ? 'from-splits' : ''}`}>
                {!role
                  ? '—'
                  : onSplits
                    ? roleSim
                      ? `⏱ ${roleSim.distance.toFixed(decimals)}`
                      : '⏱ waiting for feed'
                    : active?.distance !== undefined
                      ? `${d(active.distance).toFixed(decimals)} ${unitAbbr(displayUnits)}`
                      : '—'}
              </span>
            </div>

            <div className="role-vehicle-line">
              <span className="dim">Covering</span>
              {readonly ? (
                <span className="role-vehicle-name">{role ? role.label : 'nothing'}</span>
              ) : (
                <select value={role?.key ?? ''} onChange={(e) => assign(e.target.value)}>
                  <option value="">— not assigned —</option>
                  {race.roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              )}
              {covering.length > 1 && (
                <span className="warn-text" title="This vehicle is covering more than one role">
                  ⚠ also {covering.slice(1).map((r) => r.label).join(', ')}
                </span>
              )}
            </div>

            {activeStale && vehicle.trackers.length > 1 && (
              <div className="failover-hint">Active tracker stale — switch to backup?</div>
            )}
            {roleSim && (
              <div className="splits-line" title="Simulated distance from the external split-time feed">
                ⏱ splits: {roleSim.distance.toFixed(2)}
                {roleSim.raceTime ? ` @ ${roleSim.raceTime}` : ''} ·{' '}
                {fmtAge(Math.round((Date.now() - roleSim.tMs) / 1000))} ago
              </div>
            )}

            {vehicle.trackers.map((imei) => {
              const t = byImei.get(imei);
              const isActive = role?.activeImei === imei;
              const age = packetAgeS(imei, lastSeen, t);

              /** The tracker turned out to be on a different bike than we thought. */
              const move = (to: string) => {
                setMoving(null);
                if (to === vehicle.key) return;
                const target = vehicles.find((v) => v.key === to);
                ask({
                  title: to
                    ? `Move ${t?.label ?? imei} to ${target?.label ?? to}?`
                    : `Take ${t?.label ?? imei} off ${vehicle.label}?`,
                  body:
                    (to
                      ? `It stops counting for ${vehicle.label} and starts counting for ${target?.label ?? to}. `
                      : `It stops counting for any vehicle but keeps reporting. `) +
                    'Its distance and window are kept — same device on the same course — and the change applies to every race in this event.' +
                    (isActive && role ? ` ${role.label} falls back to this vehicle's next tracker.` : ''),
                  confirmLabel: to ? 'Move' : 'Take off',
                  danger: !to,
                  onConfirm: () => onMoveTracker(imei, to),
                });
              };

              return (
                <div
                  key={imei}
                  className={`role-tracker ${isActive ? 'active' : ''}`}
                  onClick={() => !readonly && role && !isActive && onActivate(role.key, imei)}
                  title={
                    role
                      ? isActive
                        ? 'Publishing this role'
                        : 'Make this the publishing tracker'
                      : 'This vehicle is not covering a role'
                  }
                >
                  <span className={`radio ${isActive ? 'on' : ''}`} />
                  <span className="t-swatch" style={{ background: colors[imei] }} />
                  <span className="t-name">{t?.label ?? imei}</span>
                  <BatteryBar tracker={t} />
                  <GpsChip tracker={t} />
                  <span className="t-dist">
                    {t?.distance !== undefined ? `${d(t.distance).toFixed(decimals)} ${unitAbbr(displayUnits)}` : '—'}
                  </span>
                  <span className={`t-age ${ageClass(age, intervalS)}`}>{fmtAge(age)}</span>
                  {!readonly &&
                    (moving === imei ? (
                      <select
                        className="t-move-pick"
                        autoFocus
                        value={vehicle.key}
                        onClick={(e) => e.stopPropagation()}
                        onBlur={() => setMoving(null)}
                        onChange={(e) => move(e.target.value)}
                      >
                        {vehicles.map((v) => (
                          <option key={v.key} value={v.key}>
                            {v.key === vehicle.key ? `${v.label} (here)` : v.label}
                          </option>
                        ))}
                        <option value="">— no vehicle —</option>
                      </select>
                    ) : (
                      <button
                        className="t-move"
                        title="Wrong bike? Move this tracker to another vehicle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMoving(imei);
                        }}
                      >
                        ⇄
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* Trackers no vehicle is carrying — reporting, but counting for nothing.
          Without this they would disappear from the panel the moment one was
          taken off a bike, with no way to put it on another. */}
      {(() => {
        const carried = new Set(vehicles.flatMap((v) => v.trackers));
        const loose = race.trackers.filter((t) => !carried.has(t.imei));
        if (loose.length === 0 || vehicles.length === 0) return null;
        return (
          <div className="roles-loose">
            <span className="dim">Not on a vehicle:</span>
            {loose.map((t) => (
              <span key={t.imei} className="loose-tracker">
                <span className="t-swatch" style={{ background: colors[t.imei] }} />
                <span className="t-name">{t.label ?? t.imei}</span>
                {readonly ? null : (
                  <select
                    className="t-move-pick"
                    value=""
                    onChange={(e) => {
                      const to = e.target.value;
                      if (!to) return;
                      ask({
                        title: `Put ${t.label ?? t.imei} on ${vehicleLabel(to)}?`,
                        body: 'It starts counting for that vehicle. Its distance and window are kept, and the change applies to every race in this event.',
                        confirmLabel: 'Put on',
                        onConfirm: () => onMoveTracker(t.imei, to),
                      });
                    }}
                  >
                    <option value="">put on…</option>
                    {vehicles.map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                )}
              </span>
            ))}
          </div>
        );
      })()}

      {/* Roles nobody is on. The gap is the point, so it is stated plainly. */}
      {race.roles.filter((r) => !r.vehicle).length > 0 && (
        <div className="roles-uncovered">
          <span className="warn-text">Not being covered:</span>{' '}
          {race.roles
            .filter((r) => !r.vehicle)
            .map((r) => r.label)
            .join(', ')}
        </div>
      )}
    </div>
  );

}

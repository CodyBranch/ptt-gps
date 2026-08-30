import { toDisplay, unitAbbr } from '../api';
import type { RaceSnap, SimulatedDistance, Units } from '../types';
import type { MapSelection } from './MapView';
import { packetAgeS } from './RolesPanel';

/**
 * The stripped-back viewer: what each key vehicle has covered, and nothing else.
 *
 * The full viewer is for someone watching the operation — map, trackers,
 * batteries, windows. This one is for someone who only needs the number:
 * an announcer with a phone, a spotter, a screen at the finish. So it is one
 * big figure per role, readable across a room, with no controls to touch.
 *
 * A number nobody can tell is frozen is worse than no number, so a role whose
 * tracker has gone quiet says so instead of quietly showing a stale distance.
 */
export function DistanceBoard({
  races,
  displayUnits,
  decimals = 2,
  lastSeen,
  intervalS,
  simulated,
  selected,
  onSelect,
}: {
  races: RaceSnap[];
  displayUnits: Units;
  /** Decimals for this page, set per event in Setup. */
  decimals?: number;
  lastSeen: Record<string, number>;
  intervalS: number;
  simulated?: Record<string, SimulatedDistance>;
  selected?: MapSelection;
  /** Picking a row puts that vehicle under the spotlight on the map. */
  onSelect?: (raceId: string, imei: string) => void;
}) {
  return (
    <div className="board">
      {races.map((race) => {
        const byImei = new Map(race.trackers.map((t) => [t.imei, t]));
        const d = (v: number) => toDisplay(v, race.units, displayUnits);
        const vehicleLabel = (key: string) =>
          (race.vehicles ?? []).find((v) => v.key === key)?.label ?? '';

        return (
          <section className="board-race" key={race.raceId}>
            <div className="board-race-head">
              <h2>{race.name}</h2>
              <span className={`race-status ${race.status}`}>{race.status.toUpperCase()}</span>
              <span className="board-course">
                {d(race.courseLength).toFixed(decimals)} {unitAbbr(displayUnits)}
              </span>
            </div>

            <div className="board-rows">
              {race.roles.map((role) => {
                const active = role.activeImei ? byImei.get(role.activeImei) : undefined;
                const age = packetAgeS(role.activeImei ?? '', lastSeen, active);
                const stale = age !== undefined && age > intervalS * 6;
                const onSplits = role.source === 'splits';
                const sim =
                  simulated?.[role.key] ??
                  (role.activeImei ? simulated?.[role.activeImei] : undefined) ??
                  (role.cmd !== undefined ? simulated?.[String(role.cmd)] : undefined);
                const value = onSplits ? sim?.distance : active?.distance;
                const covered = !!role.vehicle;
                const pct =
                  value !== undefined && race.courseLength > 0
                    ? Math.max(0, Math.min(100, (value / race.courseLength) * 100))
                    : 0;

                return (
                  <div
                    className={
                      `board-row ${!covered ? 'uncovered' : stale ? 'stale' : ''} ` +
                      `${role.activeImei && selected?.imei === role.activeImei && selected.raceId === race.raceId ? 'selected' : ''}`
                    }
                    key={role.key}
                    onClick={() => role.activeImei && onSelect?.(race.raceId, role.activeImei)}
                    title={role.activeImei ? 'Show this vehicle on the map' : undefined}
                  >
                    <div className="board-labels">
                      <span className="board-role">{role.label}</span>
                      {/* migrated events name the vehicle after the role it was
                          covering, and "Lead Vehicle Lead Vehicle" reads as noise */}
                      {covered && vehicleLabel(role.vehicle) !== role.label && (
                        <span className="board-vehicle">{vehicleLabel(role.vehicle)}</span>
                      )}
                    </div>

                    <div className="board-figure">
                      {!covered ? (
                        <span className="board-none">no vehicle</span>
                      ) : value === undefined ? (
                        <span className="board-none">{onSplits ? 'waiting for splits' : 'no distance yet'}</span>
                      ) : (
                        <>
                          <span className="board-value">{d(value).toFixed(decimals)}</span>
                          <span className="board-unit">{unitAbbr(displayUnits)}</span>
                        </>
                      )}
                    </div>

                    {/* the same number as a bar, for reading at a glance */}
                    <div className="board-bar">
                      <div className="board-bar-fill" style={{ width: `${pct}%` }} />
                    </div>

                    {covered && stale && (
                      <div className="board-warn">no report for {Math.round((age ?? 0) / 60)}m — distance may be behind</div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

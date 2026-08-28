import type { RoleState, TrackerState } from '../engine/race-engine.js';
import type { Fix } from '../ingest/types.js';

/**
 * Output sink for computed race data. The Firebase implementation reproduces
 * the legacy RTDB writes byte-for-byte so scoreboards/clocks/maps keep working;
 * the debug implementation logs and records what *would* be written.
 */
export interface Publisher {
  readonly name: string;
  /**
   * Active tracker of a role advanced — the headline distance write.
   * `distanceOut` is already converted to the event's output units.
   */
  roleDistance(meetId: number, role: RoleState, distanceOut: number, state: TrackerState, fix: Fix): void;
  /** Full per-tracker data (legacy <meet>/GPS/<imei>). */
  trackerData(meetId: number, state: TrackerState, distanceOut: number | undefined, fix: Fix, isLead: boolean): void;
  /** The legacy "write/stop" showDistance toggle. */
  showDistance(meetId: number, show: boolean): void;
}

export type PublishRecorder = (target: string, path: string, value: unknown) => void;

/** Dev/dry-run publisher: logs writes and records them via the recorder. */
export class DebugPublisher implements Publisher {
  readonly name = 'debug';
  constructor(private record: PublishRecorder, private verbose = false) {}

  roleDistance(meetId: number, role: RoleState, distanceOut: number, state: TrackerState): void {
    if (this.verbose) console.log(`[publish] ${meetId} role=${role.key} dist=${distanceOut.toFixed(2)} (${state.label})`);
    if (role.clockSlot !== undefined) {
      this.record('debug', `${meetId}/Meta/Clock`, { [`distanceComplete${slotSuffix(role.clockSlot)}`]: distanceOut.toFixed(1) });
    }
    if (role.cmd !== undefined) {
      this.record('debug', `${meetId}/GPSMap/${role.cmd}`, { distance: distanceOut.toFixed(2), event: role.mapEvent, timestamp: Date.now() });
    }
  }

  trackerData(meetId: number, state: TrackerState, distanceOut: number | undefined, fix: Fix, isLead: boolean): void {
    this.record('debug', `${meetId}/GPS/${state.imei}`, { distance: distanceOut, is_lead: isLead ? 'Y' : 'N' });
  }

  showDistance(meetId: number, show: boolean): void {
    console.log(`[publish] ${meetId} showDistance=${show}`);
    this.record('debug', `${meetId}/Meta/Clock`, { showDistance: show });
  }
}

export const slotSuffix = (slot: number): string => (slot === 1 ? '' : String(slot));

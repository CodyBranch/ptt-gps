import * as turf from '@turf/turf';
import type { EventConfig, RaceConfig, RoleConfig, SnapConfig, TrackerConfig, VehicleConfig } from '../config/schema.js';
import { resolveRace } from '../config/schema.js';
import { loadCourse, type Course } from './course.js';
import { initialWindow, snapFix, windowSlice, type SnapWindow } from './snap.js';
import type { Fix } from '../ingest/types.js';

export type RaceStatus = 'scheduled' | 'armed' | 'live' | 'finished';

export interface TrackerState {
  imei: string;
  label: string;
  hasBattery: boolean;
  window: SnapWindow;
  distance?: number;
  offCourse?: number;
  suspect?: boolean;
  pathLat?: number;
  pathLon?: number;
  lastFix?: { lat: number; lon: number; tUtcMs: number; altM?: number; battery?: number; speedKmh?: number; azimuth?: number; accuracy?: number; hdop?: number; sats?: number; receivedAtMs: number };
  /** Speed computed from successive snapped fixes, mph (legacy speed_cal). */
  speedCalMph?: number;
}

export interface RoleState extends RoleConfig {
  /** The assigned vehicle's trackers, primary first — resolved at build time
   *  and swapped wholesale when the role is reassigned to another vehicle. */
  trackers: string[];
  activeImei: string;
  /**
   * Which feed publishes this role's headline distance: the active tracker's
   * GPS (normal), or the external split-time feed (when GPS is unusable).
   */
  source: 'gps' | 'splits';
}

export interface EngineHooks {
  /** A tracker in this race produced a new snapped position. */
  onTrackerUpdate: (raceId: string, state: TrackerState) => void;
  /**
   * The *active* tracker of a role produced a distance while the race is live —
   * this is what publishers forward to Firebase.
   */
  onRoleDistance: (raceId: string, role: RoleState, state: TrackerState, fix: Fix) => void;
  /** Lifecycle / operator actions worth recording into the session timeline. */
  onSessionEvent: (raceId: string, type: string, payload: Record<string, unknown>) => void;
}

/**
 * One RaceEngine per race. Keyed on (race, tracker): the same physical tracker
 * gets independent window state in each race, so reassignment across races in
 * a meet resets cleanly.
 */
export class RaceEngine {
  readonly race: RaceConfig;
  readonly course: Course;
  readonly snap: SnapConfig;
  readonly trackers = new Map<string, TrackerState>();
  readonly roles: RoleState[];
  /** The meet's vehicles, so coverage can be reassigned while racing. */
  readonly vehicles: VehicleConfig[];
  status: RaceStatus = 'scheduled';

  private trackerCfg = new Map<string, TrackerConfig>();
  private hooks: EngineHooks;

  constructor(event: EventConfig, race: RaceConfig, hooks: EngineHooks) {
    this.race = race;
    this.hooks = hooks;
    const { trackers, vehicles, roles, snap } = resolveRace(event, race);
    this.vehicles = vehicles;
    this.snap = snap;
    this.course = loadCourse(race.course, race.units);
    for (const t of trackers) {
      this.trackerCfg.set(t.imei, t);
      this.trackers.set(t.imei, {
        imei: t.imei,
        label: t.label,
        hasBattery: t.hasBattery,
        window: initialWindow(snap, this.course.length),
      });
    }
    this.roles = roles.map((r) => ({ ...r, activeImei: r.trackers[0], source: 'gps' as const }));
  }

  /** Feed one hygiene-accepted fix. Ignores IMEIs not in this race's roster. */
  onFix(fix: Fix): void {
    const state = this.trackers.get(fix.imei);
    if (!state) return;
    // Positions are recorded whatever the race is doing, so the crew can watch
    // vehicles get into place before the gun. Only an armed or live race snaps
    // them to the course and produces a distance.
    const racing = this.status === 'armed' || this.status === 'live';
    const result = racing
      ? snapFix(this.course, state.window, fix.lon, fix.lat, this.snap, state.distance)
      : undefined;

    if (state.lastFix) {
      const dtH = (fix.tUtcMs - state.lastFix.tUtcMs) / 3600_000;
      if (dtH > 0) {
        const dMi = turf.distance(
          [state.lastFix.lon, state.lastFix.lat],
          [fix.lon, fix.lat],
          { units: 'miles' },
        );
        state.speedCalMph = dMi / dtH;
      }
    }

    if (result) {
      state.window = result.window;
      state.distance = result.distance;
      state.offCourse = result.offCourse;
      state.suspect = result.suspect;
      state.pathLat = result.pathLat;
      state.pathLon = result.pathLon;
    }
    state.lastFix = {
      lat: fix.lat,
      lon: fix.lon,
      tUtcMs: fix.tUtcMs,
      altM: fix.altM,
      battery: fix.battery,
      speedKmh: fix.speedKmh,
      azimuth: fix.azimuth,
      accuracy: fix.accuracy,
      hdop: fix.hdop,
      sats: fix.sats,
      receivedAtMs: fix.receivedAtMs,
    };

    this.hooks.onTrackerUpdate(this.race.id, state);

    if (this.status === 'live') {
      for (const role of this.roles) {
        // GPS publishes the role distance only while the role's source is GPS;
        // on 'splits' the external feed owns the headline number.
        if (role.activeImei === fix.imei && role.source === 'gps') {
          this.hooks.onRoleDistance(this.race.id, role, state, fix);
        }
      }
    }
  }

  /** Switch a role's published distance between GPS and the split feed. */
  setSource(roleKey: string, source: 'gps' | 'splits', by?: string): void {
    const role = this.roles.find((r) => r.key === roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    if (source !== 'gps' && source !== 'splits') throw new Error('source must be "gps" or "splits"');
    const prev = role.source;
    if (prev === source) return;
    role.source = source;
    this.hooks.onSessionEvent(this.race.id, 'distance-source', { role: roleKey, from: prev, to: source, by });
  }

  setStatus(status: RaceStatus, by?: string): void {
    const prev = this.status;
    this.status = status;
    if (status === 'armed' && prev === 'scheduled') {
      // fresh windows when arming — stale state from tests/previous race is gone
      for (const s of this.trackers.values()) {
        s.window = initialWindow(this.snap, this.course.length);
      }
    }
    this.hooks.onSessionEvent(this.race.id, 'status', { from: prev, to: status, by });
  }

  /**
   * Hand a role to a different vehicle mid-race.
   *
   * The role keeps its output bindings, so the scoreboard slot it feeds does
   * not move — only the hardware behind it does. Every rostered tracker has
   * been computing all along, so the incoming vehicle arrives with a warm snap
   * window rather than re-acquiring from the start line.
   */
  setVehicle(roleKey: string, vehicleKey: string, by?: string): void {
    const role = this.roles.find((r) => r.key === roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    const vehicle = this.vehicles.find((v) => v.key === vehicleKey);
    if (!vehicle) throw new Error(`Unknown vehicle: ${vehicleKey}`);
    if (vehicle.trackers.length === 0) throw new Error(`Vehicle ${vehicleKey} has no trackers in this race`);
    const from = role.vehicle;
    if (from === vehicleKey) return;
    role.vehicle = vehicleKey;
    role.trackers = vehicle.trackers;
    role.activeImei = vehicle.trackers[0];
    this.hooks.onSessionEvent(this.race.id, 'role-vehicle', { role: roleKey, from, to: vehicleKey, by });
    const state = this.trackers.get(role.activeImei);
    if (state) this.hooks.onTrackerUpdate(this.race.id, state);
  }

  /** Which roles a vehicle is covering right now — two at once is legal during
   *  a handover but worth flagging, since only one can be the truth. */
  rolesFor(vehicleKey: string): RoleState[] {
    return this.roles.filter((r) => r.vehicle === vehicleKey);
  }

  setActive(roleKey: string, imei: string, by?: string): void {
    const role = this.roles.find((r) => r.key === roleKey);
    if (!role) throw new Error(`Unknown role: ${roleKey}`);
    if (!role.trackers.includes(imei)) {
      throw new Error(`Tracker ${imei} is not in role ${roleKey}`);
    }
    const prev = role.activeImei;
    role.activeImei = imei;
    this.hooks.onSessionEvent(this.race.id, 'active-tracker', { role: roleKey, from: prev, to: imei, by });
  }

  /**
   * Operator window override.
   * latch=false → one-shot reset: re-slice there, auto-advance resumes.
   * latch=true  → hold-to-zone: window clamped inside [start,end] until released.
   */
  setWindow(imei: string, start: number, end: number, latch: boolean, by?: string): void {
    const state = this.trackers.get(imei);
    if (!state) throw new Error(`Tracker ${imei} not in race ${this.race.id}`);
    if (!(end > start)) throw new Error('Window end must be greater than start');
    if (start < 0 || end > this.course.length) {
      throw new Error(`Window must be within 0..${this.course.length.toFixed(2)} ${this.course.units}`);
    }
    state.window = latch
      ? { min: start, max: end, mode: 'clamped', clamp: { start, end } }
      : { min: start, max: end, mode: 'auto' };
    // Operator re-sliced on purpose — stale distance must not forward-bias the next snap.
    state.distance = undefined;
    this.hooks.onSessionEvent(this.race.id, 'window-override', { imei, start, end, latch, by });
    this.hooks.onTrackerUpdate(this.race.id, state);
  }

  /**
   * Back to the line: every tracker returns to the state it had before the
   * race ran — no distance, the initial 0..initialMax window, and any latched
   * zone released. Without this a reset kept each tracker's last distance and
   * an advanced window, so a re-run would start mid-course and the stale
   * distance would forward-bias the first snap.
   *
   * The last raw fix is kept: the vehicle is still wherever it is, and
   * resetting the race says nothing about where the device is parked. Role
   * failover choices and GPS/splits sources are also left alone — those are
   * decisions about which hardware to trust, and the hardware has not changed.
   */
  resetTrackers(by?: string): void {
    for (const state of this.trackers.values()) {
      state.window = initialWindow(this.snap, this.course.length);
      state.distance = undefined;
      state.offCourse = undefined;
      state.suspect = undefined;
      state.pathLat = undefined;
      state.pathLon = undefined;
      state.speedCalMph = undefined;
      this.hooks.onTrackerUpdate(this.race.id, state);
    }
    this.hooks.onSessionEvent(this.race.id, 'race-reset', { by });
  }

  releaseClamp(imei: string, by?: string): void {
    const state = this.trackers.get(imei);
    if (!state) throw new Error(`Tracker ${imei} not in race ${this.race.id}`);
    state.window = { min: state.window.min, max: state.window.max, mode: 'auto' };
    this.hooks.onSessionEvent(this.race.id, 'window-release', { imei, by });
    this.hooks.onTrackerUpdate(this.race.id, state);
  }

  /** Current window slice coordinates for the admin map. */
  sliceFor(imei: string): [number, number][] {
    const state = this.trackers.get(imei);
    if (!state) return [];
    return windowSlice(this.course, state.window);
  }
}

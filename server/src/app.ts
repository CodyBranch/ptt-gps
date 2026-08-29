import type { EventConfig } from './config/schema.js';
import { convertUnits, resolveRace } from './config/schema.js';
import { RaceEngine, type RaceStatus, type TrackerState } from './engine/race-engine.js';
import type { Fix } from './ingest/types.js';
import { DebugPublisher, type Publisher } from './outputs/publisher.js';
import { FirebasePublisher } from './outputs/firebase.js';
import type { FirebaseHub } from './outputs/hub.js';
import { Store } from './state/store.js';

export interface AppEvents {
  emit: (event: string, payload: unknown) => void;
}

/**
 * One App per loaded event — engines, sessions, and publishers for that meet.
 * Several run concurrently (multi-event weekends); the shared ingest pipeline
 * in index.ts fans accepted fixes to every loaded App, and each engine simply
 * ignores IMEIs outside its roster.
 */
export class App {
  readonly cfg: EventConfig;
  readonly store: Store;
  readonly engines = new Map<string, RaceEngine>();
  readonly publishers: Publisher[] = [];
  /** Active session per race (only while live). */
  readonly sessions = new Map<string, number>();
  /** Session to attribute the publish being emitted right now (single-threaded). */
  private publishContextSession: number | null = null;
  /** Master output switch — owned globally (index.ts), mirrored here. */
  publishEnabled = true;
  private out: AppEvents;
  /** Per-IMEI comms health from the shared gate (gaps/rejections). */
  private healthFn: (imei: string) => unknown;

  constructor(cfg: EventConfig, store: Store, out: AppEvents, hub?: FirebaseHub, healthFn?: (imei: string) => unknown) {
    this.cfg = cfg;
    this.store = store;
    this.out = out;
    this.healthFn = healthFn ?? (() => undefined);

    const recorder = (target: string, path: string, value: unknown) => {
      this.store.recordPublish(this.publishContextSession, target, path, value);
    };

    if (cfg.firebase.length === 0 || !hub) {
      this.publishers.push(new DebugPublisher(recorder));
    } else {
      for (const target of cfg.firebase) {
        try {
          this.publishers.push(new FirebasePublisher(target, hub, recorder));
          console.log(`[${cfg.id}] firebase target "${target.connection}" (${target.flavor})`);
        } catch (err) {
          console.error(`[${cfg.id}] firebase target "${target.connection}" skipped:`, (err as Error).message);
        }
      }
      if (this.publishers.length === 0) this.publishers.push(new DebugPublisher(recorder));
    }

    for (const race of cfg.races) {
      const engine = new RaceEngine(cfg, race, {
        onTrackerUpdate: (raceId, state) => this.handleTrackerUpdate(raceId, state),
        onRoleDistance: (raceId, role, state, fix) => {
          if (!this.publishEnabled || state.distance === undefined) return;
          this.publishContextSession = this.sessions.get(raceId) ?? null;
          const distOut = convertUnits(state.distance, race.units, cfg.outputUnits);
          for (const p of this.publishers) p.roleDistance(cfg.meetId, role, distOut, state, fix);
        },
        onSessionEvent: (raceId, type, payload) => {
          const sessionId = this.sessions.get(raceId);
          if (sessionId !== undefined) this.store.addSessionEvent(sessionId, type, payload);
          this.out.emit('session-event', { eventId: cfg.id, raceId, type, payload, tMs: Date.now() });
        },
      });
      this.engines.set(race.id, engine);
      console.log(
        `[${cfg.id}] race "${race.id}": course ${engine.course.length.toFixed(2)} ${race.units}, ` +
          `${engine.trackers.size} trackers, ${engine.roles.length} roles`,
      );
    }
  }

  /** Feed one gate-accepted fix (shared pipeline calls this on every loaded App). */
  onFix(fix: Fix): void {
    for (const engine of this.engines.values()) engine.onFix(fix);
  }

  /**
   * A split-feed update matched against this event's roles: publishes for live
   * races whose role source is 'splits' and logs into their sessions.
   */
  applySimulatedDistance(tracker: string, distance: number, raceTime?: string): void {
    for (const engine of this.engines.values()) {
      if (engine.status !== 'live') continue;
      const sessionId = this.sessions.get(engine.race.id);
      if (sessionId !== undefined) {
        this.store.addSessionEvent(sessionId, 'split-distance', { tracker, distance, raceTime });
      }
      if (!this.publishEnabled) continue;
      for (const role of engine.roles) {
        if (role.source !== 'splits') continue;
        const match =
          role.key === tracker || role.activeImei === tracker || (role.cmd !== undefined && String(role.cmd) === tracker);
        if (!match) continue;
        const state = engine.trackers.get(role.activeImei);
        if (!state) continue;
        this.publishContextSession = sessionId ?? null;
        const syntheticFix: Fix = {
          imei: role.activeImei,
          lat: state.lastFix?.lat ?? 0,
          lon: state.lastFix?.lon ?? 0,
          tUtcMs: Date.now(),
          fixValid: true,
          buffered: false,
          source: 'splits',
          protocol: 'gtfri-22',
          raw: '',
          receivedAtMs: Date.now(),
        };
        for (const p of this.publishers) p.roleDistance(this.cfg.meetId, role, distance, state, syntheticFix);
      }
    }
  }

  private handleTrackerUpdate(raceId: string, state: TrackerState): void {
    const engine = this.engines.get(raceId)!;
    this.out.emit('tracker', {
      eventId: this.cfg.id,
      raceId,
      state: publicTrackerState(state),
      slice: engine.sliceFor(state.imei),
      health: this.healthFn(state.imei),
    });
    if (engine.status === 'live' && state.lastFix && this.publishEnabled) {
      this.publishContextSession = this.sessions.get(raceId) ?? null;
      const isLead = engine.roles.some((r) => r.activeImei === state.imei);
      const distOut =
        state.distance !== undefined
          ? convertUnits(state.distance, engine.race.units, this.cfg.outputUnits)
          : undefined;
      for (const p of this.publishers) {
        p.trackerData(
          this.cfg.meetId,
          state,
          distOut,
          {
            imei: state.imei,
            lat: state.lastFix.lat,
            lon: state.lastFix.lon,
            altM: state.lastFix.altM,
            tUtcMs: state.lastFix.tUtcMs,
            battery: state.lastFix.battery,
            speedKmh: state.lastFix.speedKmh,
            azimuth: state.lastFix.azimuth,
            accuracy: state.lastFix.accuracy,
            fixValid: true,
            buffered: false,
            source: '',
            protocol: 'gtfri-22',
            raw: '',
            receivedAtMs: state.lastFix.receivedAtMs,
          },
          isLead,
        );
      }
    }
  }

  lifecycle(raceId: string, action: 'arm' | 'start' | 'finish' | 'reset', atMs?: number, by?: string): RaceStatus {
    const engine = this.engines.get(raceId);
    if (!engine) throw new Error(`Unknown race: ${raceId}`);
    switch (action) {
      case 'arm':
        engine.setStatus('armed', by);
        break;
      case 'start': {
        const race = this.cfg.races.find((r) => r.id === raceId)!;
        const snapshot = { race, resolved: resolveRace(this.cfg, race), startedBy: by };
        const firstLive = this.sessions.size === 0;
        const sessionId = this.store.startSession(this.cfg.id, raceId, snapshot, atMs ?? Date.now());
        this.sessions.set(raceId, sessionId);
        engine.setStatus('live', by);
        if (firstLive && this.publishEnabled) {
          this.publishContextSession = sessionId;
          for (const p of this.publishers) p.showDistance(this.cfg.meetId, true);
        }
        break;
      }
      case 'finish': {
        engine.setStatus('finished', by);
        const sessionId = this.sessions.get(raceId);
        if (sessionId !== undefined) {
          this.store.endSession(sessionId, atMs ?? Date.now());
          this.sessions.delete(raceId);
        }
        if (this.sessions.size === 0 && this.publishEnabled) {
          this.publishContextSession = sessionId ?? null;
          for (const p of this.publishers) p.showDistance(this.cfg.meetId, false);
        }
        break;
      }
      case 'reset':
        engine.setStatus('scheduled', by);
        break;
    }
    this.out.emit('race', this.raceSnapshot(raceId));
    return engine.status;
  }

  /** Flip this app's publishing (global switch calls every loaded app). */
  setPublishing(enabled: boolean, by?: string): void {
    if (enabled === this.publishEnabled) return;
    const anyLive = this.sessions.size > 0;
    this.publishContextSession = this.sessions.values().next().value ?? null;
    if (!enabled && anyLive) {
      for (const p of this.publishers) p.showDistance(this.cfg.meetId, false);
    }
    this.publishEnabled = enabled;
    if (enabled && anyLive) {
      for (const p of this.publishers) p.showDistance(this.cfg.meetId, true);
    }
    for (const sessionId of this.sessions.values()) {
      this.store.addSessionEvent(sessionId, 'publishing', { enabled, by });
    }
  }

  hasActiveRaces(): boolean {
    return [...this.engines.values()].some((e) => e.status === 'armed' || e.status === 'live');
  }

  raceSnapshot(raceId: string) {
    const engine = this.engines.get(raceId)!;
    return {
      eventId: this.cfg.id,
      raceId,
      name: engine.race.name,
      status: engine.status,
      units: engine.race.units,
      courseLength: engine.course.length,
      sessionId: this.sessions.get(raceId) ?? null,
      roles: engine.roles,
      trackers: [...engine.trackers.values()].map((s) => ({
        ...publicTrackerState(s),
        slice: engine.sliceFor(s.imei),
        health: this.healthFn(s.imei),
      })),
    };
  }

  snapshot() {
    return {
      event: {
        id: this.cfg.id,
        name: this.cfg.name,
        meetId: this.cfg.meetId,
        reportIntervalS: this.cfg.reportIntervalS,
        startDate: this.cfg.startDate,
        endDate: this.cfg.endDate,
      },
      publishEnabled: this.publishEnabled,
      races: this.cfg.races.map((r) => this.raceSnapshot(r.id)),
    };
  }
}

function publicTrackerState(s: TrackerState) {
  return {
    imei: s.imei,
    label: s.label,
    hasBattery: s.hasBattery,
    window: s.window,
    distance: s.distance,
    offCourse: s.offCourse,
    suspect: s.suspect,
    pathLat: s.pathLat,
    pathLon: s.pathLon,
    lastFix: s.lastFix,
    speedCalMph: s.speedCalMph,
    gpsQuality: gpsQuality(s.lastFix),
  };
}

/**
 * Normalized GNSS lock certainty for the UI.
 * GL family reports the GTFRI accuracy field (legacy semantics: 1 = good,
 * >=2 = degraded, 0 = no current fix). GV500CNA reports HDOP + satellite count.
 */
function gpsQuality(lastFix: TrackerState['lastFix']): 'good' | 'ok' | 'poor' | undefined {
  if (!lastFix) return undefined;
  if (lastFix.hdop !== undefined) {
    if (lastFix.hdop <= 1.2) return 'good';
    if (lastFix.hdop <= 2.5) return 'ok';
    return 'poor';
  }
  if (lastFix.accuracy !== undefined) {
    if (lastFix.accuracy === 1) return 'good';
    if (lastFix.accuracy >= 2) return 'ok';
    return 'poor'; // 0 = repeating last known position
  }
  return undefined;
}

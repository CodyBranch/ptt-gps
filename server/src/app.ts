import type { EventConfig } from './config/schema.js';
import { resolveRace } from './config/schema.js';
import { RaceEngine, type RaceStatus, type TrackerState } from './engine/race-engine.js';
import { FixGate } from './ingest/hygiene.js';
import type { Fix, Telemetry } from './ingest/types.js';
import { DebugPublisher, type Publisher } from './outputs/publisher.js';
import { FirebasePublisher } from './outputs/firebase.js';
import { Store } from './state/store.js';

export interface AppEvents {
  emit: (event: string, payload: unknown) => void;
}

/** Ties ingest → hygiene → engines → publishers together for one event (meet). */
export class App {
  readonly cfg: EventConfig;
  readonly store: Store;
  readonly gate: FixGate;
  readonly engines = new Map<string, RaceEngine>();
  readonly publishers: Publisher[] = [];
  /** Active session per race (only while live). */
  readonly sessions = new Map<string, number>();
  private out: AppEvents;

  constructor(cfg: EventConfig, store: Store, out: AppEvents) {
    this.cfg = cfg;
    this.store = store;
    this.out = out;
    this.gate = new FixGate();

    const recorder = (target: string, path: string, value: unknown) => {
      // Attribute the publish to whichever race is currently live (session-stamped
      // for replay); with multiple simultaneous live races this records the first.
      const sessionId = this.sessions.values().next().value ?? null;
      this.store.recordPublish(sessionId, target, path, value);
    };

    if (cfg.firebase.length === 0) {
      this.publishers.push(new DebugPublisher(recorder));
      console.log('[outputs] no firebase targets configured — running with debug publisher');
    } else {
      for (const target of cfg.firebase) {
        this.publishers.push(new FirebasePublisher(target, recorder));
        console.log(`[outputs] firebase target "${target.name}" (${target.flavor})`);
      }
    }

    for (const race of cfg.races) {
      const engine = new RaceEngine(cfg, race, {
        onTrackerUpdate: (raceId, state) => this.handleTrackerUpdate(raceId, state),
        onRoleDistance: (raceId, role, state, fix) => {
          for (const p of this.publishers) p.roleDistance(cfg.meetId, role, state, fix);
        },
        onSessionEvent: (raceId, type, payload) => {
          const sessionId = this.sessions.get(raceId);
          if (sessionId !== undefined) this.store.addSessionEvent(sessionId, type, payload);
          this.out.emit('session-event', { raceId, type, payload, tMs: Date.now() });
        },
      });
      this.engines.set(race.id, engine);
      console.log(
        `[engine] race "${race.id}": course ${engine.course.length.toFixed(2)} ${race.units}, ` +
          `${engine.trackers.size} trackers, ${engine.roles.length} roles`,
      );
    }
  }

  onFix(fix: Fix): void {
    const gate = this.gate.accept(fix);
    this.store.recordFix(fix, gate.ok, gate.reason);
    this.out.emit('fix', {
      imei: fix.imei,
      lat: fix.lat,
      lon: fix.lon,
      tUtcMs: fix.tUtcMs,
      battery: fix.battery,
      accuracy: fix.accuracy,
      buffered: fix.buffered,
      accepted: gate.ok,
      reason: gate.reason,
      source: fix.source,
      protocol: fix.protocol,
    });
    if (!gate.ok) return;
    for (const engine of this.engines.values()) engine.onFix(fix);
  }

  onTelemetry(t: Telemetry): void {
    this.store.recordTelemetry(t);
    this.out.emit('telemetry', { imei: t.imei, type: t.type, tUtcMs: t.tUtcMs, source: t.source });
  }

  private handleTrackerUpdate(raceId: string, state: TrackerState): void {
    const engine = this.engines.get(raceId)!;
    this.out.emit('tracker', {
      raceId,
      state: publicTrackerState(state),
      slice: engine.sliceFor(state.imei),
      health: this.gate.health(state.imei),
    });
    if (engine.status === 'live' && state.lastFix) {
      const isLead = engine.roles.some((r) => r.activeImei === state.imei);
      for (const p of this.publishers) {
        p.trackerData(
          this.cfg.meetId,
          state,
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

  lifecycle(raceId: string, action: 'arm' | 'start' | 'finish' | 'reset', atMs?: number): RaceStatus {
    const engine = this.engines.get(raceId);
    if (!engine) throw new Error(`Unknown race: ${raceId}`);
    switch (action) {
      case 'arm':
        engine.setStatus('armed');
        break;
      case 'start': {
        const race = this.cfg.races.find((r) => r.id === raceId)!;
        const snapshot = { race, resolved: resolveRace(this.cfg, race) };
        // atMs allows back-dating a start — the fixes are already in the store.
        const sessionId = this.store.startSession(this.cfg.id, raceId, snapshot, atMs ?? Date.now());
        this.sessions.set(raceId, sessionId);
        engine.setStatus('live');
        for (const p of this.publishers) p.showDistance(this.cfg.meetId, true);
        break;
      }
      case 'finish': {
        engine.setStatus('finished');
        for (const p of this.publishers) p.showDistance(this.cfg.meetId, false);
        const sessionId = this.sessions.get(raceId);
        if (sessionId !== undefined) {
          this.store.endSession(sessionId, atMs ?? Date.now());
          this.sessions.delete(raceId);
        }
        break;
      }
      case 'reset':
        engine.setStatus('scheduled');
        break;
    }
    this.out.emit('race', this.raceSnapshot(raceId));
    return engine.status;
  }

  raceSnapshot(raceId: string) {
    const engine = this.engines.get(raceId)!;
    return {
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
        health: this.gate.health(s.imei),
      })),
    };
  }

  snapshot() {
    return {
      event: { id: this.cfg.id, name: this.cfg.name, meetId: this.cfg.meetId },
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
  };
}

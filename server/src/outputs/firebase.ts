import fs from 'node:fs';
import admin from 'firebase-admin';
import type { FirebaseTarget } from '../config/schema.js';
import type { RoleState, TrackerState } from '../engine/race-engine.js';
import type { Fix } from '../ingest/types.js';
import { slotSuffix, type Publisher, type PublishRecorder } from './publisher.js';

/**
 * Firebase RTDB publisher — reproduces the legacy write paths exactly:
 *
 * flavor "ptt" (ptt-franklin):
 *   <meet>/PTT-Scoreboard/1        { Distance<slot>: "12.3", showDistance: "Y"|"N" }
 *   <meet>/Meta/Clock              { distanceComplete<slot>: "12.3", showDistance: bool }
 *   <meet>/GPS/<imei>              full tracker data
 * flavor "krush" (franklin-f56f3):
 *   <meet>/Meta/Clock              { distanceComplete<slot>: "12.3", showDistance: bool }
 *   <meet>/GPSMap/<cmd>            { distance: "12.34", event: "elite_women", timestamp }
 *   <meet>/GPS/<imei>              full tracker data
 *
 * Slot 1 writes the un-numbered legacy keys ("Distance", "distanceComplete").
 */
export class FirebasePublisher implements Publisher {
  readonly name: string;
  private db: admin.database.Database;
  private flavor: 'ptt' | 'krush';

  constructor(target: FirebaseTarget, private record: PublishRecorder) {
    this.name = target.name;
    this.flavor = target.flavor;
    const credPath = process.env[target.credentialEnv];
    if (!credPath || !fs.existsSync(credPath)) {
      throw new Error(
        `Firebase target "${target.name}": env ${target.credentialEnv} must point to a service-account JSON file`,
      );
    }
    // Reuse the named app if it already exists — publishers are re-created when
    // the event config is edited, but firebase-admin apps are process-global.
    const appName = `target-${target.name}`;
    const existing = admin.apps.find((a) => a?.name === appName);
    const app =
      existing ??
      admin.initializeApp(
        {
          credential: admin.credential.cert(JSON.parse(fs.readFileSync(credPath, 'utf8'))),
          databaseURL: target.databaseURL,
        },
        appName,
      );
    this.db = app.database();
  }

  private update(path: string, value: Record<string, unknown>): void {
    this.db.ref().child(path).update(value).catch((err: unknown) => {
      console.error(`[firebase:${this.name}] write failed ${path}:`, err);
    });
    this.record(this.name, path, value);
  }

  roleDistance(meetId: number, role: RoleState, distanceOut: number, state: TrackerState): void {
    const d1 = distanceOut.toFixed(1);
    const d2 = distanceOut.toFixed(2);

    if (role.clockSlot !== undefined) {
      const suffix = slotSuffix(role.clockSlot);
      this.update(`${meetId}/Meta/Clock`, { [`distanceComplete${suffix}`]: d1 });
      if (this.flavor === 'ptt') {
        this.update(`${meetId}/PTT-Scoreboard/1`, { [`Distance${suffix}`]: d1 });
      }
    }
    if (this.flavor === 'krush' && role.cmd !== undefined && role.mapEvent) {
      this.update(`${meetId}/GPSMap/${role.cmd}`, {
        distance: d2,
        event: role.mapEvent,
        timestamp: Date.now(),
      });
    }
  }

  trackerData(meetId: number, state: TrackerState, distanceOut: number | undefined, fix: Fix, isLead: boolean): void {
    this.update(`${meetId}/GPS/${state.imei}`, {
      imei: state.imei,
      distance: distanceOut ?? null,
      is_lead: isLead ? 'Y' : 'N',
      lat: fix.lat,
      long: fix.lon,
      path_lat: state.pathLat ?? null,
      path_long: state.pathLon ?? null,
      path_distoff: state.offCourse ?? null,
      alt: fix.altM ?? null,
      gpstime: fix.tUtcMs,
      gpstimems: fix.tUtcMs,
      bat: fix.battery ?? null,
      tod: new Date(fix.receivedAtMs).toISOString(),
      number: null,
      accuracy: fix.accuracy ?? null,
      speed_gps: fix.speedKmh ?? null,
      speed_cal: state.speedCalMph ?? null,
      azimuth: fix.azimuth ?? null,
    });
  }

  showDistance(meetId: number, show: boolean): void {
    this.update(`${meetId}/Meta/Clock`, { showDistance: show });
    if (this.flavor === 'ptt') {
      this.update(`${meetId}/PTT-Scoreboard/1`, { showDistance: show ? 'Y' : 'N' });
    }
  }
}

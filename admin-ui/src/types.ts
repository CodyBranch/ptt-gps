export type RaceStatus = 'scheduled' | 'armed' | 'live' | 'finished';

export interface SnapWindow {
  min: number;
  max: number;
  mode: 'auto' | 'clamped';
  clamp?: { start: number; end: number };
}

export interface LastFix {
  lat: number;
  lon: number;
  tUtcMs: number;
  altM?: number;
  battery?: number;
  speedKmh?: number;
  azimuth?: number;
  accuracy?: number;
  hdop?: number;
  sats?: number;
  receivedAtMs: number;
}

export type GpsQuality = 'good' | 'ok' | 'poor';

export interface TrackerHealth {
  gapsDetected: number;
  rejected: Record<string, number>;
}

export interface TrackerPub {
  imei: string;
  label: string;
  hasBattery: boolean;
  window: SnapWindow;
  distance?: number;
  offCourse?: number;
  suspect?: boolean;
  pathLat?: number;
  pathLon?: number;
  lastFix?: LastFix;
  speedCalMph?: number;
  gpsQuality?: GpsQuality;
  slice?: [number, number][];
  health?: TrackerHealth;
}

export type Units = 'miles' | 'kilometers';

/** Mirrors the server's as-authored event config (setup editing). */
export interface EventConfigT {
  id: string;
  name: string;
  meetId: number;
  outputUnits: Units;
  reportIntervalS: number;
  listeners: Array<{ name: string; port: number }>;
  firebase: unknown[];
  trackers: Array<{ imei: string; label: string; hasBattery: boolean }>;
  roles: Array<{
    key: string;
    label: string;
    trackers: string[];
    cmd?: number;
    clockSlot?: number;
    mapEvent?: string;
  }>;
  snapDefaults: { minInc: number; maxInc: number; initialMax: number; maxOffCourse: number; fwdTolerance: number };
  races: Array<{ id: string; name: string; course: string; units: Units }>;
}

export interface EventListing {
  id: string;
  name: string;
  meetId: number;
  file: string;
  races: number;
  trackers: number;
  error?: string;
}

export interface CourseInfo {
  file: string;
  points: number;
  lengthMi: number;
  lengthKm: number;
}

export interface FleetRow {
  imei: string;
  label: string;
  model: string | null;
  hasBattery: number;
  notes: string | null;
  retired: number;
  seen_battery: number | null;
  last_received_ms: number | null;
  last_t_utc_ms: number | null;
  protocol: string | null;
}

export interface DeviceRow {
  imei: string;
  last_lat: number | null;
  last_lon: number | null;
  last_t_utc_ms: number | null;
  last_received_ms: number | null;
  battery: number | null;
  accuracy: number | null;
  protocol: string | null;
  source: string | null;
}

export interface RoleState {
  key: string;
  label: string;
  trackers: string[];
  activeImei: string;
  cmd?: number;
  clockSlot?: number;
  mapEvent?: string;
}

export interface RaceSnap {
  raceId: string;
  name: string;
  status: RaceStatus;
  units: 'miles' | 'kilometers';
  courseLength: number;
  sessionId: number | null;
  roles: RoleState[];
  trackers: TrackerPub[];
}

export interface Snapshot {
  event: { id: string; name: string; meetId: number; reportIntervalS: number };
  races: RaceSnap[];
  /** Last time any frame arrived per IMEI (comms health, race-independent). */
  lastSeen: Record<string, number>;
  /** Master output switch — false = nothing is pushed to Firebase/outputs. */
  publishEnabled: boolean;
}

export interface UserRow {
  username: string;
  created_at_ms: number;
}

export interface FixEvent {
  imei: string;
  receivedAtMs: number;
  lat: number;
  lon: number;
  tUtcMs: number;
  battery?: number;
  accuracy?: number;
  buffered: boolean;
  accepted: boolean;
  reason?: string;
  source: string;
  protocol: string;
}

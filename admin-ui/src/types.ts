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
  receivedAtMs: number;
}

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
  slice?: [number, number][];
  health?: TrackerHealth;
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
  event: { id: string; name: string; meetId: number };
  races: RaceSnap[];
}

export interface FixEvent {
  imei: string;
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

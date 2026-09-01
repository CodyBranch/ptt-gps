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

export interface Vehicle {
  key: string;
  label: string;
  trackers: string[];
}

export interface RoleState {
  key: string;
  label: string;
  /** Which vehicle is covering this role right now. */
  vehicle: string;
  trackers: string[];
  activeImei: string;
  /** Which feed publishes the role's headline distance. */
  source: 'gps' | 'splits';
  cmd?: number;
  clockSlot?: number;
  mapEvent?: string;
}

export interface RaceSnap {
  eventId: string;
  raceId: string;
  name: string;
  status: RaceStatus;
  units: 'miles' | 'kilometers';
  courseLength: number;
  sessionId: number | null;
  roles: RoleState[];
  /** The meet's vehicles, so coverage can be reassigned from the race view. */
  vehicles: Vehicle[];
  trackers: TrackerPub[];
}

export interface EventMeta {
  id: string;
  name: string;
  meetId: number;
  reportIntervalS: number;
  /** Decimal places for the viewer pages; the console itself always shows 2. */
  viewerPrecision?: { full: number; board: number };
  startDate?: string;
  endDate?: string;
}

export interface EventSnap {
  event: EventMeta;
  /** Per-event master output switch. */
  publishEnabled: boolean;
  races: RaceSnap[];
}

/** Full server snapshot: every loaded (active) event + global state. */
export interface Snapshot {
  events: EventSnap[];
  lastSeen: Record<string, number>;
  simulated: Record<string, SimulatedDistance>;
}

export interface SimulatedDistance {
  distance: number;
  raceTime?: string;
  tMs: number;
}

export type Units = 'miles' | 'kilometers';

/** Mirrors the server's as-authored event config (setup editing). */
export interface EventConfigT {
  id: string;
  name: string;
  meetId: number;
  startDate?: string;
  endDate?: string;
  outputUnits: Units;
  reportIntervalS: number;
  viewerPrecision?: { full: number; board: number };
  listeners: Array<{ name: string; port: number }>;
  firebase: Array<{ connection: string; flavor: 'ptt' | 'krush' }>;
  trackers: Array<{ imei: string; label: string; hasBattery: boolean }>;
  vehicles: Array<{ key: string; label: string; trackers: string[] }>;
  roles: Array<{
    key: string;
    label: string;
    vehicle: string;
    cmd?: number;
    clockSlot?: number;
    mapEvent?: string;
  }>;
  snapDefaults: { minInc: number; maxInc: number; initialMax: number; maxOffCourse: number; fwdTolerance: number };
  races: Array<{ id: string; name: string; course: string; units: Units }>;
  /** Read-only: is this event currently running? Setup works either way. */
  _active?: boolean;
}

export interface EventListing {
  id: string;
  name: string;
  meetId: number;
  file: string;
  races: number;
  trackers: number;
  startDate?: string;
  endDate?: string;
  error?: string;
}

export interface Owner {
  id: number;
  name: string;
}

export interface FleetRow {
  imei: string;
  label: string;
  model: string | null;
  hasBattery: number;
  notes: string | null;
  ownerId: number | null;
  owner: string | null;
  retired: number;
  seen_battery: number | null;
  last_received_ms: number | null;
  last_t_utc_ms: number | null;
  protocol: string | null;
  last_lat: number | null;
  last_lon: number | null;
  /** Running or still-to-come events only; finished ones live in the history. */
  events: Array<{ id: string; name: string; active: boolean }>;
  pastEvents?: number;
  openIssues: number;
}

export interface DeviceAssignment {
  id: number;
  imei: string;
  event_id: string;
  event_name: string | null;
  action: 'added' | 'removed';
  t_ms: number;
  by: string | null;
}

export interface DeviceIssue {
  id: number;
  imei: string;
  t_ms: number;
  by: string | null;
  severity: 'note' | 'issue' | 'fault';
  text: string;
  resolved_ms: number | null;
  resolved_by: string | null;
}

export interface FirebaseConn {
  name: string;
  databaseURL: string;
  projectId: string | null;
  createdMs: number;
}

export interface TunnelStatus {
  state: 'off' | 'connecting' | 'online' | 'error';
  url?: string;
  error?: string;
  enabled: boolean;
  domain: string;
  hasToken: boolean;
  tokenFromEnv: boolean;
}

export interface UserRow {
  username: string;
  created_at_ms: number;
  role: 'admin' | 'staff';
}

export interface CourseUse {
  eventId: string;
  eventName: string;
  file: string;
  raceId: string;
  raceName: string;
  startDate?: string;
  endDate?: string;
}

export interface CourseInfo {
  file: string;
  points: number;
  lengthMi: number;
  lengthKm: number;
  label?: string | null;
  notes?: string | null;
  archived?: boolean;
  createdMs?: number | null;
  /** Markers live on the course, shared by every event that uses it. */
  autoMarkers?: boolean;
  markerUnits?: Units;
  markers?: Array<{ at: number; label: string; kind?: 'point' | 'post' | 'timing'; units?: Units }>;
  /** Every (event, race) pointing at this course — past events included. */
  uses?: CourseUse[];
  eventCount?: number;
  inActiveEvent?: boolean;
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

/** A RaceResult timing box — decoder, TrackBox or Ubidium. */
export interface DecoderPub {
  deviceId: string;
  name: string;
  type: string;
  connected: boolean;
  lat?: number;
  lon?: number;
  battery?: number;
  temperature?: number;
  firmware?: string;
  fileNo?: string;
  recordsCount?: number;
  hasPower?: boolean;
  inTimingMode?: boolean;
  timeRunning?: boolean;
  inStandby?: boolean;
  readerHealthy?: boolean;
  readerTemperature?: number;
  timeSource?: string;
  errorFlags?: string;
  deviceTime?: string;
  requestTime?: string;
  received?: string;
  seenMs: number;
  /** Hidden locally — another timer's box in a shared account. */
  hidden?: boolean;
}

export interface DecoderStatus {
  configured: boolean;
  enabled: boolean;
  customerId?: number;
  intervalS: number;
  lastPollMs?: number;
  lastError?: string;
  deviceCount: number;
}

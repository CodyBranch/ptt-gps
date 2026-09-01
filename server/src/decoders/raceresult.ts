/**
 * RaceResult device polling — decoders, TrackBoxes and Ubidiums.
 *
 * These are the timing boxes on the course, not the GPS trackers on the
 * vehicles: different hardware, different vendor, different API. Knowing which
 * ones are online and where they are sits next to the vehicle tracking because
 * at a meet it is the same question — is everything on the course working.
 *
 * RaceResult reports the three device families in three different shapes, so
 * everything is normalised to one record before it reaches the rest of the
 * system. The API also rations tokens, hence the cache and the backoff.
 */

/** One device, whatever family it came from. */
export interface DecoderRecord {
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
  /** Device clock vs the clock when we asked — the pair that shows drift. */
  deviceTime?: string;
  requestTime?: string;
  received?: string;
  /** When this poll happened, by our clock. */
  seenMs: number;
  raw: string;
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const bool = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0; // Ubidium reports 0/1
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
};
const str = (v: unknown): string | undefined =>
  v === null || v === undefined || v === '' ? undefined : String(v);

type Raw = Record<string, any>;

/** Decoder and TrackBox: flat, with the status under one of two keys. */
function normalizeDecoderOrTrackBox(raw: Raw, seenMs: number): DecoderRecord {
  const pos = raw.Position ?? {};
  const dec = raw.DecoderStatus ?? null;
  const tbx = raw.TrackboxStatus ?? null;
  // A TrackBox names the same ideas differently; map it onto the decoder's.
  const s = dec ?? {};
  return {
    deviceId: String(raw.DeviceID),
    name: str(raw.DeviceName) ?? String(raw.DeviceID),
    type: str(raw.DeviceType) ?? (tbx ? 'TrackBox' : 'Decoder'),
    connected: bool(raw.Connected) ?? false,
    lat: num(pos.Latitude),
    lon: num(pos.Longitude),
    battery: num(raw.BatteryCharge),
    temperature: num(raw.Temperature),
    firmware: str(s.Firmware ?? tbx?.Firmware),
    fileNo: str(raw.FileNo),
    recordsCount: num(raw.RecordsCount),
    hasPower: bool(s.HasPower ?? tbx?.HasPower),
    inTimingMode: bool(s.IsInTimingMode ?? tbx?.IsInTimingMode),
    timeRunning: bool(s.TimeIsRunning ?? tbx?.IsTimeRunning),
    inStandby: bool(s.IsInStandby ?? tbx?.IsInStandby),
    readerHealthy: bool(s.ReaderIsHealthy),
    readerTemperature: num(s.ReaderTemperature ?? tbx?.ReaderTemperature),
    timeSource: str(s.TimeSource ?? tbx?.TimeSource),
    errorFlags: str(s.ErrorFlags ?? tbx?.ErrorFlags),
    deviceTime: str(raw.RealTime),
    requestTime: str(raw.RealTimeAtRequest),
    received: str(raw.Received),
    seenMs,
    raw: JSON.stringify(raw),
  };
}

/** Ubidium: everything is nested, and connection is a number. */
function normalizeUbidium(raw: Raw, seenMs: number): DecoderRecord {
  const pos = raw.Position ?? {};
  const power = raw.Power ?? {};
  const time = raw.Time ?? {};
  const data = raw.Data ?? {};
  const connected =
    typeof raw.ConnStatus === 'number'
      ? raw.ConnStatus === 1
      : !!raw.ActiveInternal?.Connected || !!raw.ActiveExternal?.Connected;
  return {
    deviceId: String(raw.System?.DeviceID),
    name: str(raw.System?.DeviceName) ?? String(raw.System?.DeviceID),
    type: 'Ubidium',
    connected,
    lat: num(pos.Latitude),
    lon: num(pos.Longitude),
    battery: num(power.Battery1?.Level),
    temperature: num(raw.System?.Temperature),
    firmware: str(raw.System?.Firmware),
    fileNo: str(data.FileNumber),
    // Power.Source 0 means running on battery alone
    hasPower: power.Source === undefined ? undefined : power.Source !== 0,
    deviceTime: str(time.Time),
    requestTime: str(time.DeviceTimeAtRequest),
    received: str(time.Received),
    seenMs,
    raw: JSON.stringify(raw),
  };
}

/** Pick a normaliser from the shape, since the API does not label the family. */
export function normalizeDevice(raw: Raw, seenMs = Date.now()): DecoderRecord | null {
  if (!raw) return null;
  if (raw.System?.DeviceID !== undefined) return normalizeUbidium(raw, seenMs);
  if (raw.DeviceID !== undefined) return normalizeDecoderOrTrackBox(raw, seenMs);
  return null; // an unrecognised shape is dropped rather than half-read
}

export interface RaceResultConfig {
  apiKey: string;
  customerId: number;
  /** Seconds between polls. RaceResult rations tokens, so not too eager. */
  intervalS: number;
  enabled: boolean;
}

const BASE = 'https://rest.devices.raceresult.com';

/**
 * Token cache with single-flight. The API answers 406 when tokens are asked
 * for too often, so one is held for its lifetime and shared by every caller.
 */
export class RaceResultClient {
  private token: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private cfg: Pick<RaceResultConfig, 'apiKey' | 'customerId'>,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private async requestToken(): Promise<string> {
    const res = await this.fetchFn(`${BASE}/token`, {
      method: 'POST',
      headers: { apikey: this.cfg.apiKey, Connection: 'close' },
    });
    if (res.status === 406) throw new Error('RaceResult token limit reached (406) — backing off');
    if (!res.ok) throw new Error(`RaceResult token request failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    let token: string | undefined;
    let ttlSec = 7200;
    try {
      const j = JSON.parse(text);
      token = j.access_token ?? j.accessToken ?? j.token ?? (typeof j === 'string' ? j : undefined);
      if (j.expires_in) ttlSec = Number(j.expires_in);
    } catch {
      token = text.trim().replace(/^"|"$/g, ''); // some responses are a bare string
    }
    if (!token) throw new Error('RaceResult returned no token');
    // refresh a minute early so a poll never races the expiry
    this.expiresAt = Date.now() + Math.max(60, ttlSec - 60) * 1000;
    this.token = token;
    return token;
  }

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.requestToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Force the next call to fetch a new token (used after a 401). */
  invalidateToken(): void {
    this.expiresAt = 0;
    this.token = null;
  }

  async listDevices(): Promise<DecoderRecord[]> {
    const call = async (token: string) =>
      this.fetchFn(`${BASE}/customers/${this.cfg.customerId}/devices`, {
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' },
      });

    let res = await call(await this.getToken());
    if (res.status === 401) {
      // the token went stale early; one retry with a fresh one
      this.invalidateToken();
      res = await call(await this.getToken());
    }
    if (!res.ok) throw new Error(`RaceResult device list failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { Devices?: unknown[] };
    if (!Array.isArray(body?.Devices)) throw new Error('RaceResult returned no device list');
    const seenMs = Date.now();
    return body.Devices.map((d) => normalizeDevice(d as Raw, seenMs)).filter(
      (d): d is DecoderRecord => d !== null,
    );
  }
}

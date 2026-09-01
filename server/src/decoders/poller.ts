import { RaceResultClient, type DecoderRecord, type RaceResultConfig } from './raceresult.js';
import type { Store } from '../state/store.js';

const SETTING_KEY = 'raceresult';
const DEFAULT_INTERVAL_S = 60;
/** RaceResult answers 406 when tokens are asked for too often. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface DecoderPollStatus {
  configured: boolean;
  enabled: boolean;
  customerId?: number;
  intervalS: number;
  lastPollMs?: number;
  lastError?: string;
  deviceCount: number;
}

/**
 * Keeps the decoder list current.
 *
 * Polls on a timer, writes what it finds, and tells the console. Deliberately
 * forgiving: a failed poll leaves the last known state in place and reports the
 * error rather than blanking the map — a decoder you cannot reach right now is
 * still where it was, and that is usually what you want to see.
 */
export class DecoderPoller {
  private timer: NodeJS.Timeout | null = null;
  private client: RaceResultClient | null = null;
  private cfg: RaceResultConfig | null = null;
  private lastPollMs?: number;
  private lastError?: string;
  private backoffUntil = 0;

  constructor(
    private store: Store,
    private onUpdate: (decoders: DecoderRecord[]) => void,
  ) {}

  /** Read the saved settings and (re)start. Called at boot and after an edit. */
  start(): void {
    this.stop();
    this.cfg = this.readConfig();
    if (!this.cfg || !this.cfg.enabled) return;
    this.client = new RaceResultClient(this.cfg);
    const ms = Math.max(15, this.cfg.intervalS) * 1000;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), ms);
    this.timer.unref?.();
    console.log(`[decoders] polling RaceResult customer ${this.cfg.customerId} every ${this.cfg.intervalS}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client = null;
  }

  readConfig(): RaceResultConfig | null {
    const raw = this.store.getSetting(SETTING_KEY);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as Partial<RaceResultConfig>;
      if (!j.apiKey || !j.customerId) return null;
      return {
        apiKey: String(j.apiKey),
        customerId: Number(j.customerId),
        intervalS: Number(j.intervalS) > 0 ? Number(j.intervalS) : DEFAULT_INTERVAL_S,
        enabled: j.enabled !== false,
      };
    } catch {
      return null;
    }
  }

  /** Save settings. The key is only replaced when a new one is supplied. */
  saveConfig(next: { customerId: number; apiKey?: string; intervalS?: number; enabled?: boolean }): void {
    const current = this.readConfig();
    const apiKey = next.apiKey?.trim() || current?.apiKey;
    if (!apiKey) throw new Error('An API key is needed the first time');
    this.store.setSetting(
      SETTING_KEY,
      JSON.stringify({
        apiKey,
        customerId: Number(next.customerId),
        intervalS: Number(next.intervalS) > 0 ? Number(next.intervalS) : DEFAULT_INTERVAL_S,
        enabled: next.enabled !== false,
      }),
    );
    this.start();
  }

  clearConfig(): void {
    this.store.deleteSetting(SETTING_KEY);
    this.stop();
    this.lastError = undefined;
    this.lastPollMs = undefined;
  }

  async pollOnce(): Promise<void> {
    if (!this.client) return;
    if (Date.now() < this.backoffUntil) return;
    try {
      const devices = await this.client.listDevices();
      this.store.upsertDecoders(devices);
      this.store.deleteDecodersExcept(devices.map((d) => d.deviceId));
      this.lastPollMs = Date.now();
      this.lastError = undefined;
      this.onUpdate(this.store.listDecoders());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      // A token limit is not a transient blip — wait it out rather than
      // hammering the endpoint and making it worse.
      if (msg.includes('406')) {
        this.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        this.client.invalidateToken();
      }
      console.error(`[decoders] poll failed: ${msg}`);
    }
  }

  /** Try the credentials without saving or storing anything. */
  async test(cfg: { apiKey?: string; customerId: number }): Promise<{ devices: number }> {
    const apiKey = cfg.apiKey?.trim() || this.readConfig()?.apiKey;
    if (!apiKey) throw new Error('An API key is needed to test');
    const client = new RaceResultClient({ apiKey, customerId: Number(cfg.customerId) });
    return { devices: (await client.listDevices()).length };
  }

  status(): DecoderPollStatus {
    const cfg = this.readConfig();
    return {
      configured: !!cfg,
      enabled: !!cfg?.enabled,
      customerId: cfg?.customerId,
      intervalS: cfg?.intervalS ?? DEFAULT_INTERVAL_S,
      lastPollMs: this.lastPollMs,
      lastError: this.lastError,
      deviceCount: this.store.listDecoders().length,
    };
  }
}

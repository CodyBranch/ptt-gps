import ngrok from '@ngrok/ngrok';
import type { Store } from '../state/store.js';

/**
 * Remote access via ngrok: exposes the console (HTTP API + UI + socket.io) on
 * a public HTTPS URL — a reserved ngrok domain when configured. The tunnel
 * carries only the web console; trackers keep connecting to the box's static
 * IP over raw TCP.
 *
 * Settings live in SQLite and are managed from Setup. The authtoken can also
 * come from the NGROK_AUTHTOKEN env var, which takes precedence and keeps the
 * secret out of the DB entirely.
 */

export type TunnelState = 'off' | 'connecting' | 'online' | 'error';

export interface TunnelStatus {
  state: TunnelState;
  url?: string;
  error?: string;
  enabled: boolean;
  domain: string;
  hasToken: boolean;
  tokenFromEnv: boolean;
  /** Failed connects since the last good one, so a page can say it is trying. */
  attempts: number;
  /** When the next attempt is due, if one is pending. */
  retryAtMs?: number;
}

const K_ENABLED = 'ngrok-enabled';
const K_DOMAIN = 'ngrok-domain';
const K_TOKEN = 'ngrok-authtoken';

/** 5s, 10s, 20s ... up to five minutes, then every five minutes. */
const RETRY_MS = (attempt: number): number => Math.min(5 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 6));
/** How long a dropped session is given to come back on its own. */
const CLOSED_GRACE_MS = 120_000;

export class TunnelManager {
  private listener?: Awaited<ReturnType<typeof ngrok.forward>>;
  private state: TunnelState = 'off';
  private url?: string;
  private lastError?: string;
  private generation = 0; // guards against overlapping apply() calls
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryAtMs?: number;
  private closedSince?: number;
  private closedTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private store: Store,
    private port: number,
    /** Injected so the retry can be tested without reaching the internet. */
    private forward: typeof ngrok.forward = ngrok.forward,
  ) {}

  private token(): string | undefined {
    return process.env.NGROK_AUTHTOKEN || this.store.getSetting(K_TOKEN) || undefined;
  }

  status(): TunnelStatus {
    return {
      state: this.state,
      url: this.url,
      error: this.lastError,
      enabled: this.store.getSetting(K_ENABLED) === '1',
      domain: this.store.getSetting(K_DOMAIN) ?? '',
      hasToken: this.token() !== undefined,
      tokenFromEnv: !!process.env.NGROK_AUTHTOKEN,
      attempts: this.attempts,
      retryAtMs: this.retryAtMs,
    };
  }

  /** Persist settings and bring the tunnel to the desired state. */
  async apply(opts: { enabled?: boolean; domain?: string; authtoken?: string }): Promise<TunnelStatus> {
    if (opts.domain !== undefined) {
      const domain = opts.domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (domain === '') this.store.deleteSetting(K_DOMAIN);
      else this.store.setSetting(K_DOMAIN, domain);
    }
    if (opts.authtoken !== undefined && opts.authtoken !== '') {
      this.store.setSetting(K_TOKEN, opts.authtoken.trim());
    }
    if (opts.enabled !== undefined) {
      this.store.setSetting(K_ENABLED, opts.enabled ? '1' : '0');
    }

    if (this.store.getSetting(K_ENABLED) === '1') await this.start();
    else await this.stop();
    return this.status();
  }

  /**
   * Bring the tunnel up, and keep trying until it is.
   *
   * This used to be one attempt. A blip while the service was starting - the
   * box coming back before its network does is the ordinary case - left remote
   * access off until somebody noticed days later and toggled Setup, because
   * nothing else ever called this. A tunnel that is meant to be on should be
   * trying.
   */
  async start(): Promise<void> {
    const gen = ++this.generation;
    this.clearTimers();
    await this.closeListener();
    const authtoken = this.token();
    if (!authtoken) {
      this.state = 'error';
      this.lastError = 'No ngrok authtoken configured (Setup, or NGROK_AUTHTOKEN env var)';
      return;
    }
    this.state = 'connecting';
    this.url = undefined;
    this.lastError = undefined;
    this.retryAtMs = undefined;
    try {
      const domain = this.store.getSetting(K_DOMAIN);
      const listener = await this.forward({
        addr: this.port,
        authtoken,
        ...(domain ? { domain } : {}),
        // 'closed' when the session drops, 'connected' when the library gets
        // it back. Without this the state said "online" for as long as the
        // process lived, whatever had happened to the session underneath.
        onStatusChange: (status: string) => this.onStatus(gen, status),
      });
      if (gen !== this.generation) {
        // a newer apply() superseded this connect attempt
        await listener.close().catch(() => {});
        return;
      }
      this.listener = listener;
      this.url = listener.url() ?? undefined;
      this.state = 'online';
      this.attempts = 0;
      console.log(`[tunnel] console reachable at ${this.url}`);
    } catch (err) {
      if (gen !== this.generation) return;
      this.state = 'error';
      this.lastError = (err as Error).message;
      this.attempts++;
      const wait = RETRY_MS(this.attempts);
      console.error(`[tunnel] connect failed (attempt ${this.attempts}): ${this.lastError} - retrying in ${Math.round(wait / 1000)}s`);
      this.scheduleRetry(gen, wait);
    }
  }

  /**
   * What the ngrok library says about the session it is holding.
   *
   * It reconnects on its own, so a drop is reported rather than acted on. If
   * it has not come back inside the grace period we stop believing it will and
   * build a new listener from scratch.
   */
  private onStatus(gen: number, status: string): void {
    if (gen !== this.generation) return;
    if (status === 'connected') {
      this.closedSince = undefined;
      if (this.closedTimer) clearTimeout(this.closedTimer);
      this.closedTimer = undefined;
      this.state = 'online';
      this.lastError = undefined;
      return;
    }
    if (status !== 'closed') return;
    this.state = 'connecting';
    this.lastError = 'Connection to ngrok lost — reconnecting';
    this.closedSince = Date.now();
    if (this.closedTimer) clearTimeout(this.closedTimer);
    this.closedTimer = setTimeout(() => {
      if (gen !== this.generation || this.closedSince === undefined) return;
      console.error('[tunnel] session has stayed down — rebuilding the listener');
      void this.start();
    }, CLOSED_GRACE_MS);
    this.closedTimer.unref?.();
  }

  private scheduleRetry(gen: number, waitMs: number): void {
    this.retryAtMs = Date.now() + waitMs;
    this.retryTimer = setTimeout(() => {
      // Still wanted? A disable between the failure and the retry wins.
      if (gen !== this.generation || this.store.getSetting(K_ENABLED) !== '1') return;
      void this.start();
    }, waitMs);
    // A pending retry must never be the reason the process will not exit.
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.generation++;
    this.clearTimers();
    await this.closeListener();
    this.state = 'off';
    this.url = undefined;
    this.lastError = undefined;
    this.attempts = 0;
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.closedTimer) clearTimeout(this.closedTimer);
    this.retryTimer = undefined;
    this.closedTimer = undefined;
    this.retryAtMs = undefined;
    this.closedSince = undefined;
  }

  private async closeListener(): Promise<void> {
    if (this.listener) {
      await this.listener.close().catch(() => {});
      this.listener = undefined;
    }
  }
}

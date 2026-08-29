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
}

const K_ENABLED = 'ngrok-enabled';
const K_DOMAIN = 'ngrok-domain';
const K_TOKEN = 'ngrok-authtoken';

export class TunnelManager {
  private listener?: Awaited<ReturnType<typeof ngrok.forward>>;
  private state: TunnelState = 'off';
  private url?: string;
  private lastError?: string;
  private generation = 0; // guards against overlapping apply() calls

  constructor(
    private store: Store,
    private port: number,
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

  async start(): Promise<void> {
    const gen = ++this.generation;
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
    try {
      const domain = this.store.getSetting(K_DOMAIN);
      const listener = await ngrok.forward({
        addr: this.port,
        authtoken,
        ...(domain ? { domain } : {}),
      });
      if (gen !== this.generation) {
        // a newer apply() superseded this connect attempt
        await listener.close().catch(() => {});
        return;
      }
      this.listener = listener;
      this.url = listener.url() ?? undefined;
      this.state = 'online';
      console.log(`[tunnel] console reachable at ${this.url}`);
    } catch (err) {
      if (gen !== this.generation) return;
      this.state = 'error';
      this.lastError = (err as Error).message;
      console.error('[tunnel] connect failed:', this.lastError);
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    await this.closeListener();
    this.state = 'off';
    this.url = undefined;
    this.lastError = undefined;
  }

  private async closeListener(): Promise<void> {
    if (this.listener) {
      await this.listener.close().catch(() => {});
      this.listener = undefined;
    }
  }
}

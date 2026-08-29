import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import type { Store } from '../state/store.js';

/**
 * FirebaseHub: one place that owns Firebase admin apps, keyed by the
 * server-wide connection registry (Setup → Firebase connections).
 *
 * - Service-account JSONs are uploaded through the API and stored under
 *   data/credentials/ (git-ignored); the DB keeps only metadata.
 * - Publishers, the connection tester, and the open data browser all share
 *   the same cached apps.
 */
export class FirebaseHub {
  private apps = new Map<string, admin.app.App>();
  readonly credentialsDir: string;

  constructor(private store: Store, dataDir: string) {
    this.credentialsDir = path.join(dataDir, 'credentials');
  }

  /** Validate + store a service-account credential and register the connection. */
  saveConnection(name: string, databaseURL: string, serviceAccount: Record<string, unknown>): void {
    const slug = name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) throw new Error('Connection name is required');
    if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(databaseURL)) {
      throw new Error('Database URL must look like https://<project>.firebaseio.com or *.firebasedatabase.app');
    }
    for (const k of ['project_id', 'private_key', 'client_email']) {
      if (typeof serviceAccount[k] !== 'string' || !serviceAccount[k]) {
        throw new Error(`Service account JSON is missing "${k}" — upload the file from Firebase console → Project settings → Service accounts`);
      }
    }
    fs.mkdirSync(this.credentialsDir, { recursive: true });
    const credFile = path.join(this.credentialsDir, `${slug}.json`);
    fs.writeFileSync(credFile, JSON.stringify(serviceAccount, null, 2));
    this.store.upsertFirebaseConnection({
      name: slug,
      databaseURL: databaseURL.replace(/\/$/, ''),
      projectId: serviceAccount.project_id as string,
      credFile,
    });
    this.evict(slug); // re-init with the fresh credential on next use
  }

  deleteConnection(name: string): void {
    const conn = this.store.getFirebaseConnection(name);
    if (!this.store.deleteFirebaseConnection(name)) throw new Error(`Unknown connection: ${name}`);
    this.evict(name);
    if (conn && fs.existsSync(conn.cred_file)) fs.unlinkSync(conn.cred_file);
  }

  list(): Array<{ name: string; databaseURL: string; projectId: string | null; createdMs: number }> {
    return this.store.listFirebaseConnections().map((c) => ({
      name: c.name,
      databaseURL: c.database_url,
      projectId: c.project_id,
      createdMs: c.created_ms,
    }));
  }

  /** The admin database for a registered connection (cached). */
  database(name: string): admin.database.Database {
    return this.app(name).database();
  }

  private app(name: string): admin.app.App {
    const cached = this.apps.get(name);
    if (cached) return cached;
    const conn = this.store.getFirebaseConnection(name);
    if (!conn) throw new Error(`Unknown Firebase connection: ${name}`);
    if (!fs.existsSync(conn.cred_file)) throw new Error(`Credential file missing for "${name}" — re-upload it`);
    const appName = `fbconn-${name}`;
    const existing = admin.apps.find((a) => a?.name === appName);
    const app =
      existing ??
      admin.initializeApp(
        {
          credential: admin.credential.cert(JSON.parse(fs.readFileSync(conn.cred_file, 'utf8'))),
          databaseURL: conn.database_url,
        },
        appName,
      );
    this.apps.set(name, app);
    return app;
  }

  private evict(name: string): void {
    const app = this.apps.get(name);
    this.apps.delete(name);
    app?.delete().catch(() => {});
  }

  /** Round-trip test: read .info/serverTimeOffset with a hard timeout. */
  async test(name: string, timeoutMs = 8000): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    try {
      const db = this.database(name);
      const started = Date.now();
      const result = await Promise.race([
        db.ref('.info/serverTimeOffset').once('value').then(() => ({ ok: true as const })),
        new Promise<{ ok: false; error: string }>((resolve) =>
          setTimeout(() => resolve({ ok: false, error: `No response in ${timeoutMs / 1000}s (check URL, credentials, and rules)` }), timeoutMs),
        ),
      ]);
      if (!result.ok) {
        this.evict(name); // drop the possibly-wedged app so the next test starts clean
        return result;
      }
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Open pull: read any path once. */
  async read(name: string, refPath: string, timeoutMs = 8000): Promise<unknown> {
    const db = this.database(name);
    const snap = await Promise.race([
      db.ref(normalizePath(refPath)).once('value'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Read timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    return snap.val();
  }

  /** Open push: set/update/delete any path. */
  async write(
    name: string,
    refPath: string,
    value: unknown,
    method: 'set' | 'update' | 'delete',
    timeoutMs = 8000,
  ): Promise<void> {
    const ref = this.database(name).ref(normalizePath(refPath));
    const op =
      method === 'delete' ? ref.remove()
      : method === 'update' ? ref.update(value as object)
      : ref.set(value);
    await Promise.race([
      op,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Write timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
  }
}

function normalizePath(p: string): string {
  const clean = (p ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (clean === '') throw new Error('Path is required (e.g. 9999/Meta/Clock)');
  return clean;
}

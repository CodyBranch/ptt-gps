import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Fix, Telemetry } from '../ingest/types.js';

/**
 * SQLite store: device registry + full fix history + race sessions.
 * Replaces the legacy CouchDB `devices` db and the flat per-IMEI log files.
 * Every fix is stored regardless of session — sessions mark which slice of the
 * stream belongs to which race, so a session can be back-dated to recover a
 * missed start.
 */
export class Store {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        imei TEXT PRIMARY KEY,
        label TEXT,
        last_lat REAL, last_lon REAL, last_alt_m REAL,
        last_t_utc_ms INTEGER, last_received_ms INTEGER,
        battery REAL, accuracy REAL, protocol TEXT, source TEXT
      );
      CREATE TABLE IF NOT EXISTS fixes (
        id INTEGER PRIMARY KEY,
        imei TEXT NOT NULL,
        t_utc_ms INTEGER NOT NULL,
        received_ms INTEGER NOT NULL,
        lat REAL, lon REAL, alt_m REAL,
        speed_kmh REAL, azimuth REAL, accuracy REAL, hdop REAL, sats INTEGER,
        battery REAL,
        fix_valid INTEGER NOT NULL,
        buffered INTEGER NOT NULL,
        accepted INTEGER NOT NULL,
        reject_reason TEXT,
        count_number INTEGER,
        source TEXT, protocol TEXT,
        raw TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fixes_imei_t ON fixes(imei, t_utc_ms);
      CREATE INDEX IF NOT EXISTS idx_fixes_received ON fixes(received_ms);
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY,
        imei TEXT, type TEXT NOT NULL, t_utc_ms INTEGER, received_ms INTEGER,
        detail TEXT, source TEXT, raw TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        race_id TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        config_snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        t_ms INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publishes (
        id INTEGER PRIMARY KEY,
        session_id INTEGER,
        t_ms INTEGER NOT NULL,
        target TEXT NOT NULL,
        path TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS firebase_connections (
        name TEXT PRIMARY KEY,
        database_url TEXT NOT NULL,
        project_id TEXT,
        cred_file TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fleet (
        imei TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        model TEXT,
        has_battery INTEGER NOT NULL DEFAULT 1,
        notes TEXT,
        retired INTEGER NOT NULL DEFAULT 0,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);
    // additive migration: role column for viewer-PIN tokens
    const cols = this.db.prepare(`PRAGMA table_info(auth_tokens)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'role')) {
      this.db.exec(`ALTER TABLE auth_tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'operator'`);
    }
  }

  private stmts = {
    insertFix: this.lazyStmt(`
      INSERT INTO fixes (imei, t_utc_ms, received_ms, lat, lon, alt_m, speed_kmh, azimuth,
        accuracy, hdop, sats, battery, fix_valid, buffered, accepted, reject_reason,
        count_number, source, protocol, raw)
      VALUES (@imei, @tUtcMs, @receivedAtMs, @lat, @lon, @altM, @speedKmh, @azimuth,
        @accuracy, @hdop, @sats, @battery, @fixValid, @buffered, @accepted, @rejectReason,
        @countNumber, @source, @protocol, @raw)`),
    upsertDevice: this.lazyStmt(`
      INSERT INTO devices (imei, last_lat, last_lon, last_alt_m, last_t_utc_ms,
        last_received_ms, battery, accuracy, protocol, source)
      VALUES (@imei, @lat, @lon, @altM, @tUtcMs, @receivedAtMs, @battery, @accuracy, @protocol, @source)
      ON CONFLICT(imei) DO UPDATE SET
        last_lat=@lat, last_lon=@lon, last_alt_m=@altM, last_t_utc_ms=@tUtcMs,
        last_received_ms=@receivedAtMs, battery=@battery, accuracy=@accuracy,
        protocol=@protocol, source=@source`),
    insertTelemetry: this.lazyStmt(`
      INSERT INTO telemetry (imei, type, t_utc_ms, received_ms, detail, source, raw)
      VALUES (@imei, @type, @tUtcMs, @receivedMs, @detail, @source, @raw)`),
  };

  private lazyStmt(sql: string) {
    let stmt: Database.Statement | undefined;
    return () => (stmt ??= this.db.prepare(sql));
  }

  recordFix(fix: Fix, accepted: boolean, rejectReason?: string): void {
    this.stmts.insertFix().run({
      ...fix,
      altM: fix.altM ?? null,
      speedKmh: fix.speedKmh ?? null,
      azimuth: fix.azimuth ?? null,
      accuracy: fix.accuracy ?? null,
      hdop: fix.hdop ?? null,
      sats: fix.sats ?? null,
      battery: fix.battery ?? null,
      countNumber: fix.countNumber ?? null,
      fixValid: fix.fixValid ? 1 : 0,
      buffered: fix.buffered ? 1 : 0,
      accepted: accepted ? 1 : 0,
      rejectReason: rejectReason ?? null,
    });
    if (accepted) {
      this.stmts.upsertDevice().run({
        imei: fix.imei,
        lat: fix.lat,
        lon: fix.lon,
        altM: fix.altM ?? null,
        tUtcMs: fix.tUtcMs,
        receivedAtMs: fix.receivedAtMs,
        battery: fix.battery ?? null,
        accuracy: fix.accuracy ?? null,
        protocol: fix.protocol,
        source: fix.source,
      });
    }
  }

  recordTelemetry(t: Telemetry): void {
    this.stmts.insertTelemetry().run({
      imei: t.imei ?? null,
      type: t.type,
      tUtcMs: t.tUtcMs ?? null,
      receivedMs: Date.now(),
      detail: t.detail ? JSON.stringify(t.detail) : null,
      source: t.source,
      raw: t.raw,
    });
  }

  startSession(eventId: string, raceId: string, configSnapshot: unknown, startedAtMs = Date.now()): number {
    const res = this.db
      .prepare(`INSERT INTO sessions (event_id, race_id, started_at_ms, config_snapshot) VALUES (?, ?, ?, ?)`)
      .run(eventId, raceId, startedAtMs, JSON.stringify(configSnapshot));
    return Number(res.lastInsertRowid);
  }

  endSession(sessionId: number, endedAtMs = Date.now()): void {
    this.db.prepare(`UPDATE sessions SET ended_at_ms = ? WHERE id = ?`).run(endedAtMs, sessionId);
  }

  addSessionEvent(sessionId: number, type: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO session_events (session_id, t_ms, type, payload) VALUES (?, ?, ?, ?)`)
      .run(sessionId, Date.now(), type, JSON.stringify(payload));
  }

  recordPublish(sessionId: number | null, target: string, pubPath: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO publishes (session_id, t_ms, target, path, value) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, Date.now(), target, pubPath, JSON.stringify(value));
  }

  /** All fixes in a time range, GPS-time ordered — the replay feed. */
  fixesBetween(startMs: number, endMs: number, imeis?: string[]): unknown[] {
    const base = `SELECT * FROM fixes WHERE t_utc_ms BETWEEN ? AND ?`;
    if (imeis && imeis.length > 0) {
      const q = `${base} AND imei IN (${imeis.map(() => '?').join(',')}) ORDER BY t_utc_ms`;
      return this.db.prepare(q).all(startMs, endMs, ...imeis);
    }
    return this.db.prepare(`${base} ORDER BY t_utc_ms`).all(startMs, endMs);
  }

  devices(): unknown[] {
    return this.db.prepare(`SELECT * FROM devices ORDER BY imei`).all();
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  // --- firebase connections registry ---

  upsertFirebaseConnection(c: { name: string; databaseURL: string; projectId?: string; credFile: string }): void {
    this.db
      .prepare(`INSERT INTO firebase_connections (name, database_url, project_id, cred_file, created_ms)
                VALUES (@name, @databaseURL, @projectId, @credFile, @now)
                ON CONFLICT(name) DO UPDATE SET
                  database_url=@databaseURL, project_id=@projectId, cred_file=@credFile`)
      .run({ name: c.name, databaseURL: c.databaseURL, projectId: c.projectId ?? null, credFile: c.credFile, now: Date.now() });
  }

  listFirebaseConnections(): Array<{ name: string; database_url: string; project_id: string | null; cred_file: string; created_ms: number }> {
    return this.db.prepare(`SELECT * FROM firebase_connections ORDER BY name`).all() as Array<{
      name: string; database_url: string; project_id: string | null; cred_file: string; created_ms: number;
    }>;
  }

  getFirebaseConnection(name: string): { name: string; database_url: string; cred_file: string } | undefined {
    return this.db.prepare(`SELECT name, database_url, cred_file FROM firebase_connections WHERE name = ?`).get(name) as
      | { name: string; database_url: string; cred_file: string }
      | undefined;
  }

  deleteFirebaseConnection(name: string): boolean {
    return this.db.prepare(`DELETE FROM firebase_connections WHERE name = ?`).run(name).changes > 0;
  }

  // --- fleet registry (curated tracker inventory, event-independent) ---

  upsertFleet(t: { imei: string; label: string; model?: string; hasBattery: boolean; notes?: string; retired: boolean }): void {
    this.db
      .prepare(`INSERT INTO fleet (imei, label, model, has_battery, notes, retired, updated_ms)
                VALUES (@imei, @label, @model, @hasBattery, @notes, @retired, @now)
                ON CONFLICT(imei) DO UPDATE SET
                  label=@label, model=@model, has_battery=@hasBattery, notes=@notes,
                  retired=@retired, updated_ms=@now`)
      .run({
        imei: t.imei,
        label: t.label,
        model: t.model ?? null,
        hasBattery: t.hasBattery ? 1 : 0,
        notes: t.notes ?? null,
        retired: t.retired ? 1 : 0,
        now: Date.now(),
      });
  }

  /** Fleet joined with live observations (last position/battery from the wire). */
  listFleet(): unknown[] {
    return this.db
      .prepare(`SELECT f.imei, f.label, f.model, f.has_battery AS hasBattery, f.notes, f.retired,
                       d.battery AS seen_battery, d.last_received_ms, d.last_t_utc_ms, d.protocol
                FROM fleet f LEFT JOIN devices d ON d.imei = f.imei
                ORDER BY f.retired, f.label`)
      .all();
  }

  deleteFleet(imei: string): boolean {
    return this.db.prepare(`DELETE FROM fleet WHERE imei = ?`).run(imei).changes > 0;
  }

  // --- auth ---

  addUser(username: string, passwordHash: string): void {
    this.db
      .prepare(`INSERT INTO users (username, password_hash, created_at_ms) VALUES (?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`)
      .run(username, passwordHash, Date.now());
  }

  deleteUser(username: string): boolean {
    this.db.prepare(`DELETE FROM auth_tokens WHERE username = ?`).run(username);
    return this.db.prepare(`DELETE FROM users WHERE username = ?`).run(username).changes > 0;
  }

  getUser(username: string): { username: string; password_hash: string } | undefined {
    return this.db.prepare(`SELECT username, password_hash FROM users WHERE username = ?`).get(username) as
      | { username: string; password_hash: string }
      | undefined;
  }

  listUsers(): Array<{ username: string; created_at_ms: number }> {
    return this.db.prepare(`SELECT username, created_at_ms FROM users ORDER BY username`).all() as Array<{
      username: string;
      created_at_ms: number;
    }>;
  }

  insertToken(tokenHash: string, username: string, expiresAtMs: number, role = 'operator'): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE expires_at_ms < ?`).run(Date.now());
    this.db
      .prepare(`INSERT INTO auth_tokens (token_hash, username, created_at_ms, expires_at_ms, role) VALUES (?, ?, ?, ?, ?)`)
      .run(tokenHash, username, Date.now(), expiresAtMs, role);
  }

  getToken(tokenHash: string): { username: string; expires_at_ms: number; role: string } | undefined {
    return this.db
      .prepare(`SELECT username, expires_at_ms, role FROM auth_tokens WHERE token_hash = ?`)
      .get(tokenHash) as { username: string; expires_at_ms: number; role: string } | undefined;
  }

  deleteTokensByRole(role: string): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE role = ?`).run(role);
  }

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  touchToken(tokenHash: string, expiresAtMs: number): void {
    this.db.prepare(`UPDATE auth_tokens SET expires_at_ms = ? WHERE token_hash = ?`).run(expiresAtMs, tokenHash);
  }

  deleteToken(tokenHash: string): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE token_hash = ?`).run(tokenHash);
  }

  close(): void {
    this.db.close();
  }
}

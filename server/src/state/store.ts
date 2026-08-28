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
    `);
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

  close(): void {
    this.db.close();
  }
}

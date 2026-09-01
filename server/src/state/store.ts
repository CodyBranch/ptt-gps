import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Fix, Telemetry } from '../ingest/types.js';

export interface CourseMarker {
  /** Distance along the course, in this marker's own units. */
  at: number;
  /** Defaults to the course's markerUnits — set per marker so one course can
   *  carry mile posts and kilometre posts at the same time. */
  units?: 'miles' | 'kilometers';
  label: string;
  /** 'post' = a distance post (renders like a generated one), 'timing' = a
   *  timing point/mat, 'point' = anything else (aid station, turnaround). */
  kind?: 'point' | 'post' | 'timing';
}

export interface CourseMeta {
  file: string;
  label: string | null;
  notes: string | null;
  archived: number;
  created_ms: number;
  created_by: string | null;
  /** Generate start/finish + a post every whole unit. */
  auto_markers: number;
  /** Unit the posts are measured and labelled in — a physical property of the
   *  course (US road races have painted mile posts), not of any one race. */
  marker_units: 'miles' | 'kilometers';
  /** JSON array of CourseMarker. */
  markers: string | null;
}

/**
 * SQLite store: device registry + full fix history + race sessions.
 * Replaces the legacy CouchDB `devices` db and the flat per-IMEI log files.
 * Every fix is stored regardless of session — sessions mark which slice of the
 * stream belongs to which race, so a session can be back-dated to recover a
 * missed start.
 */
import type { DecoderRecord } from '../decoders/raceresult.js';

/** One frame as it came off a port, plus the id the history pages on. */
export interface WireFrameRow {
  id?: number;
  tMs: number;
  source: string;
  ip: string;
  binary: boolean;
  bytes: number;
  imei?: string;
  text: string;
}

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
    // additive migration: permission level on users. Pre-existing accounts
    // become admins (they had full access before levels existed).
    const userCols = this.db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>;
    if (!userCols.some((c) => c.name === 'role')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
    }
    // additive migration: device owner on the fleet registry
    const fleetCols = this.db.prepare(`PRAGMA table_info(fleet)`).all() as Array<{ name: string }>;
    if (!fleetCols.some((c) => c.name === 'owner')) {
      this.db.exec(`ALTER TABLE fleet ADD COLUMN owner TEXT`);
    }
    // Device history: every event-roster assignment change, and an issue log
    // (broken antennas, flaky batteries) with open/resolved state.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_assignments (
        id INTEGER PRIMARY KEY,
        imei TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_name TEXT,
        action TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assign_imei ON device_assignments(imei, t_ms);
      CREATE TABLE IF NOT EXISTS device_issues (
        id INTEGER PRIMARY KEY,
        imei TEXT NOT NULL,
        t_ms INTEGER NOT NULL,
        by TEXT,
        severity TEXT NOT NULL DEFAULT 'issue',
        text TEXT NOT NULL,
        resolved_ms INTEGER,
        resolved_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_issues_imei ON device_issues(imei, t_ms);
    `);
    // Owners are a table (case-insensitive unique) so "PTT" / "Ptt" /
    // "PrimeTime" can't drift apart; fleet links by owner_id.
    // Raw wire frames, exactly as they arrived. Kept because the question
    // "did that device send anything at 9:42?" is usually asked afterwards,
    // and a live-only view has already thrown the answer away. Bounded by
    // count and age — this is a debugging aid, not an archive.
    this.db.exec(`CREATE TABLE IF NOT EXISTS wire_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      ip TEXT NOT NULL,
      binary INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      imei TEXT,
      text TEXT NOT NULL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wire_t ON wire_frames(t_ms)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wire_imei ON wire_frames(imei, t_ms)`);

    // RaceResult timing boxes on the course — decoders, TrackBoxes, Ubidiums.
    // One row per device, overwritten each poll: this is "where is it and is it
    // up", not a history. The raw payload is kept for diagnosis.
    this.db.exec(`CREATE TABLE IF NOT EXISTS decoders (
      device_id TEXT PRIMARY KEY,
      name TEXT, type TEXT,
      connected INTEGER NOT NULL DEFAULT 0,
      lat REAL, lon REAL, battery REAL, temperature REAL,
      firmware TEXT, file_no TEXT, records_count INTEGER,
      has_power INTEGER, in_timing_mode INTEGER, time_running INTEGER,
      in_standby INTEGER, reader_healthy INTEGER, reader_temperature REAL,
      time_source TEXT, error_flags TEXT,
      device_time TEXT, request_time TEXT, received TEXT,
      seen_ms INTEGER NOT NULL,
      raw TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
    )`);
    const decoderCols = this.db.prepare(`PRAGMA table_info(decoders)`).all() as Array<{ name: string }>;
    if (!decoderCols.some((c) => c.name === 'hidden')) {
      this.db.exec(`ALTER TABLE decoders ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    }

    this.db.exec(`CREATE TABLE IF NOT EXISTS owners (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    )`);
    // Course metadata. The KML/GeoJSON on disk stays the source of truth for
    // geometry; this holds the librarian's notes — a course outlives the events
    // that use it, so where it came from and whether it is certified matters
    // years later.
    this.db.exec(`CREATE TABLE IF NOT EXISTS courses (
      file TEXT PRIMARY KEY,
      label TEXT,
      notes TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_ms INTEGER NOT NULL,
      created_by TEXT
    )`);
    const courseCols = this.db.prepare(`PRAGMA table_info(courses)`).all() as Array<{ name: string }>;
    if (!courseCols.some((c) => c.name === 'auto_markers')) {
      this.db.exec(`ALTER TABLE courses ADD COLUMN auto_markers INTEGER NOT NULL DEFAULT 1`);
      this.db.exec(`ALTER TABLE courses ADD COLUMN marker_units TEXT NOT NULL DEFAULT 'miles'`);
      this.db.exec(`ALTER TABLE courses ADD COLUMN markers TEXT`);
    }
    if (!fleetCols.some((c) => c.name === 'owner_id')) {
      this.db.exec(`ALTER TABLE fleet ADD COLUMN owner_id INTEGER`);
      // migrate any free-text owners that existed briefly
      const rows = this.db.prepare(`SELECT imei, owner FROM fleet WHERE owner IS NOT NULL AND owner != ''`).all() as Array<{ imei: string; owner: string }>;
      for (const r of rows) {
        const o = this.addOwner(r.owner);
        this.db.prepare(`UPDATE fleet SET owner_id = ? WHERE imei = ?`).run(o.id, r.imei);
      }
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

  /**
   * A device heard from without a position — no satellite lock yet. Keeps the
   * fleet's last-seen and battery current so a tracker waiting for a lock reads
   * as alive and charged rather than as never having reported.
   */
  noteDeviceHeard(imei: string, receivedAtMs: number, battery?: number, protocol?: string, source?: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (imei, last_received_ms, battery, protocol, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(imei) DO UPDATE SET
           last_received_ms = excluded.last_received_ms,
           battery = COALESCE(excluded.battery, devices.battery),
           protocol = COALESCE(excluded.protocol, devices.protocol),
           source = COALESCE(excluded.source, devices.source)`,
      )
      .run(imei, receivedAtMs, battery ?? null, protocol ?? null, source ?? null);
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
    // Anything that reaches us proves the device is alive and tells us its
    // battery, whether or not the fix survives the gate — a tracker repeating a
    // stale position is still on the air, and the fleet must show that rather
    // than reading as never heard from. Only an accepted fix moves its position.
    this.noteDeviceHeard(fix.imei, fix.receivedAtMs, fix.battery, fix.protocol, fix.source);
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

  /**
   * Races that were live when the process stopped. A crash or restart mid-race
   * leaves the session open; on the way back up we resume it rather than
   * stranding the race and its timeline.
   */
  openSessions(eventId: string): Array<{ id: number; race_id: string; started_at_ms: number }> {
    return this.db
      .prepare(`SELECT id, race_id, started_at_ms FROM sessions WHERE event_id = ? AND ended_at_ms IS NULL ORDER BY id`)
      .all(eventId) as Array<{ id: number; race_id: string; started_at_ms: number }>;
  }

  /**
   * Newest accepted GPS time per tracker. Seeds the hygiene gate after a
   * restart so a device flushing its backlog does not replay fixes the engine
   * has already consumed — only the ones from the gap get through.
   */
  lastAcceptedFixTimes(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT imei, MAX(t_utc_ms) AS t FROM fixes WHERE accepted = 1 GROUP BY imei`)
      .all() as Array<{ imei: string; t: number }>;
    return new Map(rows.map((r) => [r.imei, r.t]));
  }

  /** Accepted fixes for a race session, in GPS-time order — the recovery feed. */
  acceptedFixesSince(startMs: number, imeis: string[]): Array<Record<string, unknown>> {
    if (imeis.length === 0) return [];
    const q = `SELECT * FROM fixes WHERE accepted = 1 AND t_utc_ms >= ?
       AND imei IN (${imeis.map(() => '?').join(',')}) ORDER BY t_utc_ms`;
    return this.db.prepare(q).all(startMs, ...imeis) as Array<Record<string, unknown>>;
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

  // --- device history: event assignments + issue log ---

  recordAssignment(imei: string, eventId: string, eventName: string, action: 'added' | 'removed', by?: string): void {
    this.db
      .prepare(`INSERT INTO device_assignments (imei, event_id, event_name, action, t_ms, by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(imei, eventId, eventName, action, Date.now(), by ?? null);
  }

  listAssignments(imei: string, limit = 100): unknown[] {
    return this.db
      .prepare(`SELECT * FROM device_assignments WHERE imei = ? ORDER BY t_ms DESC LIMIT ?`)
      .all(imei, limit);
  }

  addIssue(imei: string, text: string, severity: string, by?: string): number {
    const clean = text.trim();
    if (!clean) throw new Error('Issue text is required');
    const sev = ['note', 'issue', 'fault'].includes(severity) ? severity : 'issue';
    const res = this.db
      .prepare(`INSERT INTO device_issues (imei, t_ms, by, severity, text) VALUES (?, ?, ?, ?, ?)`)
      .run(imei, Date.now(), by ?? null, sev, clean);
    return Number(res.lastInsertRowid);
  }

  resolveIssue(id: number, by?: string): void {
    const changes = this.db
      .prepare(`UPDATE device_issues SET resolved_ms = ?, resolved_by = ? WHERE id = ? AND resolved_ms IS NULL`)
      .run(Date.now(), by ?? null, id).changes;
    if (changes === 0) throw new Error('Issue not found or already resolved');
  }

  listIssues(imei: string, limit = 100): unknown[] {
    return this.db
      .prepare(`SELECT * FROM device_issues WHERE imei = ? ORDER BY resolved_ms IS NOT NULL, t_ms DESC LIMIT ?`)
      .all(imei, limit);
  }

  /** Open-issue counts for fleet badges, one query. */
  openIssueCounts(): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT imei, COUNT(*) c FROM device_issues WHERE resolved_ms IS NULL GROUP BY imei`)
      .all() as Array<{ imei: string; c: number }>;
    return new Map(rows.map((r) => [r.imei, r.c]));
  }

  // --- device owners (normalized) ---

  listOwners(): Array<{ id: number; name: string }> {
    return this.db.prepare(`SELECT id, name FROM owners ORDER BY name COLLATE NOCASE`).all() as Array<{ id: number; name: string }>;
  }

  /** Case-insensitive get-or-create, so near-duplicate spellings collapse. */
  addOwner(name: string): { id: number; name: string } {
    const clean = name.trim();
    if (!clean) throw new Error('Owner name is required');
    const existing = this.db.prepare(`SELECT id, name FROM owners WHERE name = ? COLLATE NOCASE`).get(clean) as
      | { id: number; name: string }
      | undefined;
    if (existing) return existing;
    const res = this.db.prepare(`INSERT INTO owners (name) VALUES (?)`).run(clean);
    return { id: Number(res.lastInsertRowid), name: clean };
  }

  deleteOwner(id: number): void {
    const inUse = (this.db.prepare(`SELECT COUNT(*) c FROM fleet WHERE owner_id = ?`).get(id) as { c: number }).c;
    if (inUse > 0) throw new Error(`Owner is linked to ${inUse} device(s) — unlink them first`);
    if (this.db.prepare(`DELETE FROM owners WHERE id = ?`).run(id).changes === 0) throw new Error('Unknown owner');
  }

  // --- course library metadata (geometry lives on disk) ---

  courseMeta(): Map<string, CourseMeta> {
    const rows = this.db.prepare(`SELECT * FROM courses`).all() as CourseMeta[];
    return new Map(rows.map((r) => [r.file, r]));
  }

  /** Markers belong to the course: the posts are painted on the road. */
  courseMarkers(file: string): { auto: boolean; units: 'miles' | 'kilometers'; markers: CourseMarker[] } {
    const row = this.db
      .prepare(`SELECT auto_markers, marker_units, markers FROM courses WHERE file = ?`)
      .get(file) as Pick<CourseMeta, 'auto_markers' | 'marker_units' | 'markers'> | undefined;
    let markers: CourseMarker[] = [];
    try {
      markers = row?.markers ? (JSON.parse(row.markers) as CourseMarker[]) : [];
    } catch {
      markers = [];
    }
    return {
      auto: row ? row.auto_markers === 1 : true,
      units: row?.marker_units === 'kilometers' ? 'kilometers' : 'miles',
      markers,
    };
  }

  setCourseMarkers(
    file: string,
    patch: { auto?: boolean; units?: 'miles' | 'kilometers'; markers?: CourseMarker[] },
  ): void {
    const MI_PER_KM = 0.621371;
    const inMiles = (m: CourseMarker) => (m.units === 'kilometers' ? m.at * MI_PER_KM : m.at);
    this.noteCourseSeen(file);
    if (patch.auto !== undefined) {
      this.db.prepare(`UPDATE courses SET auto_markers = ? WHERE file = ?`).run(patch.auto ? 1 : 0, file);
    }
    if (patch.units !== undefined) {
      this.db.prepare(`UPDATE courses SET marker_units = ? WHERE file = ?`).run(patch.units, file);
    }
    if (patch.markers !== undefined) {
      const clean = patch.markers
        .filter((m) => Number.isFinite(m.at) && m.at >= 0)
        .map((m) => ({
          at: Number(m.at),
          label: String(m.label ?? '').slice(0, 60),
          kind: m.kind === 'timing' ? ('timing' as const) : m.kind === 'post' ? ('post' as const) : ('point' as const),
          units: m.units === 'kilometers' ? ('kilometers' as const) : ('miles' as const),
        }))
        // mixed units: order by real distance, not by the raw number
        .sort((a, b) => inMiles(a) - inMiles(b));
      this.db.prepare(`UPDATE courses SET markers = ? WHERE file = ?`).run(JSON.stringify(clean), file);
    }
  }

  /** True once a course has had its markers configured (or explicitly cleared). */
  courseMarkersConfigured(file: string): boolean {
    const row = this.db.prepare(`SELECT markers FROM courses WHERE file = ?`).get(file) as
      | { markers: string | null }
      | undefined;
    return !!row && row.markers !== null;
  }

  /** First sighting of a course file records when it entered the library. */
  noteCourseSeen(file: string, by?: string): void {
    this.db
      .prepare(`INSERT INTO courses (file, created_ms, created_by) VALUES (?, ?, ?) ON CONFLICT(file) DO NOTHING`)
      .run(file, Date.now(), by ?? null);
  }

  updateCourseMeta(file: string, patch: { label?: string | null; notes?: string | null; archived?: boolean }): void {
    this.noteCourseSeen(file);
    if (patch.label !== undefined) this.db.prepare(`UPDATE courses SET label = ? WHERE file = ?`).run(patch.label || null, file);
    if (patch.notes !== undefined) this.db.prepare(`UPDATE courses SET notes = ? WHERE file = ?`).run(patch.notes || null, file);
    if (patch.archived !== undefined) {
      this.db.prepare(`UPDATE courses SET archived = ? WHERE file = ?`).run(patch.archived ? 1 : 0, file);
    }
  }

  renameCourseMeta(from: string, to: string): void {
    this.db.prepare(`UPDATE courses SET file = ? WHERE file = ?`).run(to, from);
  }

  deleteCourseMeta(file: string): void {
    this.db.prepare(`DELETE FROM courses WHERE file = ?`).run(file);
  }

  // --- fleet registry (curated tracker inventory, event-independent) ---

  upsertFleet(t: { imei: string; label: string; model?: string; hasBattery: boolean; notes?: string; ownerId?: number | null; retired: boolean }): void {
    this.db
      .prepare(`INSERT INTO fleet (imei, label, model, has_battery, notes, owner_id, retired, updated_ms)
                VALUES (@imei, @label, @model, @hasBattery, @notes, @ownerId, @retired, @now)
                ON CONFLICT(imei) DO UPDATE SET
                  label=@label, model=@model, has_battery=@hasBattery, notes=@notes,
                  owner_id=@ownerId, retired=@retired, updated_ms=@now`)
      .run({
        imei: t.imei,
        label: t.label,
        model: t.model ?? null,
        hasBattery: t.hasBattery ? 1 : 0,
        notes: t.notes ?? null,
        ownerId: t.ownerId ?? null,
        retired: t.retired ? 1 : 0,
        now: Date.now(),
      });
  }

  /**
   * Fleet joined with live observations — latest ping (time, battery, and
   * position for locate/validate) comes from the wire regardless of whether
   * the device is in any event.
   */
  listFleet(): unknown[] {
    return this.db
      .prepare(`SELECT f.imei, f.label, f.model, f.has_battery AS hasBattery, f.notes, f.retired,
                       f.owner_id AS ownerId, o.name AS owner,
                       d.battery AS seen_battery, d.last_received_ms, d.last_t_utc_ms, d.protocol,
                       d.last_lat, d.last_lon
                FROM fleet f
                LEFT JOIN owners o ON o.id = f.owner_id
                LEFT JOIN devices d ON d.imei = f.imei
                ORDER BY f.retired, f.label`)
      .all();
  }

  deleteFleet(imei: string): boolean {
    return this.db.prepare(`DELETE FROM fleet WHERE imei = ?`).run(imei).changes > 0;
  }

  // --- auth ---

  addUser(username: string, passwordHash: string, role: 'admin' | 'staff' = 'staff'): void {
    this.db
      .prepare(`INSERT INTO users (username, password_hash, created_at_ms, role) VALUES (?, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = excluded.role`)
      .run(username, passwordHash, Date.now(), role);
  }

  deleteUser(username: string): boolean {
    this.db.prepare(`DELETE FROM auth_tokens WHERE username = ?`).run(username);
    return this.db.prepare(`DELETE FROM users WHERE username = ?`).run(username).changes > 0;
  }

  getUser(username: string): { username: string; password_hash: string; role: string } | undefined {
    return this.db.prepare(`SELECT username, password_hash, role FROM users WHERE username = ?`).get(username) as
      | { username: string; password_hash: string; role: string }
      | undefined;
  }

  listUsers(): Array<{ username: string; created_at_ms: number; role: string }> {
    return this.db.prepare(`SELECT username, created_at_ms, role FROM users ORDER BY username`).all() as Array<{
      username: string;
      created_at_ms: number;
      role: string;
    }>;
  }

  countUsers(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM users`).get() as { c: number }).c;
  }

  countAdmins(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get() as { c: number }).c;
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

  /** Revoke a user's other sessions (password change keeps the current one). */
  deleteTokensForUserExcept(username: string, exceptTokenHash: string): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE username = ? AND token_hash != ?`).run(username, exceptTokenHash);
  }

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  listSettingsByPrefix(prefix: string): Array<{ key: string; value: string }> {
    return this.db
      .prepare(`SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'`)
      .all(prefix.replace(/[%_\\]/g, '\\$&') + '%') as Array<{ key: string; value: string }>;
  }

  touchToken(tokenHash: string, expiresAtMs: number): void {
    this.db.prepare(`UPDATE auth_tokens SET expires_at_ms = ? WHERE token_hash = ?`).run(expiresAtMs, tokenHash);
  }

  deleteToken(tokenHash: string): void {
    this.db.prepare(`DELETE FROM auth_tokens WHERE token_hash = ?`).run(tokenHash);
  }

  // --- decoders (RaceResult) ----------------------------------------------

  upsertDecoders(rows: DecoderRecord[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO decoders (device_id, name, type, connected, lat, lon, battery, temperature,
         firmware, file_no, records_count, has_power, in_timing_mode, time_running, in_standby,
         reader_healthy, reader_temperature, time_source, error_flags,
         device_time, request_time, received, seen_ms, raw)
       VALUES (@device_id, @name, @type, @connected, @lat, @lon, @battery, @temperature,
         @firmware, @file_no, @records_count, @has_power, @in_timing_mode, @time_running, @in_standby,
         @reader_healthy, @reader_temperature, @time_source, @error_flags,
         @device_time, @request_time, @received, @seen_ms, @raw)
       ON CONFLICT(device_id) DO UPDATE SET
         name=excluded.name, type=excluded.type, connected=excluded.connected,
         lat=excluded.lat, lon=excluded.lon, battery=excluded.battery, temperature=excluded.temperature,
         firmware=excluded.firmware, file_no=excluded.file_no, records_count=excluded.records_count,
         has_power=excluded.has_power, in_timing_mode=excluded.in_timing_mode,
         time_running=excluded.time_running, in_standby=excluded.in_standby,
         reader_healthy=excluded.reader_healthy, reader_temperature=excluded.reader_temperature,
         time_source=excluded.time_source, error_flags=excluded.error_flags,
         device_time=excluded.device_time, request_time=excluded.request_time,
         received=excluded.received, seen_ms=excluded.seen_ms, raw=excluded.raw`,
      // note: `hidden` is deliberately absent — it is our choice about a
      // device, not something RaceResult tells us, so a poll must not undo it.
    );
    const b = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);
    this.db.transaction((list: DecoderRecord[]) => {
      for (const d of list) {
        stmt.run({
          device_id: d.deviceId,
          name: d.name ?? null,
          type: d.type ?? null,
          connected: d.connected ? 1 : 0,
          lat: d.lat ?? null,
          lon: d.lon ?? null,
          battery: d.battery ?? null,
          temperature: d.temperature ?? null,
          firmware: d.firmware ?? null,
          file_no: d.fileNo ?? null,
          records_count: d.recordsCount ?? null,
          has_power: b(d.hasPower),
          in_timing_mode: b(d.inTimingMode),
          time_running: b(d.timeRunning),
          in_standby: b(d.inStandby),
          reader_healthy: b(d.readerHealthy),
          reader_temperature: d.readerTemperature ?? null,
          time_source: d.timeSource ?? null,
          error_flags: d.errorFlags ?? null,
          device_time: d.deviceTime ?? null,
          request_time: d.requestTime ?? null,
          received: d.received ?? null,
          seen_ms: d.seenMs,
          raw: d.raw ?? null,
        });
      }
    })(rows);
  }

  listDecoders(): DecoderRecord[] {
    const rows = this.db.prepare(`SELECT * FROM decoders ORDER BY name COLLATE NOCASE`).all() as Array<
      Record<string, unknown>
    >;
    const b = (v: unknown) => (v === null || v === undefined ? undefined : v === 1);
    const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
    return rows.map((r) => ({
      deviceId: String(r.device_id),
      name: s(r.name) ?? String(r.device_id),
      type: s(r.type) ?? 'Decoder',
      connected: r.connected === 1,
      lat: n(r.lat),
      lon: n(r.lon),
      battery: n(r.battery),
      temperature: n(r.temperature),
      firmware: s(r.firmware),
      fileNo: s(r.file_no),
      recordsCount: n(r.records_count),
      hasPower: b(r.has_power),
      inTimingMode: b(r.in_timing_mode),
      timeRunning: b(r.time_running),
      inStandby: b(r.in_standby),
      readerHealthy: b(r.reader_healthy),
      readerTemperature: n(r.reader_temperature),
      timeSource: s(r.time_source),
      errorFlags: s(r.error_flags),
      deviceTime: s(r.device_time),
      requestTime: s(r.request_time),
      received: s(r.received),
      seenMs: Number(r.seen_ms),
      hidden: r.hidden === 1,
      raw: s(r.raw) ?? '',
    }));
  }

  /**
   * Hide a device we do not own. A shared RaceResult account at a big event
   * carries other timers' boxes, and they keep coming back on every poll —
   * hiding is a local decision, so it survives polling and restarts.
   */
  setDecoderHidden(deviceId: string, hidden: boolean): void {
    const r = this.db
      .prepare(`UPDATE decoders SET hidden = ? WHERE device_id = ?`)
      .run(hidden ? 1 : 0, deviceId);
    if (r.changes === 0) throw new Error(`Unknown decoder: ${deviceId}`);
  }

  /** Forget a device that RaceResult no longer lists. */
  deleteDecodersExcept(keep: string[]): number {
    if (keep.length === 0) return this.db.prepare(`DELETE FROM decoders`).run().changes;
    const marks = keep.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM decoders WHERE device_id NOT IN (${marks})`).run(...keep).changes;
  }

  // --- raw wire log -------------------------------------------------------

  /** Buffered so the ingest path never waits on a disk write; a whole backlog
   *  flush from one device lands in a single transaction. */
  private wireBuffer: WireFrameRow[] = [];

  queueWireFrame(f: WireFrameRow): void {
    this.wireBuffer.push(f);
    // A GL320 clearing its backlog can arrive as a burst; write it out rather
    // than letting the buffer grow unbounded between ticks.
    if (this.wireBuffer.length >= 500) this.flushWireFrames();
  }

  flushWireFrames(): void {
    if (this.wireBuffer.length === 0) return;
    const batch = this.wireBuffer;
    this.wireBuffer = [];
    const stmt = this.db.prepare(
      `INSERT INTO wire_frames (t_ms, source, ip, binary, bytes, imei, text) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction((rows: WireFrameRow[]) => {
      for (const r of rows) stmt.run(r.tMs, r.source, r.ip, r.binary ? 1 : 0, r.bytes, r.imei ?? null, r.text);
    })(batch);
  }

  /**
   * Newest-first page of the log. `before` is an id from a previous page, so
   * scrolling back is stable even while new frames are still arriving.
   */
  wireHistory(opts: {
    limit?: number;
    before?: number;
    source?: string;
    imei?: string;
    q?: string;
    since?: number;
    until?: number;
  } = {}): WireFrameRow[] {
    this.flushWireFrames(); // anything just received should be findable
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.before !== undefined) {
      where.push('id < ?');
      args.push(opts.before);
    }
    if (opts.source && opts.source !== 'all') {
      where.push('source = ?');
      args.push(opts.source);
    }
    if (opts.imei) {
      where.push('imei = ?');
      args.push(opts.imei);
    }
    if (opts.since !== undefined) {
      where.push('t_ms >= ?');
      args.push(opts.since);
    }
    if (opts.until !== undefined) {
      where.push('t_ms <= ?');
      args.push(opts.until);
    }
    if (opts.q) {
      where.push('(text LIKE ? OR ip LIKE ?)');
      args.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));
    const rows = this.db
      .prepare(
        `SELECT id, t_ms, source, ip, binary, bytes, imei, text FROM wire_frames
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      tMs: Number(r.t_ms),
      source: String(r.source),
      ip: String(r.ip),
      binary: r.binary === 1,
      bytes: Number(r.bytes),
      imei: r.imei === null ? undefined : String(r.imei),
      text: String(r.text),
    }));
  }

  /** Which ports have been heard from, for the history filter. */
  wireSources(): string[] {
    return (this.db.prepare(`SELECT DISTINCT source FROM wire_frames ORDER BY source`).all() as Array<{
      source: string;
    }>).map((r) => r.source);
  }

  wireStats(): { frames: number; oldestMs: number | null } {
    this.flushWireFrames();
    const r = this.db.prepare(`SELECT COUNT(*) AS n, MIN(t_ms) AS oldest FROM wire_frames`).get() as {
      n: number;
      oldest: number | null;
    };
    return { frames: Number(r.n), oldestMs: r.oldest === null ? null : Number(r.oldest) };
  }

  /**
   * Keep the log bounded: a full fleet reporting every 10 s is roughly half a
   * million frames a day, which is far more than anyone scrolls back through.
   */
  pruneWireFrames(keep = 200_000, maxAgeMs = 7 * 24 * 3600_000): number {
    this.flushWireFrames();
    const cutoff = Date.now() - maxAgeMs;
    const byAge = this.db.prepare(`DELETE FROM wire_frames WHERE t_ms < ?`).run(cutoff);
    const byCount = this.db
      .prepare(
        `DELETE FROM wire_frames WHERE id <= (
           SELECT id FROM wire_frames ORDER BY id DESC LIMIT 1 OFFSET ?
         )`,
      )
      .run(keep);
    return Number(byAge.changes) + Number(byCount.changes);
  }

  clearWireFrames(): void {
    this.wireBuffer = [];
    this.db.exec(`DELETE FROM wire_frames`);
  }

  close(): void {
    this.flushWireFrames();
    this.db.close();
  }
}

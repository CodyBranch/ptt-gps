# PTT GPS

Race GPS tracking system: ingests Queclink tracker data over TCP, snaps positions to
a course, computes lead/chase distances, and publishes to the Firebase RTDBs that feed
scoreboards, clocks, and public maps. Replaces the legacy per-event copies in `legacy/`
(kept locally as reference; git-ignored because it contains embedded credentials).

## Layout

```
server/     TypeScript backend: ingest → hygiene → engine → outputs, REST + socket.io API
admin-ui/   React + MapLibre operator console
events/     One JSON config per event (meet) + KML course files — an event is config, not code
tools/      extract-course.mjs: pull a course out of a legacy admin HTML page into KML
legacy/     the old system (untracked)
```

## Concepts

- **Event (meet)** → one or more **races**, each with its own KML course. Trackers and
  **roles** (women's lead, men's lead, chase, …) are defined at meet level and inherited
  by every race; per-race overrides exist for exceptions.
- A role holds an **ordered tracker list** (primary + backups). All of them compute
  continuously; exactly one is *active* (published). Failover is one click in the UI.
- **Race lifecycle**: scheduled → armed (computing, not publishing) → live (publishing,
  session recording) → finished. Every fix and operator action is stamped into the
  session, so any past race can be replayed or re-published.
- **Snap windows**: each (race, tracker) has a moving min/max window along the course
  (the legacy algorithm, server-side). Operators can one-shot reset the window or
  latch it to a zone ("hold") when a tracker misbehaves near overlapping course legs.

## Ingest

TCP listeners accept both direct tracker connections (GL-family ASCII `@Track`, GTFRI
22- and 27-field layouts) and the Franklin-GPS mirror (mixed ASCII + binary
`@Track Protocol Pro` from GV500CNA units). Framing is byte-level — never split on `$`;
binary frames are length-framed and CRC-8 checked. A hygiene gate rejects no-fix frames,
out-of-order/buffered backlog, first-connect history floods, and future-dated clocks,
and tracks count-number gaps for the health display. Every frame (accepted or not) is
stored to SQLite for replay.

## Running

```bash
npm install

# server (terminal 1)
npm run dev:server -- --event events/boston-2026-demo.json

# admin UI (terminal 2) → http://localhost:5173
npm run dev:ui

# simulated race against the running server (terminal 3)
npm run sim -w server -- --event ../events/boston-2026-demo.json --race marathon --timescale 20

# replay a legacy log through the engine
npm run replay -w server -- --event ../events/ironman-utah-2022-replay.json --race run \
  --log ../legacy/logs/015181000131111.log

# tests
npm test
```

## Firebase output

Configured per event under `firebase[]`; with none configured a debug publisher logs
writes to console + the `publishes` table. Targets need `credentialEnv` pointing at an
env var that holds the path to a service-account JSON (never commit those). Write paths
reproduce the legacy consumers exactly: `<meet>/Meta/Clock` (`distanceComplete1–4`),
`<meet>/PTT-Scoreboard/1` (`Distance1–4`, ptt flavor), `<meet>/GPSMap/<cmd>` (krush
flavor), `<meet>/GPS/<imei>`.

## Adding an event

1. Export each race's course as KML (single LineString path) into `events/courses/`.
   For an old event: `node tools/extract-course.mjs legacy/map/X-admin.html out.kml`.
2. Copy an existing event JSON: set `meetId`, tracker IMEIs/labels, roles, races.
3. `npm run dev:server -- --event events/<new>.json` and verify with the simulator
   before race day.

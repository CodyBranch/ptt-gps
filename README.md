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

## Manual

The operator manual is written once, in `admin-ui/src/manual.ts`, and rendered
twice: as the **Help** page in the console (bottom of the sidebar) and as a
printed PDF. Because both read the same file, the page and the paper cannot
drift apart.

Rebuilding it takes two steps. The first drives a headless Chrome over the
DevTools protocol to re-shoot every screenshot, running the simulator while it
works so the race pages show a race actually running:

```bash
npm run docs:capture -- --user <admin> --pass <password>
npm run manual
```

`docs:capture` needs the server running and an admin login; it arms, starts and
then resets the test race itself, and puts the event back as it found it. Add
`--only <shot-name>` to re-take a single screenshot. `manual` then rebuilds
`admin-ui/public/docs/primetime-gps-manual.pdf`, which the Help page links to.
Run `npm run build -w admin-ui` afterwards so the console serves the new files.

## Running as a service

The server has to come back on its own after a reboot, and a deploy has to be
survivable. Both live in `deploy/`.

### Install

From an **elevated** PowerShell on the server:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\install-service.ps1
```

Windows blocks unsigned scripts by default (`running scripts is disabled on
this system`). The bypass above applies to that one command only. If you would
rather run the scripts normally, lift it for the session — it reverts when you
close the window — and leave the machine policy alone:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\deploy\install-service.ps1
```

It builds if needed, downloads WinSW as `deploy/ptt-gps.exe` (WinSW reads the
config file named after itself, which is why it is not called `WinSW.exe`),
registers **ptt-gps** to start automatically, and then waits until the console
actually answers — a service
that reports "Running" while failing to serve is worse than one that fails
loudly. Logs roll in `logs/`.

If the download fails - a proxy, or an older TLS stack - fetch
`WinSW.NET461.exe` from the [WinSW releases](https://github.com/winsw/winsw/releases)
on any machine, copy it to the server as `deploy\ptt-gps.exe`, and re-run the
script. It uses whatever is already there.

Two details in `deploy/ptt-gps.xml` are load-bearing. The `--db` and
`--events-dir` paths are **explicit**, because the server resolves them relative
to the working directory: a service started from anywhere else opens an empty
database and reports no events, which looks like losing every event rather than
like a misconfiguration. And it restarts on *any* exit, including a clean one,
which is what lets a future in-app deploy work by simply exiting.

### Deploy an update

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\update.ps1 -Check   # anything waiting?
powershell -ExecutionPolicy Bypass -File .\deploy\update.ps1          # confirm, then deploy
```

The ordering is the safety. It pulls, installs, builds and runs the tests
**while the old build is still serving**, and only restarts once the new one is
known good — so a bad commit costs time rather than uptime. It refuses if a
race is armed or live, and if the working tree on the box has local changes. If
the new build does not answer within 30 seconds it rolls back to the previous
commit, rebuilds and restarts.

Expect a 2–4 second gap at the restart, not zero. Trackers reconnect and resend
what they buffered, live races resume from recorded fixes, and consoles
reconnect on their own — so nothing is lost, but do not do it mid-race. That is
what the interlock is for.

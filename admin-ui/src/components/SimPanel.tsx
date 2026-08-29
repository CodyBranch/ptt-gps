import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { EventSnap, RaceSnap, Snapshot } from '../types';

export interface SimProgress {
  running: boolean;
  elapsedRealS?: number;
  elapsedSimS?: number;
  courseMi?: number;
  timescale?: number;
  endReason?: string;
  trackers: Array<{ imei: string; label: string; distanceMi: number; battery: number; done: boolean }>;
  targets?: Array<{ host: string; port: number; connected: boolean; error?: string }>;
}

/**
 * Race simulation: streams realistic tracker pings (real GTFRI packets with
 * timestamps) into the server's own listener, so the whole live pipeline is
 * exercised — arm a race first and watch it track. Export the sim package to
 * run the same simulation from another machine against this server.
 */
export function SimPanel({
  snapshot,
  progress,
  ask,
  onMsg,
}: {
  snapshot: Snapshot;
  progress?: SimProgress;
  ask: (req: ConfirmRequest) => void;
  onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  const [eventId, setEventId] = useState(snapshot.events[0]?.event.id ?? '');
  const ev: EventSnap | undefined = snapshot.events.find((e) => e.event.id === eventId) ?? snapshot.events[0];
  const [raceId, setRaceId] = useState(ev?.races[0]?.raceId ?? '');
  const [timescale, setTimescale] = useState('10');
  const [intervalS, setIntervalS] = useState(String(ev?.event.reportIntervalS || 10));
  const [jitterM, setJitterM] = useState('8');
  const [extraTargets, setExtraTargets] = useState('');
  const [paces, setPaces] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<SimProgress>();

  const live = progress ?? status;
  const race: RaceSnap | undefined = ev?.races.find((r) => r.raceId === raceId) ?? ev?.races[0];

  useEffect(() => {
    api.simStatus().then(setStatus).catch(console.error);
  }, []);

  const start = () => {
    const doStart = async () => {
      try {
        const paceMap: Record<string, number> = {};
        for (const [imei, v] of Object.entries(paces)) {
          const n = Number(v);
          if (n > 0) paceMap[imei] = n;
        }
        await api.simStart({
          eventId: ev!.event.id,
          raceId: race!.raceId,
          timescale: Number(timescale) || 10,
          intervalS: Number(intervalS) || 10,
          jitterM: Number(jitterM) || 0,
          paces: paceMap,
          extraTargets,
        });
        onMsg({ kind: 'ok', text: 'Simulation started — arm/start the race to watch it track.' });
      } catch (err) {
        onMsg({ kind: 'err', text: (err as Error).message });
      }
    };
    if (ev?.publishEnabled) {
      ask({
        title: 'Publishing is ON — simulate anyway?',
        body: `Simulated positions will reach Firebase if a ${ev!.event.name} race goes live. For a pure rehearsal, turn that event's publishing off first.`,
        confirmLabel: 'Simulate anyway',
        danger: true,
        onConfirm: doStart,
      });
    } else {
      doStart();
    }
  };

  const stop = async () => {
    try {
      await api.simStop();
      const s = await api.simStatus();
      setStatus(s);
      onMsg({ kind: 'ok', text: 'Simulation stopped.' });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  if (!ev || !race) return <p className="hint">No active event with races — activate an event and add races first.</p>;

  return (
    <div className="sim-panel">
      <p className="hint">
        Streams realistic tracker pings (real packets, live timestamps) into this server's own
        listener — the full pipeline runs exactly as on race day. Arm or start the race to watch it
        track. Export the package to simulate from another machine.
      </p>

      {!ev.publishEnabled ? (
        <p className="sim-safe">⛔ This event's outputs are off — safe to rehearse, nothing reaches Firebase.</p>
      ) : (
        <p className="sim-warn">⚠ Publishing is ON for this event — simulated data will reach Firebase if a race goes live.</p>
      )}

      <div className="form-row">
        <label>
          Event
          <select value={ev.event.id} onChange={(e) => setEventId(e.target.value)} disabled={live?.running}>
            {snapshot.events.map((x) => (
              <option key={x.event.id} value={x.event.id}>
                {x.event.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Race
          <select value={race.raceId} onChange={(e) => setRaceId(e.target.value)} disabled={live?.running}>
            {ev.races.map((r) => (
              <option key={r.raceId} value={r.raceId}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Timescale (×)
          <input value={timescale} inputMode="numeric" onChange={(e) => setTimescale(e.target.value)} disabled={live?.running} />
        </label>
        <label>
          Report interval (s)
          <input value={intervalS} inputMode="numeric" onChange={(e) => setIntervalS(e.target.value)} disabled={live?.running} />
        </label>
        <label>
          GPS jitter (m)
          <input value={jitterM} inputMode="numeric" onChange={(e) => setJitterM(e.target.value)} disabled={live?.running} />
        </label>
      </div>
      <div className="form-row">
        <label>
          Also send pings to (host:port, comma-separated — e.g. the legacy server)
          <input
            value={extraTargets}
            onChange={(e) => setExtraTargets(e.target.value)}
            placeholder="23.99.178.28:1010, 192.168.1.50:1000"
            disabled={live?.running}
          />
        </label>
      </div>
      {live?.targets && live.targets.length > 0 && (
        <div className="sim-targets">
          {live.targets.map((t) => (
            <span key={`${t.host}:${t.port}`} className={`sim-target ${t.connected ? 'ok' : 'bad'}`}>
              {t.connected ? '●' : '○'} {t.host}:{t.port}
              {t.error && !t.connected ? ` — ${t.error}` : ''}
            </span>
          ))}
        </div>
      )}

      <table className="setup-table">
        <thead>
          <tr><th>Tracker</th><th>Pace (mph)</th><th>Progress</th></tr>
        </thead>
        <tbody>
          {race.trackers.map((t) => {
            const p = live?.trackers.find((x) => x.imei === t.imei);
            const pct = p && live?.courseMi ? Math.min(100, (p.distanceMi / live.courseMi) * 100) : 0;
            return (
              <tr key={t.imei}>
                <td>
                  <div className="t-label">{t.label}</div>
                  <div className="t-imei">{t.imei}</div>
                </td>
                <td>
                  <input
                    className="w-num"
                    placeholder="auto"
                    value={paces[t.imei] ?? ''}
                    onChange={(e) => setPaces({ ...paces, [t.imei]: e.target.value })}
                    disabled={live?.running}
                  />
                </td>
                <td className="sim-progress-cell">
                  {p ? (
                    <>
                      <div className="sim-bar">
                        <div className="sim-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="sim-bar-label">
                        {p.distanceMi.toFixed(2)} mi{p.done ? ' ✓' : ''}
                      </span>
                    </>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="form-row">
        {live?.running ? (
          <>
            <span className="sim-clock">
              sim time +{Math.floor((live.elapsedSimS ?? 0) / 60)}m{(live.elapsedSimS ?? 0) % 60}s · ×
              {live.timescale}
            </span>
            <button className="mini danger self-end" onClick={stop}>
              ■ Stop simulation
            </button>
          </>
        ) : (
          <button className="mini primary self-end" onClick={start}>
            ▶ Start simulation
          </button>
        )}
        <span className="spacer" />
        <a className="mini export-link" href="/api/export" download>
          ⬇ Export sim package
        </a>
      </div>
      {live?.endReason && !live.running && <p className="hint">Last run ended: {live.endReason}</p>}
      <p className="hint">
        Remote use: <span className="mono">npm run sim -w server -- --package {ev.event.id}-sim.json --race{' '}
        {race.raceId} --host &lt;server-ip&gt; [--timescale 30]</span>
      </p>
    </div>
  );
}

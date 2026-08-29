import { useEffect, useMemo, useReducer, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api';
import { ConfirmDialog, type ConfirmRequest } from './components/Confirm';
import { EventsView } from './components/EventsView';
import { Login, type AuthInfo } from './components/Login';
import { MapView, type MapSelection } from './components/MapView';
import { RacePanel } from './components/RacePanel';
import { RolesPanel } from './components/RolesPanel';
import { SetupView } from './components/SetupView';
import { SimPanel, type SimProgress } from './components/SimPanel';
import { TrackerTable } from './components/TrackerTable';
import { WindowDialog } from './components/WindowDialog';
import type { RaceSnap, SimulatedDistance, Snapshot, TrackerPub, Units } from './types';

interface State {
  snapshot?: Snapshot;
  connected: boolean;
  /** Live per-IMEI "last packet arrived" times, fed by every fix/telemetry event. */
  lastSeen: Record<string, number>;
}

type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'race'; race: RaceSnap }
  | { type: 'tracker'; raceId: string; state: TrackerPub; slice: [number, number][]; health: TrackerPub['health'] }
  | { type: 'seen'; imei: string; ms: number }
  | { type: 'publishing'; enabled: boolean }
  | { type: 'simulated'; tracker: string; entry: SimulatedDistance }
  | { type: 'connected'; connected: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, lastSeen: { ...action.snapshot.lastSeen } };
    case 'seen':
      return { ...state, lastSeen: { ...state.lastSeen, [action.imei]: action.ms } };
    case 'publishing':
      return state.snapshot
        ? { ...state, snapshot: { ...state.snapshot, publishEnabled: action.enabled } }
        : state;
    case 'simulated':
      return state.snapshot
        ? {
            ...state,
            snapshot: {
              ...state.snapshot,
              simulated: { ...state.snapshot.simulated, [action.tracker]: action.entry },
            },
          }
        : state;
    case 'race': {
      if (!state.snapshot) return state;
      const races = state.snapshot.races.map((r) => (r.raceId === action.race.raceId ? action.race : r));
      return { ...state, snapshot: { ...state.snapshot, races } };
    }
    case 'tracker': {
      if (!state.snapshot) return state;
      const races = state.snapshot.races.map((r) => {
        if (r.raceId !== action.raceId) return r;
        const trackers = r.trackers.map((t) =>
          t.imei === action.state.imei ? { ...t, ...action.state, slice: action.slice, health: action.health } : t,
        );
        return { ...r, trackers };
      });
      return { ...state, snapshot: { ...state.snapshot, races } };
    }
    case 'connected':
      return { ...state, connected: action.connected };
  }
}

/** Forced viewer layout: the /watch link handed to viewers, or ?viewer for
 *  an operator setting up a wall display. */
const VIEWER_URL =
  window.location.pathname === '/watch' || new URLSearchParams(window.location.search).has('viewer');

export default function App() {
  const [state, dispatch] = useReducer(reducer, { connected: false, lastSeen: {} });
  const [auth, setAuth] = useState<'checking' | 'out' | AuthInfo>('checking');
  const [raceId, setRaceId] = useState<string>();
  const [selected, setSelected] = useState<MapSelection>();
  const [windowDialog, setWindowDialog] = useState<MapSelection>();
  const [view, setView] = useState<'ops' | 'all' | 'setup' | 'events' | 'sim'>('ops');
  const [simProgress, setSimProgress] = useState<SimProgress>();
  const [displayUnits, setDisplayUnits] = useState<Units>(() => {
    try {
      return (localStorage.getItem('ptt-display-units') as Units) || 'miles';
    } catch {
      return 'miles';
    }
  });
  const [confirm, setConfirm] = useState<ConfirmRequest>();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const ask = (req: ConfirmRequest) => setConfirm(req);
  /** Themed error modal — replaces native alert(). */
  const oops = (title: string) => (err: unknown) =>
    ask({ title, body: err instanceof Error ? err.message : String(err), alertOnly: true, onConfirm: () => {} });

  const toggleUnits = () => {
    const next: Units = displayUnits === 'miles' ? 'kilometers' : 'miles';
    ask({
      title: `Switch display to ${next}?`,
      body: 'Changes what this console shows only — published distances keep the event’s output units.',
      confirmLabel: `Show ${next === 'miles' ? 'miles' : 'kilometers'}`,
      onConfirm: () => {
        setDisplayUnits(next);
        try {
          localStorage.setItem('ptt-display-units', next);
        } catch {
          /* per-viewer convenience only */
        }
      },
    });
  };

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setAuth({ username: j.username ?? 'operator', role: j.role === 'viewer' ? 'viewer' : j.role === 'admin' ? 'admin' : 'staff' }))
      .catch(() => setAuth('out'));
  }, []);

  useEffect(() => {
    if (auth === 'checking' || auth === 'out') return;
    const socket = io();
    socket.on('connect', () => dispatch({ type: 'connected', connected: true }));
    socket.on('connect_error', (err) => {
      if (/not authenticated/i.test(err.message)) setAuth('out');
    });
    socket.on('disconnect', () => dispatch({ type: 'connected', connected: false }));
    socket.on('snapshot', (snapshot: Snapshot) => dispatch({ type: 'snapshot', snapshot }));
    socket.on('race', (race: RaceSnap) => dispatch({ type: 'race', race }));
    socket.on('tracker', (p: { raceId: string; state: TrackerPub; slice: [number, number][]; health: TrackerPub['health'] }) =>
      dispatch({ type: 'tracker', raceId: p.raceId, state: p.state, slice: p.slice, health: p.health }),
    );
    socket.on('fix', (f: { imei: string; receivedAtMs?: number }) => {
      if (f.imei) dispatch({ type: 'seen', imei: f.imei, ms: f.receivedAtMs ?? Date.now() });
    });
    socket.on('telemetry', (t: { imei?: string; receivedAtMs?: number }) => {
      if (t.imei) dispatch({ type: 'seen', imei: t.imei, ms: t.receivedAtMs ?? Date.now() });
    });
    socket.on('publishing', (p: { enabled: boolean }) => dispatch({ type: 'publishing', enabled: p.enabled }));
    socket.on('sim', (p: SimProgress) => setSimProgress(p));
    socket.on('simulatedDistance', (d: { tracker: string; distance: number; raceTime?: string; tMs: number }) =>
      dispatch({ type: 'simulated', tracker: d.tracker, entry: { distance: d.distance, raceTime: d.raceTime, tMs: d.tMs } }),
    );
    const t = setInterval(() => tick(), 1000); // refresh fix-age displays
    return () => {
      socket.close();
      clearInterval(t);
    };
  }, [auth]);

  const race = useMemo(() => {
    const races = state.snapshot?.races ?? [];
    return races.find((r) => r.raceId === raceId) ?? races[0];
  }, [state.snapshot, raceId]);

  if (auth === 'checking') return <div className="loading">Checking sign-in…</div>;
  if (auth === 'out') return <Login onSuccess={(a) => setAuth(a)} />;

  // View-only when the token is a viewer PIN token (server-enforced) or the
  // ?viewer URL is used by an operator for a clean display.
  const viewer = VIEWER_URL || auth.role === 'viewer';

  if (!state.snapshot) {
    return (
      <div className="loading">
        {state.connected ? 'Waiting for event snapshot…' : 'Connecting to server…'}
      </div>
    );
  }

  const races = state.snapshot.races;
  const dialogRace = races.find((r) => r.raceId === windowDialog?.raceId);
  const dialogTracker = dialogRace?.trackers.find((t) => t.imei === windowDialog?.imei);

  const logout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.reload();
  };

  /** The per-race operations block: roles + tracker table wired to one race. */
  const intervalS = state.snapshot.event.reportIntervalS || 10;
  const snapshotSimulated = state.snapshot.simulated;
  const racePanels = (r: RaceSnap) => (
    <>
      <RolesPanel
        race={r}
        displayUnits={displayUnits}
        lastSeen={state.lastSeen}
        intervalS={intervalS}
        simulated={snapshotSimulated}
        readonly={viewer}
        ask={ask}
        onActivate={(roleKey, imei) => api.setActive(r.raceId, roleKey, imei).catch(oops('Failover failed'))}
        onSetSource={(roleKey, source) => api.setSource(r.raceId, roleKey, source).catch(oops('Source switch failed'))}
      />
      <TrackerTable
        race={r}
        displayUnits={displayUnits}
        lastSeen={state.lastSeen}
        intervalS={intervalS}
        readonly={viewer}
        selectedImei={selected?.raceId === r.raceId ? selected.imei : undefined}
        onSelect={(imei) => setSelected({ raceId: r.raceId, imei })}
        onWindow={(imei) => setWindowDialog({ raceId: r.raceId, imei })}
      />
    </>
  );

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img className="brand-logo" src="/img/PRIMETIME.png" alt="Primetime" />
          <span className="event-name">{state.snapshot.event.name}</span>
          {viewer && <span className="viewer-badge">VIEW ONLY</span>}
          <span className={`conn ${state.connected ? 'ok' : 'bad'}`}>
            {state.connected ? '● server' : '○ disconnected'}
          </span>
          <span className="whoami">
            {typeof auth === 'object' && (
              <>
                {auth.username} <span className={`role-badge ${auth.role}`}>{auth.role}</span>{' '}
              </>
            )}
            · <button className="linklike" onClick={logout}>sign out</button>
          </span>
        </div>
        <nav className="race-tabs">
          {races.length > 1 && (
            <button className={view === 'all' ? 'active' : ''} onClick={() => setView('all')}>
              All races
              {races.some((r) => r.status === 'live') && <span className="status-dot live" />}
            </button>
          )}
          {races.map((r) => (
            <button
              key={r.raceId}
              className={view === 'ops' && r.raceId === race?.raceId ? 'active' : ''}
              onClick={() => {
                setView('ops');
                setRaceId(r.raceId);
              }}
            >
              {r.name}
              <span className={`status-dot ${r.status}`} />
            </button>
          ))}
          {!viewer && auth.role === 'admin' && (
            <>
              <button className={view === 'events' ? 'active' : ''} onClick={() => setView('events')}>
                ☰ Events
              </button>
              <button className={view === 'setup' ? 'active' : ''} onClick={() => setView('setup')}>
                ⚙ Setup
              </button>
              <button className={view === 'sim' ? 'active' : ''} onClick={() => setView('sim')}>
                🧪 Sim
                {simProgress?.running && <span className="status-dot live" />}
              </button>
            </>
          )}
        </nav>
        <button className="mini units-toggle" onClick={toggleUnits} title="Display units (does not change published output)">
          {displayUnits === 'miles' ? 'mi' : 'km'}
        </button>
        {!viewer && (
          <button
            className={`publish-toggle ${state.snapshot.publishEnabled ? 'on' : 'off'}`}
            title="Master switch for pushing data to Firebase and other outputs"
            onClick={() => {
              const next = !state.snapshot!.publishEnabled;
              ask({
                title: next ? 'Enable output publishing?' : 'Disable output publishing?',
                body: next
                  ? 'Distances resume flowing to Firebase (scoreboards, clocks, maps) with the next fixes.'
                  : 'Nothing will be pushed to Firebase while disabled — scoreboards get a final showDistance=off and then silence. Races keep computing.',
                confirmLabel: next ? 'Enable' : 'Disable',
                danger: !next,
                onConfirm: () => api.setPublishing(next).catch(oops('Publishing toggle failed')),
              });
            }}
          >
            {state.snapshot.publishEnabled ? '⬆ PUBLISHING' : '⛔ OUTPUTS OFF'}
          </button>
        )}
        {viewer && !state.snapshot.publishEnabled && <span className="publish-toggle off">⛔ OUTPUTS OFF</span>}
        {view === 'ops' && race && !viewer && (
          <RacePanel race={race} ask={ask} onAction={(a) => api.lifecycle(race.raceId, a).catch(oops('Lifecycle change failed'))} />
        )}
      </header>
      {view === 'events' ? (
        <EventsView
          ask={ask}
          onActivated={() => {
            setRaceId(undefined);
            setSelected(undefined);
          }}
        />
      ) : view === 'setup' ? (
        <SetupView ask={ask} onSaved={() => setRaceId(undefined)} />
      ) : view === 'sim' ? (
        <div className="setup">
          <div className="setup-bar">
            <span className="setup-title">Race simulation</span>
          </div>
          <div className="setup-grid">
            <section>
              <SimPanel
                snapshot={state.snapshot}
                progress={simProgress}
                ask={ask}
                onMsg={(m) =>
                  ask({ title: m.kind === 'err' ? 'Simulation error' : 'Simulation', body: m.text, alertOnly: true, onConfirm: () => {} })
                }
              />
            </section>
          </div>
        </div>
      ) : view === 'all' ? (
        <div className="main">
          <aside className="all-races">
            {races.map((r) => (
              <div className="race-section" key={r.raceId}>
                <div className="race-section-head">
                  <span className="race-section-name">{r.name}</span>
                  {!viewer && (
                    <RacePanel race={r} ask={ask} onAction={(a) => api.lifecycle(r.raceId, a).catch(oops('Lifecycle change failed'))} />
                  )}
                  {viewer && <span className={`race-status ${r.status}`}>{r.status.toUpperCase()}</span>}
                </div>
                {racePanels(r)}
              </div>
            ))}
          </aside>
          <MapView races={races} selected={selected} />
        </div>
      ) : race ? (
        <div className="main">
          <aside>{racePanels(race)}</aside>
          <MapView races={[race]} selected={selected?.raceId === race.raceId ? selected : undefined} />
        </div>
      ) : (
        <div className="loading">
          <span>
            No races configured for this event yet — add one in{' '}
            <button className="linklike" onClick={() => setView('setup')}>Setup</button>.
          </span>
        </div>
      )}
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(undefined)} />}
      {dialogRace && dialogTracker && (
        <WindowDialog
          race={dialogRace}
          tracker={dialogTracker}
          onClose={() => setWindowDialog(undefined)}
          onSet={(start, end, latch) =>
            api.setWindow(dialogRace.raceId, dialogTracker.imei, start, end, latch).then(() => setWindowDialog(undefined), oops('Window change failed'))
          }
          onRelease={() =>
            api.releaseWindow(dialogRace.raceId, dialogTracker.imei).then(() => setWindowDialog(undefined), oops('Release failed'))
          }
        />
      )}
    </div>
  );
}

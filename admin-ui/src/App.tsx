import { useEffect, useMemo, useReducer, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api';
import { ConfirmDialog, type ConfirmRequest } from './components/Confirm';
import { EventSetup } from './components/EventSetup';
import { EventsView } from './components/EventsView';
import { FleetView } from './components/FleetView';
import { HomeView } from './components/HomeView';
import { Login, type AuthInfo } from './components/Login';
import { MapView, type MapSelection } from './components/MapView';
import { RacePanel } from './components/RacePanel';
import { RolesPanel } from './components/RolesPanel';
import { SimPanel, type SimProgress } from './components/SimPanel';
import { SystemView } from './components/SystemView';
import { TrackerTable } from './components/TrackerTable';
import { WindowDialog } from './components/WindowDialog';
import type { RaceSnap, SimulatedDistance, Snapshot, TrackerPub, Units } from './types';

interface State {
  snapshot?: Snapshot;
  connected: boolean;
  lastSeen: Record<string, number>;
}

type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'race'; race: RaceSnap }
  | { type: 'tracker'; eventId: string; raceId: string; state: TrackerPub; slice: [number, number][]; health: TrackerPub['health'] }
  | { type: 'seen'; imei: string; ms: number }
  | { type: 'publishing'; enabled: boolean }
  | { type: 'simulated'; tracker: string; entry: SimulatedDistance }
  | { type: 'connected'; connected: boolean };

function reducer(state: State, action: Action): State {
  const snap = state.snapshot;
  switch (action.type) {
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, lastSeen: { ...action.snapshot.lastSeen } };
    case 'seen':
      return { ...state, lastSeen: { ...state.lastSeen, [action.imei]: action.ms } };
    case 'publishing':
      return snap ? { ...state, snapshot: { ...snap, publishEnabled: action.enabled } } : state;
    case 'simulated':
      return snap
        ? { ...state, snapshot: { ...snap, simulated: { ...snap.simulated, [action.tracker]: action.entry } } }
        : state;
    case 'race': {
      if (!snap) return state;
      const events = snap.events.map((ev) =>
        ev.event.id !== action.race.eventId
          ? ev
          : { ...ev, races: ev.races.map((r) => (r.raceId === action.race.raceId ? action.race : r)) },
      );
      return { ...state, snapshot: { ...snap, events } };
    }
    case 'tracker': {
      if (!snap) return state;
      const events = snap.events.map((ev) => {
        if (ev.event.id !== action.eventId) return ev;
        const races = ev.races.map((r) => {
          if (r.raceId !== action.raceId) return r;
          const trackers = r.trackers.map((t) =>
            t.imei === action.state.imei ? { ...t, ...action.state, slice: action.slice, health: action.health } : t,
          );
          return { ...r, trackers };
        });
        return { ...ev, races };
      });
      return { ...state, snapshot: { ...snap, events } };
    }
    case 'connected':
      return { ...state, connected: action.connected };
  }
}

/** Forced viewer layout: the /watch link handed to viewers, or ?viewer. */
const VIEWER_URL =
  window.location.pathname === '/watch' || new URLSearchParams(window.location.search).has('viewer');

type Page = 'home' | 'event' | 'events' | 'fleet' | 'system' | 'sim';

export default function App() {
  const [state, dispatch] = useReducer(reducer, { connected: false, lastSeen: {} });
  const [auth, setAuth] = useState<'checking' | 'out' | AuthInfo>('checking');
  const [page, setPage] = useState<Page>(VIEWER_URL ? 'event' : 'home');
  const [eventId, setEventId] = useState<string>();
  const [eventTab, setEventTab] = useState<string>('all'); // 'all' | raceId | 'setup'
  const [selected, setSelected] = useState<MapSelection>();
  const [windowDialog, setWindowDialog] = useState<MapSelection & { raceId: string }>();
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
  const oops = (title: string) => (err: unknown) =>
    ask({ title, body: err instanceof Error ? err.message : String(err), alertOnly: true, onConfirm: () => {} });

  const toggleUnits = () => {
    const next: Units = displayUnits === 'miles' ? 'kilometers' : 'miles';
    ask({
      title: `Switch display to ${next}?`,
      body: 'Changes what this console shows only — published distances keep each event’s output units.',
      confirmLabel: `Show ${next}`,
      onConfirm: () => {
        setDisplayUnits(next);
        try {
          localStorage.setItem('ptt-display-units', next);
        } catch {
          /* per-viewer convenience */
        }
      },
    });
  };

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) =>
        setAuth({ username: j.username ?? 'operator', role: j.role === 'viewer' ? 'viewer' : j.role === 'admin' ? 'admin' : 'staff' }),
      )
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
    socket.on(
      'tracker',
      (p: { eventId: string; raceId: string; state: TrackerPub; slice: [number, number][]; health: TrackerPub['health'] }) =>
        dispatch({ type: 'tracker', eventId: p.eventId, raceId: p.raceId, state: p.state, slice: p.slice, health: p.health }),
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
    const t = setInterval(() => tick(), 1000);
    return () => {
      socket.close();
      clearInterval(t);
    };
  }, [auth]);

  const events = state.snapshot?.events ?? [];
  const ev = useMemo(() => events.find((e) => e.event.id === eventId) ?? events[0], [events, eventId]);

  if (auth === 'checking') return <div className="loading">Checking sign-in…</div>;
  if (auth === 'out') return <Login onSuccess={(a) => setAuth(a)} />;

  const viewer = VIEWER_URL || auth.role === 'viewer';
  const admin = auth.role === 'admin';

  if (!state.snapshot) {
    return <div className="loading">{state.connected ? 'Waiting for snapshot…' : 'Connecting to server…'}</div>;
  }

  const openEvent = (id: string, tab = 'all') => {
    setEventId(id);
    setEventTab(tab);
    setPage('event');
  };

  const logout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.reload();
  };

  const intervalS = ev?.event.reportIntervalS || 10;
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
        onActivate={(roleKey, imei) => api.setActive(r.eventId, r.raceId, roleKey, imei).catch(oops('Failover failed'))}
        onSetSource={(roleKey, source) => api.setSource(r.eventId, r.raceId, roleKey, source).catch(oops('Source switch failed'))}
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

  const dialogRace = ev?.races.find((r) => r.raceId === windowDialog?.raceId);
  const dialogTracker = dialogRace?.trackers.find((t) => t.imei === windowDialog?.imei);

  const eventRaceView = () => {
    if (!ev) {
      return (
        <div className="loading">
          <span>No active events{admin ? ' — activate one from the Events page.' : '.'}</span>
        </div>
      );
    }
    if (eventTab === 'setup' && admin && !viewer) {
      return <EventSetup eventId={ev.event.id} ask={ask} onSaved={() => setEventTab('all')} />;
    }
    const shown = eventTab === 'all' ? ev.races : ev.races.filter((r) => r.raceId === eventTab);
    const races = shown.length > 0 ? shown : ev.races;
    if (races.length === 0) {
      return (
        <div className="loading">
          <span>
            No races configured for this event yet
            {admin && !viewer ? (
              <>
                {' — add one in '}
                <button className="linklike" onClick={() => setEventTab('setup')}>
                  Setup
                </button>
                .
              </>
            ) : (
              '.'
            )}
          </span>
        </div>
      );
    }
    return (
      <div className="main">
        <aside className={races.length > 1 ? 'all-races' : ''}>
          {races.map((r) => (
            <div className="race-section" key={r.raceId}>
              <div className="race-section-head">
                <span className="race-section-name">{r.name}</span>
                {!viewer ? (
                  <RacePanel race={r} ask={ask} onAction={(a) => api.lifecycle(r.eventId, r.raceId, a).catch(oops('Lifecycle change failed'))} />
                ) : (
                  <span className={`race-status ${r.status}`}>{r.status.toUpperCase()}</span>
                )}
              </div>
              {racePanels(r)}
            </div>
          ))}
        </aside>
        <MapView races={races} selected={selected} />
      </div>
    );
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <img className="brand-logo" src="/img/PRIMETIME.png" alt="Primetime" />
          {viewer && <span className="viewer-badge">VIEW ONLY</span>}
          <span className={`conn ${state.connected ? 'ok' : 'bad'}`}>
            {state.connected ? '● server' : '○ disconnected'}
          </span>
          <span className="whoami">
            {auth.username} <span className={`role-badge ${auth.role}`}>{auth.role}</span> ·{' '}
            <button className="linklike" onClick={logout}>
              sign out
            </button>
          </span>
        </div>
        <nav className="race-tabs">
          {!viewer && (
            <button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}>
              ⌂ Home
            </button>
          )}
          {events.map((e) => {
            const live = e.races.some((r) => r.status === 'live');
            const armed = e.races.some((r) => r.status === 'armed');
            return (
              <button
                key={e.event.id}
                className={`event-chip ${page === 'event' && ev?.event.id === e.event.id ? 'active' : ''}`}
                onClick={() => openEvent(e.event.id, eventTab === 'setup' ? 'all' : eventTab)}
              >
                {e.event.name}
                <span className={`status-dot ${live ? 'live' : armed ? 'armed' : 'scheduled'}`} />
              </button>
            );
          })}
          {!viewer && admin && (
            <>
              <button className={page === 'events' ? 'active' : ''} onClick={() => setPage('events')}>
                ☰ Events
              </button>
              <button className={page === 'fleet' ? 'active' : ''} onClick={() => setPage('fleet')}>
                🚐 Fleet
              </button>
              <button className={page === 'system' ? 'active' : ''} onClick={() => setPage('system')}>
                ⚙ System
              </button>
              <button className={page === 'sim' ? 'active' : ''} onClick={() => setPage('sim')}>
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
                  ? 'Distances resume flowing to Firebase (scoreboards, clocks, maps) with the next fixes — for every active event.'
                  : 'Nothing is pushed to Firebase while disabled — all active events. Races keep computing.',
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
      </header>

      {page === 'event' && ev && (
        <nav className="event-subnav">
          {ev.races.length > 1 && (
            <button className={eventTab === 'all' ? 'active' : ''} onClick={() => setEventTab('all')}>
              All races
            </button>
          )}
          {ev.races.map((r) => (
            <button key={r.raceId} className={eventTab === r.raceId ? 'active' : ''} onClick={() => setEventTab(r.raceId)}>
              {r.name}
              <span className={`status-dot ${r.status}`} />
            </button>
          ))}
          {admin && !viewer && (
            <button className={eventTab === 'setup' ? 'active' : ''} onClick={() => setEventTab('setup')}>
              ⚙ Setup
            </button>
          )}
        </nav>
      )}

      {page === 'home' && !viewer ? (
        <HomeView
          snapshot={state.snapshot}
          role={admin ? 'admin' : 'staff'}
          onOpenEvent={(id) => openEvent(id)}
          onNavigate={(v) => setPage(v)}
        />
      ) : page === 'events' && admin && !viewer ? (
        <EventsView
          loaded={events.map((e) => e.event.id)}
          ask={ask}
          onChanged={() => {}}
          onOpenSetup={(id) => openEvent(id, 'setup')}
        />
      ) : page === 'fleet' && admin && !viewer ? (
        <FleetView readonly={false} />
      ) : page === 'system' && admin && !viewer ? (
        <SystemView ask={ask} />
      ) : page === 'sim' && admin && !viewer ? (
        <div className="setup">
          <div className="setup-bar">
            <span className="setup-title">Race simulation</span>
          </div>
          <div className="setup-grid one-col">
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
      ) : (
        eventRaceView()
      )}

      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(undefined)} />}
      {dialogRace && dialogTracker && (
        <WindowDialog
          race={dialogRace}
          tracker={dialogTracker}
          onClose={() => setWindowDialog(undefined)}
          onSet={(start, end, latch) =>
            api
              .setWindow(dialogRace.eventId, dialogRace.raceId, dialogTracker.imei, start, end, latch)
              .then(() => setWindowDialog(undefined), oops('Window change failed'))
          }
          onRelease={() =>
            api
              .releaseWindow(dialogRace.eventId, dialogRace.raceId, dialogTracker.imei)
              .then(() => setWindowDialog(undefined), oops('Release failed'))
          }
        />
      )}
    </div>
  );
}

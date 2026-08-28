import { useEffect, useMemo, useReducer, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api';
import { ConfirmDialog, type ConfirmRequest } from './components/Confirm';
import { Login } from './components/Login';
import { MapView } from './components/MapView';
import { RacePanel } from './components/RacePanel';
import { RolesPanel } from './components/RolesPanel';
import { SetupView } from './components/SetupView';
import { TrackerTable } from './components/TrackerTable';
import { WindowDialog } from './components/WindowDialog';
import type { RaceSnap, Snapshot, TrackerPub, Units } from './types';

interface State {
  snapshot?: Snapshot;
  connected: boolean;
}

type Action =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'race'; race: RaceSnap }
  | { type: 'tracker'; raceId: string; state: TrackerPub; slice: [number, number][]; health: TrackerPub['health'] }
  | { type: 'connected'; connected: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'snapshot':
      return { ...state, snapshot: action.snapshot };
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

export default function App() {
  const [state, dispatch] = useReducer(reducer, { connected: false });
  const [auth, setAuth] = useState<'checking' | 'out' | string>('checking'); // string = username
  const [raceId, setRaceId] = useState<string>();
  const [selectedImei, setSelectedImei] = useState<string>();
  const [windowDialogImei, setWindowDialogImei] = useState<string>();
  const [view, setView] = useState<'ops' | 'setup'>('ops');
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
      .then((j) => setAuth(j.username ?? 'operator'))
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
  if (auth === 'out') return <Login onSuccess={(username) => setAuth(username)} />;

  if (!state.snapshot || !race) {
    return (
      <div className="loading">
        {state.connected ? 'Waiting for event snapshot…' : 'Connecting to server…'}
      </div>
    );
  }

  const logout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.reload();
  };

  const windowTracker = race.trackers.find((t) => t.imei === windowDialogImei);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-name">PTT GPS</span>
          <span className="event-name">{state.snapshot.event.name}</span>
          <span className={`conn ${state.connected ? 'ok' : 'bad'}`}>
            {state.connected ? '● server' : '○ disconnected'}
          </span>
          <span className="whoami">
            {auth} · <button className="linklike" onClick={logout}>sign out</button>
          </span>
        </div>
        <nav className="race-tabs">
          {state.snapshot.races.map((r) => (
            <button
              key={r.raceId}
              className={view === 'ops' && r.raceId === race.raceId ? 'active' : ''}
              onClick={() => {
                setView('ops');
                setRaceId(r.raceId);
              }}
            >
              {r.name}
              <span className={`status-dot ${r.status}`} />
            </button>
          ))}
          <button className={view === 'setup' ? 'active' : ''} onClick={() => setView('setup')}>
            ⚙ Setup
          </button>
        </nav>
        <button className="mini units-toggle" onClick={toggleUnits} title="Display units (does not change published output)">
          {displayUnits === 'miles' ? 'mi' : 'km'}
        </button>
        {view === 'ops' && (
          <RacePanel race={race} ask={ask} onAction={(a) => api.lifecycle(race.raceId, a).catch(alert)} />
        )}
      </header>
      {view === 'setup' ? (
        <SetupView onSaved={() => setRaceId(undefined)} />
      ) : (
        <div className="main">
          <aside>
            <RolesPanel
              race={race}
              displayUnits={displayUnits}
              ask={ask}
              onActivate={(roleKey, imei) => api.setActive(race.raceId, roleKey, imei).catch(alert)}
            />
            <TrackerTable
              race={race}
              displayUnits={displayUnits}
              selectedImei={selectedImei}
              onSelect={setSelectedImei}
              onWindow={setWindowDialogImei}
            />
          </aside>
          <MapView race={race} selectedImei={selectedImei} />
        </div>
      )}
      {confirm && <ConfirmDialog req={confirm} onClose={() => setConfirm(undefined)} />}
      {windowTracker && (
        <WindowDialog
          race={race}
          tracker={windowTracker}
          onClose={() => setWindowDialogImei(undefined)}
          onSet={(start, end, latch) =>
            api.setWindow(race.raceId, windowTracker.imei, start, end, latch).then(() => setWindowDialogImei(undefined), alert)
          }
          onRelease={() =>
            api.releaseWindow(race.raceId, windowTracker.imei).then(() => setWindowDialogImei(undefined), alert)
          }
        />
      )}
    </div>
  );
}

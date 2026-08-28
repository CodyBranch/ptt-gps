import { useEffect, useMemo, useReducer, useState } from 'react';
import { io } from 'socket.io-client';
import { api } from './api';
import { MapView } from './components/MapView';
import { RacePanel } from './components/RacePanel';
import { RolesPanel } from './components/RolesPanel';
import { TrackerTable } from './components/TrackerTable';
import { WindowDialog } from './components/WindowDialog';
import type { RaceSnap, Snapshot, TrackerPub } from './types';

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
  const [raceId, setRaceId] = useState<string>();
  const [selectedImei, setSelectedImei] = useState<string>();
  const [windowDialogImei, setWindowDialogImei] = useState<string>();
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    const socket = io();
    socket.on('connect', () => dispatch({ type: 'connected', connected: true }));
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
  }, []);

  const race = useMemo(() => {
    const races = state.snapshot?.races ?? [];
    return races.find((r) => r.raceId === raceId) ?? races[0];
  }, [state.snapshot, raceId]);

  if (!state.snapshot || !race) {
    return (
      <div className="loading">
        {state.connected ? 'Waiting for event snapshot…' : 'Connecting to server…'}
      </div>
    );
  }

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
        </div>
        <nav className="race-tabs">
          {state.snapshot.races.map((r) => (
            <button
              key={r.raceId}
              className={r.raceId === race.raceId ? 'active' : ''}
              onClick={() => setRaceId(r.raceId)}
            >
              {r.name}
              <span className={`status-dot ${r.status}`} />
            </button>
          ))}
        </nav>
        <RacePanel race={race} onAction={(a) => api.lifecycle(race.raceId, a).catch(alert)} />
      </header>
      <div className="main">
        <aside>
          <RolesPanel
            race={race}
            onActivate={(roleKey, imei) => api.setActive(race.raceId, roleKey, imei).catch(alert)}
          />
          <TrackerTable
            race={race}
            selectedImei={selectedImei}
            onSelect={setSelectedImei}
            onWindow={setWindowDialogImei}
          />
        </aside>
        <MapView race={race} selectedImei={selectedImei} />
      </div>
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

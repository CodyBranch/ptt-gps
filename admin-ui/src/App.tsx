import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
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
  | { type: 'publishing'; eventId: string; enabled: boolean }
  | { type: 'simulated'; tracker: string; entry: SimulatedDistance }
  | { type: 'connected'; connected: boolean };

function reducer(state: State, action: Action): State {
  const snap = state.snapshot;
  switch (action.type) {
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, lastSeen: { ...action.snapshot.lastSeen } };
    case 'seen':
      return { ...state, lastSeen: { ...state.lastSeen, [action.imei]: action.ms } };
    case 'publishing': {
      if (!snap) return state;
      const events = snap.events.map((ev) =>
        ev.event.id === action.eventId ? { ...ev, publishEnabled: action.enabled } : ev,
      );
      return { ...state, snapshot: { ...snap, events } };
    }
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pwDialog, setPwDialog] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const ask = (req: ConfirmRequest) => setConfirm(req);
  const go = (p: Page) => {
    setPage(p);
    setSidebarOpen(false);
  };
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

  // Account menu closes on an outside click or Escape, like the other popovers.
  useEffect(() => {
    if (!accountMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!accountRef.current?.contains(e.target as Node)) setAccountMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountMenu(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [accountMenu]);

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
    socket.on('publishing', (p: { eventId: string; enabled: boolean }) => dispatch({ type: 'publishing', eventId: p.eventId, enabled: p.enabled }));
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
      <button className="sidebar-hamburger" onClick={() => setSidebarOpen(!sidebarOpen)} title="Menu">
        ☰
      </button>
      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <img className="brand-logo" src="/img/PRIMETIME.png" alt="Primetime" />
          {viewer && <span className="viewer-badge">VIEW ONLY</span>}
        </div>
        <nav className="sidebar-nav">
          {!viewer && (
            <button className={`side-item ${page === 'home' ? 'active' : ''}`} onClick={() => go('home')}>
              <span className="side-icon">⌂</span> Home
            </button>
          )}
          <div className="side-section">Events</div>
          {events.length === 0 && <div className="side-empty">none active</div>}
          {events.map((e) => {
            const live = e.races.some((r) => r.status === 'live');
            const armed = e.races.some((r) => r.status === 'armed');
            return (
              <button
                key={e.event.id}
                className={`side-item side-event ${page === 'event' && ev?.event.id === e.event.id ? 'active' : ''}`}
                title={e.event.name}
                onClick={() => {
                  openEvent(e.event.id, eventTab === 'setup' ? 'all' : eventTab);
                  setSidebarOpen(false);
                }}
              >
                <span className={`status-dot ${live ? 'live' : armed ? 'armed' : 'scheduled'}`} />
                <span className="side-event-name">{e.event.name}</span>
                {!e.publishEnabled && <span className="side-off">⛔</span>}
              </button>
            );
          })}
          {!viewer && admin && (
            <>
              <div className="side-section">Manage</div>
              <button className={`side-item ${page === 'events' ? 'active' : ''}`} onClick={() => go('events')}>
                <span className="side-icon">☰</span> Events
              </button>
              <button className={`side-item ${page === 'fleet' ? 'active' : ''}`} onClick={() => go('fleet')}>
                <span className="side-icon">🚐</span> Fleet
              </button>
              <button className={`side-item ${page === 'system' ? 'active' : ''}`} onClick={() => go('system')}>
                <span className="side-icon">⚙</span> System
              </button>
              <button className={`side-item ${page === 'sim' ? 'active' : ''}`} onClick={() => go('sim')}>
                <span className="side-icon">🧪</span> Sim
                {simProgress?.running && <span className="status-dot live" />}
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-footer" ref={accountRef}>
          {accountMenu && (
            <div className="account-menu">
              <div className="account-menu-head">
                <span className="account-menu-name">{auth.username}</span>
                <span className={`role-badge ${auth.role}`}>{auth.role}</span>
              </div>
              {!viewer && (
                <button
                  onClick={() => {
                    setAccountMenu(false);
                    setPwDialog(true);
                  }}
                >
                  <span className="account-menu-icon">🔑</span> Change password
                </button>
              )}
              <button
                className="danger"
                onClick={() => {
                  setAccountMenu(false);
                  logout();
                }}
              >
                <span className="account-menu-icon">⏻</span> Sign out
              </button>
            </div>
          )}
          <div className="account-row">
            <button
              className={`account-btn ${accountMenu ? 'open' : ''}`}
              onClick={() => setAccountMenu(!accountMenu)}
              title={state.connected ? 'Connected to the server' : 'Disconnected — reconnecting'}
            >
              <span className="avatar">
                {auth.username.charAt(0).toUpperCase()}
                <span className={`avatar-conn ${state.connected ? 'ok' : 'bad'}`} />
              </span>
              <span className="account-name">{auth.username}</span>
              <span className="account-caret">▴</span>
            </button>
            <button
              className="mini units-toggle"
              onClick={toggleUnits}
              title="Display units (does not change published output)"
            >
              {displayUnits === 'miles' ? 'mi' : 'km'}
            </button>
          </div>
        </div>
      </aside>

      <div className="content">
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
          <span className="spacer" />
          {!viewer ? (
            <button
              className={`publish-toggle ${ev.publishEnabled ? 'on' : 'off'}`}
              title={`Output switch for ${ev.event.name} only`}
              onClick={() => {
                const next = !ev.publishEnabled;
                ask({
                  title: next ? `Enable publishing for ${ev.event.name}?` : `Disable publishing for ${ev.event.name}?`,
                  body: next
                    ? 'Distances for this event resume flowing to Firebase with the next fixes. Other events are unaffected.'
                    : 'Nothing from this event reaches Firebase while disabled (a final showDistance-off goes out). Other events keep publishing.',
                  confirmLabel: next ? 'Enable' : 'Disable',
                  danger: !next,
                  onConfirm: () => api.setPublishing(ev.event.id, next).catch(oops('Publishing toggle failed')),
                });
              }}
            >
              {ev.publishEnabled ? '⬆ PUBLISHING' : '⛔ OUTPUTS OFF'}
            </button>
          ) : (
            !ev.publishEnabled && <span className="publish-toggle off">⛔ OUTPUTS OFF</span>
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
      </div>

      {pwDialog && (
        <PasswordDialog
          onClose={() => setPwDialog(false)}
          onDone={() =>
            ask({ title: 'Password changed', body: 'Your other sessions were signed out.', alertOnly: true, onConfirm: () => {} })
          }
        />
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

function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const valid = current.length > 0 && next.length >= 8 && next === confirmPw;

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.changePassword(current, next);
      onClose();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <h3>Change password</h3>
        <div className="dialog-row">
          <label>
            Current password
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
          </label>
        </div>
        <div className="dialog-row">
          <label>
            New password (min 8)
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Confirm
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
          </label>
        </div>
        {next.length > 0 && next.length < 8 && <p className="hint">At least 8 characters.</p>}
        {confirmPw.length > 0 && next !== confirmPw && <p className="hint">Passwords do not match yet.</p>}
        {err && <p className="dialog-error">{err}</p>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button className="mini primary" disabled={!valid || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </div>
    </div>
  );
}

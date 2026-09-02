import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api } from './api';
import { ConfirmDialog, type ConfirmRequest } from './components/Confirm';
import { EventSetup } from './components/EventSetup';
import { CoursesView } from './components/CoursesView';
import { DecodersView } from './components/DecodersView';
import { DistanceBoard } from './components/DistanceBoard';
import { EventsView } from './components/EventsView';
import { FleetView } from './components/FleetView';
import { HelpView } from './components/HelpView';
import { HomeView } from './components/HomeView';
import { Login, type AuthInfo } from './components/Login';
import { MapView, type MapSelection } from './components/MapView';
import { RacePanel } from './components/RacePanel';
import { RolesPanel } from './components/RolesPanel';
import { trackerColors } from './colors';
import { SimPanel, type SimProgress } from './components/SimPanel';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SystemView } from './components/SystemView';
import { WireLog } from './components/WireLog';
import { TrackerTable } from './components/TrackerTable';
import { WindowDialog } from './components/WindowDialog';
import type { DecoderPub, RaceSnap, RaceStatus, SimulatedDistance, Snapshot, TrackerPub, Units } from './types';

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

/**
 * Forced viewer layout: the /watch link handed to viewers, or ?viewer.
 *
 * Two flavours, because two different people get handed this link. /watch is
 * the full picture — map, vehicles, trackers. /watch/distances is just the
 * headline number per role, for an announcer who needs to read it, not work it.
 */
const VIEWER_PATHS = ['/watch', '/watch/distances'];
const VIEWER_URL =
  VIEWER_PATHS.includes(window.location.pathname) || new URLSearchParams(window.location.search).has('viewer');
const BOARD_URL =
  window.location.pathname === '/watch/distances' ||
  new URLSearchParams(window.location.search).get('viewer') === 'distances';

type Page = 'home' | 'event' | 'events' | 'courses' | 'fleet' | 'decoders' | 'system' | 'sim' | 'wire' | 'help';

/**
 * The console keeps its place in the address bar, so a refresh returns you to
 * the page you were on and a link to a race can be handed to someone else.
 * Small enough to map by hand — no router dependency for seven pages.
 */
interface Route {
  page: Page;
  eventId?: string;
  eventTab: string;
}

const TOP_PAGES: Page[] = ['events', 'courses', 'fleet', 'decoders', 'system', 'sim', 'wire', 'help'];

/** What the phone's app bar calls each page. */
const PAGE_TITLES: Record<Page, string> = {
  home: 'Home',
  event: '',
  events: 'Events',
  courses: 'Courses',
  fleet: 'Tracker fleet',
  decoders: 'Decoders',
  system: 'System',
  sim: 'Race simulation',
  wire: 'Wire log',
  help: 'Help',
};

/** The tab strip's status dot, for a native <option> that cannot be styled:
 *  filled is running, half is armed and ready, hollow is waiting, tick is done. */
const STATUS_DOT: Record<RaceStatus, string> = {
  live: '●',
  armed: '◐',
  scheduled: '○',
  finished: '✓',
};

function parseRoute(pathname: string): Route {
  const [first, second, third] = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (first === 'event' && second) {
    return { page: 'event', eventId: decodeURIComponent(second), eventTab: third ? decodeURIComponent(third) : 'all' };
  }
  if (TOP_PAGES.includes(first as Page)) return { page: first as Page, eventTab: 'all' };
  // '/', '/watch' and anything unrecognised land on home
  return { page: 'home', eventTab: 'all' };
}

function routePath(page: Page, eventId?: string, eventTab = 'all'): string {
  if (page === 'home') return '/';
  if (page !== 'event') return `/${page}`;
  if (!eventId) return '/';
  const base = `/event/${encodeURIComponent(eventId)}`;
  return eventTab && eventTab !== 'all' ? `${base}/${encodeURIComponent(eventTab)}` : base;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, { connected: false, lastSeen: {} });
  const [auth, setAuth] = useState<'checking' | 'out' | AuthInfo>('checking');
  const initialRoute = useMemo(() => (VIEWER_URL ? null : parseRoute(window.location.pathname)), []);
  const [page, setPage] = useState<Page>(VIEWER_URL ? 'event' : (initialRoute?.page ?? 'home'));
  const [eventId, setEventId] = useState<string | undefined>(initialRoute?.eventId);
  const [eventTab, setEventTab] = useState<string>(initialRoute?.eventTab ?? 'all'); // 'all' | raceId | 'setup'
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
  // which viewer flavour is on screen; the URL is kept in step so the chosen
  // one can be bookmarked or handed on
  const [board, setBoard] = useState(BOARD_URL);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pwDialog, setPwDialog] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  // held so the wire log can subscribe to the raw feed on the same connection
  const [socket, setSocket] = useState<Socket | null>(null);
  // Timing boxes are global hardware, so they are fetched once and pushed
  // thereafter — the race map can draw them over any event's course.
  const [decoders, setDecoders] = useState<DecoderPub[]>([]);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const ask = (req: ConfirmRequest) => setConfirm(req);
  const go = (p: Page) => {
    setPage(p);
    setSidebarOpen(false);
  };
  /** Flip viewer flavour and keep the address bar honest, so the tab can be
   *  bookmarked or the link passed on as whichever view is on screen. */
  const setViewerMode = (toBoard: boolean) => {
    setBoard(toBoard);
    if (window.location.pathname.startsWith('/watch')) {
      window.history.replaceState(null, '', toBoard ? '/watch/distances' : '/watch');
    }
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

  // --- address bar <-> page state ---------------------------------------
  // The viewer link (/watch) keeps its own URL: it is a fixed entry point, not
  // a page you navigate away from.
  useEffect(() => {
    if (VIEWER_URL) return;
    const want = routePath(page, eventId, eventTab);
    if (window.location.pathname !== want) window.history.pushState({}, '', want);
  }, [page, eventId, eventTab]);

  useEffect(() => {
    if (VIEWER_URL) return;
    const onPop = () => {
      const r = parseRoute(window.location.pathname);
      setPage(r.page);
      setEventId(r.eventId);
      setEventTab(r.eventTab);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!socket) return;
    api
      .decoders()
      .then((r) => setDecoders((r.decoders ?? []).filter((d) => !d.hidden)))
      .catch(() => setDecoders([]));
    // hidden boxes belong to another timer in a shared account — they never
    // reach the race map
    const onDecoders = (list: DecoderPub[]) => setDecoders(list.filter((d) => !d.hidden));
    socket.on('decoders', onDecoders);
    return () => {
      socket.off('decoders', onDecoders);
    };
  }, [socket]);

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
    setSocket(socket);
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
  // Strictly the event asked for: falling back to events[0] made an inactive
  // event look active and showed another event's publish switch.
  const ev = useMemo(
    () => (eventId ? events.find((e) => e.event.id === eventId) : events[0]),
    [events, eventId],
  );

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

  // The event page shows the meet name, which the phone layout otherwise never
  // says; every other page is named for itself.
  const mobileTitle =
    page === 'event' ? (ev?.event.name ?? eventId ?? 'Event') : (PAGE_TITLES[page] ?? '');

  const intervalS = ev?.event.reportIntervalS || 10;
  const snapshotSimulated = state.snapshot.simulated;
  // Assigned across the whole event, not the filtered view, so a tracker keeps
  // the same colour when the operator narrows down to one race.
  const trackerColorMap = trackerColors(ev?.races ?? []);
  /**
   * On the viewer pages a marker is named for the role it is covering, not the
   * device on the bike: someone watching follows "Lead Vehicle", and which
   * tracker is currently publishing it is the operator's business.
   */
  const roleLabelByImei: Record<string, string> = {};
  for (const race of ev?.races ?? []) {
    for (const role of race.roles) {
      if (role.activeImei && roleLabelByImei[role.activeImei] === undefined) {
        roleLabelByImei[role.activeImei] = role.label;
      }
    }
  }
  const precision = ev?.event.viewerPrecision;
  // The console is a working instrument and always reads 2; the viewer pages
  // read whatever the event asked for.
  const decimals = !viewer ? 2 : board ? (precision?.board ?? 2) : (precision?.full ?? 2);
  const viewerLabels = viewer ? roleLabelByImei : undefined;

  const racePanels = (r: RaceSnap) => (
    <>
      <RolesPanel
        race={r}
        displayUnits={displayUnits}
        colors={trackerColorMap}
        decimals={decimals}
        lastSeen={state.lastSeen}
        intervalS={intervalS}
        simulated={snapshotSimulated}
        readonly={viewer}
        ask={ask}
        onActivate={(roleKey, imei) => api.setActive(r.eventId, r.raceId, roleKey, imei).catch(oops('Failover failed'))}
        onSetSource={(roleKey, source) => api.setSource(r.eventId, r.raceId, roleKey, source).catch(oops('Source switch failed'))}
        onVehicle={(roleKey, vehicle) =>
          api.setVehicle(r.eventId, r.raceId, roleKey, vehicle).catch(oops('Reassignment failed'))
        }
        onMoveTracker={(imei, vehicle) =>
          api.moveTracker(r.eventId, imei, vehicle).catch(oops('Move failed'))
        }
      />
      <TrackerTable
        race={r}
        displayUnits={displayUnits}
        colors={trackerColorMap}
        decimals={decimals}
        lastSeen={state.lastSeen}
        intervalS={intervalS}
        readonly={viewer}
        selectedImei={selected?.raceId === r.raceId ? selected.imei : undefined}
        onSelect={(imei) =>
          // clicking the highlighted tracker again clears it, so the map goes
          // back to showing every vehicle without a window slice drawn
          setSelected((cur) =>
            cur?.imei === imei && cur.raceId === r.raceId ? undefined : { raceId: r.raceId, imei },
          )
        }
        onWindow={(imei) => setWindowDialog({ raceId: r.raceId, imei })}
      />
    </>
  );

  const dialogRace = ev?.races.find((r) => r.raceId === windowDialog?.raceId);
  const dialogTracker = dialogRace?.trackers.find((t) => t.imei === windowDialog?.imei);

  const eventRaceView = () => {
    // Setup works for any event, running or not: next weekend's meet gets built
    // during the week, and activating it just to edit would start its engines.
    if (eventTab === 'setup' && admin && !viewer && eventId) {
      return (
        <EventSetup
          eventId={eventId}
          ask={ask}
          runningRaces={(ev?.races ?? [])
            .filter((r) => r.status === 'armed' || r.status === 'live')
            .map((r) => r.name)}
          onSaved={() => setEventTab(ev ? 'all' : 'setup')}
        />
      );
    }
    if (!ev) {
      return (
        <div className="loading">
          <span>No active events{admin ? ' — activate one from the Events page.' : '.'}</span>
        </div>
      );
    }

    if (!ev) {
      return (
        <div className="loading">
          <span>
            This event is not active
            {admin ? ' — activate it from the Events page to start tracking.' : '.'}
          </span>
        </div>
      );
    }
    // The distances page is for someone following the race that is on. A
    // scheduled race there is just a column of "no distance yet", so it offers
    // the live ones only — and with a single live race there is nothing to
    // choose, it simply shows it.
    const pool = viewer && board ? ev.races.filter((r) => r.status === 'live') : ev.races;
    const shown = eventTab === 'all' ? pool : pool.filter((r) => r.raceId === eventTab);
    const races = shown.length > 0 ? shown : pool;
    if (viewer && board && races.length === 0) {
      return (
        <div className="loading">
          <span>No race is running — distances appear here as soon as one starts.</span>
        </div>
      );
    }
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
    if (viewer && board) {
      return (
        <div className="main">
          <aside className="board-aside">
            <DistanceBoard
              races={races}
              displayUnits={displayUnits}
              decimals={decimals}
              lastSeen={state.lastSeen}
              intervalS={intervalS}
              simulated={snapshotSimulated}
              selected={selected}
              onSelect={(raceId, imei) =>
                setSelected((cur) => (cur?.imei === imei && cur.raceId === raceId ? undefined : { raceId, imei }))
              }
            />
          </aside>
          <MapView
            races={races}
            selected={selected}
            displayUnits={displayUnits}
            colors={trackerColorMap}
            labelOverrides={viewerLabels}
            decimals={decimals}
            decoders={decoders}
          />
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
        <MapView
          races={races}
          selected={selected}
          displayUnits={displayUnits}
          colors={trackerColorMap}
          labelOverrides={viewerLabels}
          decimals={decimals}
          decoders={decoders}
        />
      </div>
    );
  };

  return (
    <div className="app">
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
              <button className={`side-item ${page === 'courses' ? 'active' : ''}`} onClick={() => go('courses')}>
                <span className="side-icon">🗺</span> Courses
              </button>
              <button className={`side-item ${page === 'fleet' ? 'active' : ''}`} onClick={() => go('fleet')}>
                <span className="side-icon">🚐</span> Fleet
              </button>
              <button className={`side-item ${page === 'decoders' ? 'active' : ''}`} onClick={() => go('decoders')}>
                <span className="side-icon">📶</span> Decoders
              </button>
              <button className={`side-item ${page === 'system' ? 'active' : ''}`} onClick={() => go('system')}>
                <span className="side-icon">⚙</span> System
              </button>
              <button className={`side-item ${page === 'wire' ? 'active' : ''}`} onClick={() => go('wire')}>
                <span className="side-icon">📡</span> Wire log
              </button>
              <button className={`side-item ${page === 'sim' ? 'active' : ''}`} onClick={() => go('sim')}>
                <span className="side-icon">🧪</span> Sim
                {simProgress?.running && <span className="status-dot live" />}
              </button>
            </>
          )}
        </nav>
        {!viewer && (
          <div className="sidebar-help">
            <button className={`side-item ${page === 'help' ? 'active' : ''}`} onClick={() => go('help')}>
              <span className="side-icon">❓</span> Help
            </button>
          </div>
        )}
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
        {/* A real app bar on phones. The hamburger used to float over the page,
            so every header had to reserve space for it — and a new page had to
            remember to. Here it has a row of its own, and the page below starts
            at the left edge like anything else. */}
        <header className="mobile-bar">
          <button className="sidebar-hamburger" onClick={() => setSidebarOpen(!sidebarOpen)} title="Menu">
            ☰
          </button>
          <span className="mobile-bar-title">{mobileTitle}</span>
        </header>
      {/* One page failing must not take the whole console down. */}
      <ErrorBoundary where={`${page}:${eventId ?? ''}:${eventTab}`}>
      {page === 'event' && !ev && eventId && admin && !viewer && (
        <nav className="event-subnav">
          <span className="event-chip">{eventId}</span>
          <span className="dim">not active — setup only, nothing is tracking</span>
          <span className="spacer" />
          <button className="mini" onClick={() => setPage('events')}>
            Events →
          </button>
        </nav>
      )}
      {page === 'event' && ev && (() => {
        // The distances page lists only what is running, matching what it shows.
        const navRaces = viewer && board ? ev.races.filter((r) => r.status === 'live') : ev.races;
        return (
        <nav className="event-subnav">
          {/* Its own strip so a meet with ten races scrolls sideways here
              instead of wrapping the header down over the map. */}
          <div className="subnav-races">
            {navRaces.length > 1 && (
              <button className={eventTab === 'all' ? 'active' : ''} onClick={() => setEventTab('all')}>
                All races
              </button>
            )}
            {navRaces.map((r) => (
              <button
                key={r.raceId}
                ref={(el) => {
                  // a race picked from elsewhere (or restored from the URL) can
                  // sit off the end of the strip — bring it into view
                  if (el && eventTab === r.raceId) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}
                className={eventTab === r.raceId ? 'active' : ''}
                onClick={() => setEventTab(r.raceId)}
              >
                {r.name}
                <span className={`status-dot ${r.status}`} />
              </button>
            ))}
          </div>
          {/* Phone-width stand-in for the tab strip: tabs of varying widths
              wrapped into a messy two or three rows once an event had a few
              races. One control, one line, any race count. */}
          <select
            className="subnav-race-select"
            value={eventTab === 'setup' ? 'setup' : eventTab}
            onChange={(e) => setEventTab(e.target.value)}
          >
            {navRaces.length > 1 && <option value="all">All races</option>}
            {navRaces.map((r) => (
              <option key={r.raceId} value={r.raceId}>
                {STATUS_DOT[r.status]} {r.name}
              </option>
            ))}
            {admin && !viewer && <option value="setup">⚙ Setup</option>}
          </select>
          {admin && !viewer && (
            <button
              className={`subnav-setup ${eventTab === 'setup' ? 'active' : ''}`}
              onClick={() => setEventTab('setup')}
            >
              ⚙<span className="btn-word"> Setup</span>
            </button>
          )}
          <span className="spacer" />
          {viewer && (
            /* Viewers get the switch instead of the publish control: the same
               link opens either flavour, so nobody has to be re-sent a URL. */
            <span className="view-mode" title="How much of the race to show">
              <button className={board ? '' : 'on'} onClick={() => setViewerMode(false)}>
                Full
              </button>
              <button className={board ? 'on' : ''} onClick={() => setViewerMode(true)}>
                Distances
              </button>
            </span>
          )}
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
        );
      })()}

      {page === 'home' && !viewer ? (
        <HomeView
          snapshot={state.snapshot}
          lastSeen={state.lastSeen}
          displayUnits={displayUnits}
          role={admin ? 'admin' : 'staff'}
          onOpenEvent={(id) => openEvent(id)}
          onNavigate={(v) => setPage(v)}
        />
      ) : page === 'events' && admin && !viewer ? (
        <EventsView
          live={events}
          lastSeen={state.lastSeen}
          displayUnits={displayUnits}
          ask={ask}
          onChanged={() => {}}
          onOpenSetup={(id) => openEvent(id, 'setup')}
          onOpenEvent={(id, tab) => openEvent(id, tab)}
          onManageCourses={() => setPage('courses')}
        />
      ) : page === 'courses' && admin && !viewer ? (
        <CoursesView displayUnits={displayUnits} ask={ask} onOpenEvent={(id) => openEvent(id)} />
      ) : page === 'fleet' && admin && !viewer ? (
        <FleetView readonly={false} />
      ) : page === 'decoders' && !viewer ? (
        <DecodersView socket={socket} admin={admin} ask={ask} />
      ) : page === 'help' && !viewer ? (
        <HelpView />
      ) : page === 'wire' && !viewer ? (
        <WireLog socket={socket} />
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
      </ErrorBoundary>
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
        </div>
        <div className="dialog-row">
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

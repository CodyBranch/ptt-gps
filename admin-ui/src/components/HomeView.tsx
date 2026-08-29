import { useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import type { EventSnap, FleetRow, Snapshot, TunnelStatus } from '../types';
import { PublishBadge, RaceRows, ReportingCount, eventImeis, isReporting as reporting } from './EventLive';

type Severity = 'bad' | 'warn' | 'info';
interface Alert {
  severity: Severity;
  text: string;
  where?: () => void;
}

/**
 * Post-login landing: the state of the whole box at a glance — what's running,
 * what's reporting, and what needs someone's attention — without opening an
 * event. Events themselves live in the sidebar; this page never controls a
 * race, it only points at one.
 */
export function HomeView({
  snapshot,
  lastSeen,
  role,
  onOpenEvent,
  onNavigate,
}: {
  snapshot: Snapshot;
  /** Live packet ages — kept outside the snapshot so they update between
   *  snapshots, as fixes arrive. */
  lastSeen: Record<string, number>;
  role: 'admin' | 'staff';
  onOpenEvent: (eventId: string, tab?: string) => void;
  onNavigate: (view: 'events' | 'fleet' | 'system' | 'sim') => void;
}) {
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [tunnel, setTunnel] = useState<TunnelStatus>();
  const [, tick] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    api.fleet().then(setFleet).catch(console.error);
    if (role === 'admin') api.tunnelStatus().then(setTunnel).catch(() => {});
  }, [role]);

  // Ages and the clock keep moving between socket pushes.
  useEffect(() => {
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const activeFleet = fleet.filter((f) => !f.retired);
  const openIssues = fleet.reduce((n, f) => n + (f.openIssues ?? 0), 0);
  const lowBattery = activeFleet.filter((f) => f.seen_battery !== null && f.seen_battery < 20);

  const isReporting = (imei: string, ev: EventSnap) => reporting(imei, ev, lastSeen, now);

  const fleetOnline = activeFleet.filter((f) => f.last_received_ms && now - f.last_received_ms < 120_000);
  const liveRaces = snapshot.events.flatMap((ev) => ev.races.filter((r) => r.status === 'live'));
  const armedRaces = snapshot.events.flatMap((ev) => ev.races.filter((r) => r.status === 'armed'));

  // ---- what needs attention -------------------------------------------------
  const alerts: Alert[] = [];
  for (const ev of snapshot.events) {
    if (!ev.publishEnabled) {
      alerts.push({
        severity: 'warn',
        text: `${ev.event.name}: output publishing is OFF — nothing reaches Firebase`,
        where: () => onOpenEvent(ev.event.id),
      });
    }
    for (const race of ev.races) {
      if (race.status !== 'live' && race.status !== 'armed') continue;
      const imeis = race.trackers.map((t) => t.imei);
      const silent = imeis.filter((i) => !isReporting(i, ev));
      if (silent.length > 0) {
        alerts.push({
          severity: silent.length === imeis.length ? 'bad' : 'warn',
          text: `${race.name}: ${silent.length} of ${imeis.length} trackers silent while ${race.status}`,
          where: () => onOpenEvent(ev.event.id, race.raceId),
        });
      }
    }
  }
  if (openIssues > 0) {
    alerts.push({
      severity: 'warn',
      text: `${openIssues} open device issue${openIssues === 1 ? '' : 's'} in the fleet`,
      where: () => onNavigate('fleet'),
    });
  }
  if (lowBattery.length > 0) {
    alerts.push({
      severity: 'warn',
      text: `${lowBattery.length} device${lowBattery.length === 1 ? '' : 's'} below 20% battery`,
      where: () => onNavigate('fleet'),
    });
  }
  if (snapshot.events.length === 0) {
    alerts.push({
      severity: 'info',
      text: 'No events are running — activate one to start tracking',
      where: role === 'admin' ? () => onNavigate('events') : undefined,
    });
  }
  if (role === 'admin' && tunnel && tunnel.state !== 'online') {
    alerts.push({
      severity: 'info',
      text: 'Remote access is off — the console is reachable on this network only',
      where: () => onNavigate('system'),
    });
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  const needsAttention = alerts.filter((a) => a.severity !== 'info').length;

  // A device can be rostered in several events at once — count it once here.
  const trackedImeis = [...new Set(snapshot.events.flatMap((ev) => eventImeis(ev)))];
  const totalTracked = trackedImeis.length;
  const trackedReporting = trackedImeis.filter((imei) =>
    snapshot.events.some((ev) => eventImeis(ev).includes(imei) && isReporting(imei, ev)),
  ).length;

  const dateLabel = (ev: EventSnap) => {
    const { startDate, endDate } = ev.event;
    if (!startDate && !endDate) return 'no dates set';
    if (startDate && endDate && startDate !== endDate) return `${startDate} → ${endDate}`;
    return startDate ?? endDate ?? '';
  };

  return (
    <div className="home">
      <div className="home-head">
        <div>
          <h2 className="home-title">Home</h2>
          <span className="home-sub">
            {liveRaces.length > 0
              ? `${liveRaces.length} race${liveRaces.length === 1 ? '' : 's'} live right now`
              : armedRaces.length > 0
                ? `${armedRaces.length} race${armedRaces.length === 1 ? '' : 's'} armed and waiting for the gun`
                : snapshot.events.length > 0
                  ? 'Standing by — no race is running'
                  : 'Nothing is running'}
          </span>
        </div>
        <div className="home-clock">
          <span className="home-clock-time">{new Date(now).toLocaleTimeString()}</span>
          <span className="home-clock-date">
            {new Date(now).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>
      </div>

      <div className="home-kpis">
        <div className="home-kpi">
          <span className="home-kpi-num">{snapshot.events.length}</span>
          <span className="home-kpi-label">Active events</span>
        </div>
        <div className={`home-kpi ${liveRaces.length > 0 ? 'ok' : ''}`}>
          <span className="home-kpi-num">{liveRaces.length}</span>
          <span className="home-kpi-label">Races live</span>
        </div>
        <div className={`home-kpi ${totalTracked > 0 && trackedReporting < totalTracked ? 'warn' : ''}`}>
          <span className="home-kpi-num">
            {trackedReporting}
            <span className="home-kpi-of">/{totalTracked}</span>
          </span>
          <span className="home-kpi-label">Event trackers reporting</span>
        </div>
        <div className={`home-kpi ${needsAttention > 0 ? 'bad' : 'ok'}`}>
          <span className="home-kpi-num">{needsAttention}</span>
          <span className="home-kpi-label">Needs attention</span>
        </div>
      </div>

      <div className="home-columns">
        <section className="home-col">
          <h3 className="home-section-title">Active events</h3>
          {snapshot.events.length === 0 && (
            <div className="home-empty">
              <p>No events are running.</p>
              {role === 'admin' && (
                <button className="mini primary" onClick={() => onNavigate('events')}>
                  Go to Events →
                </button>
              )}
            </div>
          )}
          {snapshot.events.map((ev) => {
            const live = ev.races.some((r) => r.status === 'live');
            return (
              <div key={ev.event.id} className={`home-event ${live ? 'live' : ''}`}>
                <div className="home-event-head">
                  <span className={`status-dot ${live ? 'live' : ev.races.some((r) => r.status === 'armed') ? 'armed' : 'scheduled'}`} />
                  <button className="home-event-title" onClick={() => onOpenEvent(ev.event.id)}>
                    {ev.event.name}
                  </button>
                  <PublishBadge on={ev.publishEnabled} />
                </div>
                <div className="home-event-meta">
                  {dateLabel(ev)} · meet {ev.event.meetId} ·{' '}
                  <ReportingCount ev={ev} lastSeen={lastSeen} now={now} />
                </div>
                <RaceRows
                  ev={ev}
                  lastSeen={lastSeen}
                  now={now}
                  onOpenRace={(raceId) => onOpenEvent(ev.event.id, raceId)}
                />
                <div className="home-actions">
                  <button className="mini" onClick={() => onOpenEvent(ev.event.id)}>
                    Open event →
                  </button>
                  {role === 'admin' && (
                    <button className="mini" onClick={() => onOpenEvent(ev.event.id, 'setup')}>
                      ⚙ Setup
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {role === 'admin' && snapshot.events.length > 0 && (
            <button className="mini" onClick={() => onNavigate('events')}>
              Manage events →
            </button>
          )}
        </section>

        <section className="home-col home-rail">
          <div className="home-card">
            <div className="home-card-head">
              <h3>Needs attention</h3>
              {needsAttention === 0 && <span className="ok-text">all clear</span>}
            </div>
            {alerts.length === 0 && <p className="hint">Nothing to flag — everything looks healthy.</p>}
            <div className="home-alerts">
              {alerts.map((a, i) => (
                <button
                  key={i}
                  className={`home-alert ${a.severity} ${a.where ? '' : 'static'}`}
                  onClick={a.where}
                  disabled={!a.where}
                >
                  <span className="home-alert-mark">{a.severity === 'bad' ? '✕' : a.severity === 'warn' ? '!' : 'i'}</span>
                  <span>{a.text}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="home-card">
            <div className="home-card-head">
              <h3>Tracker fleet</h3>
              <span className="home-stat">{activeFleet.length}</span>
            </div>
            <div className="home-bar" title={`${fleetOnline.length} of ${activeFleet.length} seen in the last 2 minutes`}>
              <div
                className="home-bar-fill"
                style={{ width: `${activeFleet.length ? (fleetOnline.length / activeFleet.length) * 100 : 0}%` }}
              />
            </div>
            <div className="home-list">
              <div className="home-list-row">
                <span className="home-list-name">Reporting (last 2 min)</span>
                <span className={fleetOnline.length > 0 ? 'ok-text' : 'dim'}>{fleetOnline.length}</span>
              </div>
              <div className="home-list-row">
                <span className="home-list-name">Silent</span>
                <span className="dim">{activeFleet.length - fleetOnline.length}</span>
              </div>
              <div className="home-list-row">
                <span className="home-list-name">Below 20% battery</span>
                <span className={lowBattery.length ? 'warn-text' : 'dim'}>{lowBattery.length}</span>
              </div>
              <div className="home-list-row">
                <span className="home-list-name">Open issues</span>
                <span className={openIssues ? 'warn-text' : 'dim'}>{openIssues}</span>
              </div>
              <div className="home-list-row">
                <span className="home-list-name">Retired</span>
                <span className="dim">{fleet.length - activeFleet.length}</span>
              </div>
            </div>
            <div className="home-actions">
              <button className="mini" onClick={() => onNavigate('fleet')}>
                Fleet →
              </button>
            </div>
          </div>

          <div className="home-card">
            <div className="home-card-head">
              <h3>System</h3>
            </div>
            <div className="home-list">
              <div className="home-list-row">
                <span className="home-list-name">Output publishing</span>
                {(() => {
                  const off = snapshot.events.filter((e) => !e.publishEnabled);
                  if (snapshot.events.length === 0) return <span className="dim">no events</span>;
                  return off.length === 0 ? (
                    <span className="ok-text">on for all events</span>
                  ) : (
                    <span className="bad-text">off for {off.length}</span>
                  );
                })()}
              </div>
              {role === 'admin' && (
                <div className="home-list-row">
                  <span className="home-list-name">Remote access</span>
                  {tunnel?.state === 'online' ? (
                    <a className="home-link" href={tunnel.url} target="_blank" rel="noreferrer">
                      online
                    </a>
                  ) : (
                    <span className="dim">{tunnel?.state ?? 'off'}</span>
                  )}
                </div>
              )}
              <div className="home-list-row">
                <span className="home-list-name">Races live / armed</span>
                <span className="dim">
                  {liveRaces.length} / {armedRaces.length}
                </span>
              </div>
            </div>
            {role === 'admin' && (
              <div className="home-actions">
                <button className="mini" onClick={() => onNavigate('system')}>
                  System →
                </button>
                <button className="mini" onClick={() => onNavigate('sim')}>
                  Simulation
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

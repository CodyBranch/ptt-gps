import { useEffect, useState } from 'react';
import { api } from '../api';
import type { EventListing, FleetRow, Snapshot, TunnelStatus } from '../types';

/**
 * Post-login landing: the operation at a glance — active event, event library,
 * fleet health, and system state — with jumps into each area. Race pages are
 * one click away, not the front door.
 */
export function HomeView({
  snapshot,
  role,
  onNavigate,
}: {
  snapshot: Snapshot;
  role: 'admin' | 'staff';
  onNavigate: (view: 'ops' | 'all' | 'setup' | 'events' | 'sim', raceId?: string) => void;
}) {
  const [events, setEvents] = useState<EventListing[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [tunnel, setTunnel] = useState<TunnelStatus>();

  useEffect(() => {
    api.events().then((r: { events: EventListing[] }) => setEvents(r.events)).catch(console.error);
    api.fleet().then(setFleet).catch(console.error);
    if (role === 'admin') api.tunnelStatus().then(setTunnel).catch(() => {});
  }, [role]);

  const now = Date.now();
  const intervalS = snapshot.event.reportIntervalS || 10;
  const online = fleet.filter((f) => !f.retired && f.last_received_ms && now - f.last_received_ms < intervalS * 6 * 1000);
  const activeFleet = fleet.filter((f) => !f.retired);
  const openIssues = fleet.reduce((n, f) => n + (f.openIssues ?? 0), 0);
  const liveRaces = snapshot.races.filter((r) => r.status === 'live');
  const armedRaces = snapshot.races.filter((r) => r.status === 'armed');

  return (
    <div className="setup">
      <div className="home-grid">
        <section className="home-card home-active-event">
          <div className="home-card-head">
            <h3>Active event</h3>
            <span className="event-card-meta">meet {snapshot.event.meetId}</span>
          </div>
          <div className="home-event-name">{snapshot.event.name}</div>
          {liveRaces.length > 0 && (
            <div className="home-live-banner">● {liveRaces.map((r) => r.name).join(', ')} LIVE</div>
          )}
          <div className="home-races">
            {snapshot.races.length === 0 && <span className="dim">No races configured yet.</span>}
            {snapshot.races.map((r) => (
              <button key={r.raceId} className="home-race-row" onClick={() => onNavigate('ops', r.raceId)}>
                <span className={`status-dot ${r.status}`} />
                <span className="home-race-name">{r.name}</span>
                <span className="dim">{r.status}</span>
              </button>
            ))}
          </div>
          <div className="home-actions">
            {snapshot.races.length > 1 && (
              <button className="mini primary" onClick={() => onNavigate('all')}>
                Race operations →
              </button>
            )}
            {snapshot.races.length === 1 && (
              <button className="mini primary" onClick={() => onNavigate('ops', snapshot.races[0].raceId)}>
                Race operations →
              </button>
            )}
            {role === 'admin' && (
              <button className="mini" onClick={() => onNavigate('setup')}>
                Event setup
              </button>
            )}
          </div>
        </section>

        <section className="home-card">
          <div className="home-card-head">
            <h3>Events</h3>
            <span className="home-stat">{events.length}</span>
          </div>
          <div className="home-list">
            {events.slice(0, 5).map((e) => (
              <div key={e.file} className="home-list-row">
                <span className={e.id === snapshot.event.id ? 'home-active-mark' : 'home-inactive-mark'}>
                  {e.id === snapshot.event.id ? '▶' : '·'}
                </span>
                <span className="home-list-name">{e.name}</span>
                <span className="dim">{e.races} race{e.races === 1 ? '' : 's'}</span>
              </div>
            ))}
            {events.length > 5 && <div className="dim">…and {events.length - 5} more</div>}
          </div>
          {role === 'admin' && (
            <div className="home-actions">
              <button className="mini" onClick={() => onNavigate('events')}>
                Manage events →
              </button>
            </div>
          )}
        </section>

        <section className="home-card">
          <div className="home-card-head">
            <h3>Tracker fleet</h3>
            <span className="home-stat">{activeFleet.length}</span>
          </div>
          <div className="home-metrics">
            <div className="home-metric">
              <span className={`home-metric-num ${online.length > 0 ? 'ok' : ''}`}>{online.length}</span>
              <span className="home-metric-label">reporting now</span>
            </div>
            <div className="home-metric">
              <span className="home-metric-num">{activeFleet.length - online.length}</span>
              <span className="home-metric-label">silent</span>
            </div>
            <div className="home-metric">
              <span className={`home-metric-num ${openIssues > 0 ? 'warn' : ''}`}>{openIssues}</span>
              <span className="home-metric-label">open issues</span>
            </div>
            <div className="home-metric">
              <span className="home-metric-num dim">{fleet.length - activeFleet.length}</span>
              <span className="home-metric-label">retired</span>
            </div>
          </div>
          {role === 'admin' && (
            <div className="home-actions">
              <button className="mini" onClick={() => onNavigate('setup')}>
                Manage fleet →
              </button>
            </div>
          )}
        </section>

        <section className="home-card">
          <div className="home-card-head">
            <h3>System</h3>
          </div>
          <div className="home-list">
            <div className="home-list-row">
              <span className="home-list-name">Output publishing</span>
              <span className={snapshot.publishEnabled ? 'fwd-ok' : 'tunnel-err'}>
                {snapshot.publishEnabled ? '● on' : '⛔ OFF'}
              </span>
            </div>
            {tunnel && (
              <div className="home-list-row">
                <span className="home-list-name">Remote access</span>
                <span className={tunnel.state === 'online' ? 'fwd-ok' : 'dim'}>
                  {tunnel.state === 'online' ? `● ${tunnel.url}` : tunnel.state}
                </span>
              </div>
            )}
            <div className="home-list-row">
              <span className="home-list-name">Report cadence</span>
              <span className="dim">{intervalS}s expected</span>
            </div>
          </div>
          {role === 'admin' && (
            <div className="home-actions">
              <button className="mini" onClick={() => onNavigate('setup')}>
                System setup →
              </button>
              <button className="mini" onClick={() => onNavigate('sim')}>
                Simulation
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

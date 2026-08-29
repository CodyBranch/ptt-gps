import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FleetRow, Snapshot, TunnelStatus } from '../types';

/**
 * Post-login landing: general status only. Events live in the header — this
 * page answers "is everything healthy?" at a glance: per-event race states,
 * fleet health, and system state.
 */
export function HomeView({
  snapshot,
  role,
  onOpenEvent,
  onNavigate,
}: {
  snapshot: Snapshot;
  role: 'admin' | 'staff';
  onOpenEvent: (eventId: string) => void;
  onNavigate: (view: 'events' | 'fleet' | 'system' | 'sim') => void;
}) {
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [tunnel, setTunnel] = useState<TunnelStatus>();

  useEffect(() => {
    api.fleet().then(setFleet).catch(console.error);
    if (role === 'admin') api.tunnelStatus().then(setTunnel).catch(() => {});
  }, [role]);

  const now = Date.now();
  const online = fleet.filter((f) => !f.retired && f.last_received_ms && now - f.last_received_ms < 120_000);
  const activeFleet = fleet.filter((f) => !f.retired);
  const openIssues = fleet.reduce((n, f) => n + (f.openIssues ?? 0), 0);

  return (
    <div className="setup">
      <div className="home-grid">
        <section className="home-card home-events-card">
          <div className="home-card-head">
            <h3>Active events</h3>
            <span className="home-stat">{snapshot.events.length}</span>
          </div>
          {snapshot.events.length === 0 && (
            <p className="hint">No events are running. Activate one from the Events page.</p>
          )}
          {snapshot.events.map((ev) => {
            const live = ev.races.filter((r) => r.status === 'live');
            const armed = ev.races.filter((r) => r.status === 'armed');
            return (
              <button key={ev.event.id} className="home-race-row" onClick={() => onOpenEvent(ev.event.id)}>
                <span className={`status-dot ${live.length ? 'live' : armed.length ? 'armed' : 'scheduled'}`} />
                <span className="home-race-name">{ev.event.name}</span>
                <span className="dim">
                  {live.length > 0
                    ? `${live.length} LIVE`
                    : armed.length > 0
                      ? `${armed.length} armed`
                      : `${ev.races.length} race${ev.races.length === 1 ? '' : 's'}`}
                </span>
                {!ev.publishEnabled && <span className="tunnel-err">⛔</span>}
              </button>
            );
          })}
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
          <div className="home-actions">
            <button className="mini" onClick={() => onNavigate('fleet')}>
              Fleet →
            </button>
          </div>
        </section>

        <section className="home-card">
          <div className="home-card-head">
            <h3>System</h3>
          </div>
          <div className="home-list">
            <div className="home-list-row">
              <span className="home-list-name">Output publishing</span>
              {(() => {
                const off = snapshot.events.filter((e) => !e.publishEnabled);
                return off.length === 0 ? (
                  <span className="fwd-ok">● on for all events</span>
                ) : (
                  <span className="tunnel-err">⛔ OFF: {off.map((e) => e.event.id).join(', ')}</span>
                );
              })()}
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
              <span className="home-list-name">Live races</span>
              <span className="dim">
                {snapshot.events.reduce((n, ev) => n + ev.races.filter((r) => r.status === 'live').length, 0)}
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
        </section>
      </div>
    </div>
  );
}

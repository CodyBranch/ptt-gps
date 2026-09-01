import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import type { DecoderPub, DecoderStatus } from '../types';
import type { ConfirmRequest } from './Confirm';
import { DecoderMap } from './MapView';
import { cachedPlace, reverseGeocodeAll } from '../geocode';

const fmtAge = (ms?: number) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/**
 * When RaceResult last heard from the box.
 *
 * This is the one date that distinguishes a box parked in the van since March
 * from one that dropped out ten minutes ago. Recent times read as an age
 * because that is how you think about them mid-meet; anything older reads as a
 * date, because "at 14 weeks ago" means nothing.
 *
 * Unset clocks come back as year 1, so anything before 2000 is treated as
 * never rather than rendered as a date in antiquity.
 */
function lastOnline(received?: string): { text: string; title?: string } {
  if (!received) return { text: '—' };
  const t = Date.parse(received);
  if (!Number.isFinite(t) || new Date(t).getUTCFullYear() < 2000) return { text: '—' };
  const title = new Date(t).toLocaleString();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return { text: 'just now', title };
  if (s < 3600) return { text: `${Math.floor(s / 60)}m ago`, title };
  if (s < 86400) return { text: `${Math.floor(s / 3600)}h ago`, title };
  if (s < 86400 * 7) return { text: `${Math.floor(s / 86400)}d ago`, title };
  return { text: new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), title };
}

/**
 * RaceResult timing boxes — decoders, TrackBoxes and Ubidiums.
 *
 * These are the boxes on the course, not the trackers on the vehicles, but at
 * a meet it is the same question: is it up, where is it, and has it got power.
 * So it reads like the fleet page, with a map because "which corner is that
 * one on" is most of what you want to know.
 */
export function DecodersView({
  socket,
  admin,
  ask,
}: {
  socket: Socket | null;
  admin: boolean;
  ask: (req: ConfirmRequest) => void;
}) {
  const [decoders, setDecoders] = useState<DecoderPub[]>([]);
  const [status, setStatus] = useState<DecoderStatus>();
  const [hasKey, setHasKey] = useState(false);
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [places, setPlaces] = useState<Record<string, string>>({});
  const [, tick] = useState(0);

  const load = async () => {
    try {
      const r = await api.decoders();
      setDecoders(r.decoders ?? []);
      setStatus(r.status);
      if (admin) setHasKey(!!(await api.decoderSettings()).hasKey);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the server pushes a new list after every poll
  useEffect(() => {
    if (!socket) return;
    const onDecoders = (list: DecoderPub[]) => setDecoders(list);
    socket.on('decoders', onDecoders);
    return () => {
      socket.off('decoders', onDecoders);
    };
  }, [socket]);

  // "last seen" is a moving target; re-render so it stays honest
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  // Turn coordinates into somewhere you recognise. Only boxes that have moved
  // are looked up — the cache answers for the rest.
  useEffect(() => {
    const todo = decoders
      .filter((d) => d.lat !== undefined && d.lon !== undefined && !(d.lat === 0 && d.lon === 0))
      .map((d) => ({ id: d.deviceId, lat: d.lat!, lon: d.lon! }))
      .filter((p) => cachedPlace(p.lat, p.lon) === undefined);
    // whatever is already known can be shown at once
    setPlaces((prev) => {
      const next = { ...prev };
      for (const d of decoders) {
        if (d.lat === undefined || d.lon === undefined) continue;
        const hit = cachedPlace(d.lat, d.lon);
        if (hit) next[d.deviceId] = hit;
      }
      return next;
    });
    if (todo.length === 0) return;
    let live = true;
    void reverseGeocodeAll(todo, (id, place) => {
      if (live) setPlaces((prev) => ({ ...prev, [id]: place }));
    });
    return () => {
      live = false;
    };
  }, [decoders]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decoders.filter(
      (d) =>
        (showHidden ? true : !d.hidden) &&
        (!onlineOnly || d.connected) &&
        (!q || d.name.toLowerCase().includes(q) || d.deviceId.toLowerCase().includes(q) || d.type.toLowerCase().includes(q)),
    );
  }, [decoders, query, onlineOnly, showHidden]);

  // Counts and the map are about our own boxes; hidden ones are somebody else's.
  const ours = decoders.filter((d) => !d.hidden);
  const online = ours.filter((d) => d.connected).length;
  const hiddenCount = decoders.length - ours.length;

  const setHidden = async (deviceId: string, hidden: boolean) => {
    try {
      await api.setDecoderHidden(deviceId, hidden);
      setDecoders((prev) => prev.map((d) => (d.deviceId === deviceId ? { ...d, hidden } : d)));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Decoders</span>
        <span className="spacer" />
        <input
          className="fleet-search"
          placeholder="Search name, ID, type…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className={`mini ${onlineOnly ? 'on' : ''}`} onClick={() => setOnlineOnly(!onlineOnly)}>
          Online only
        </button>
        {(hiddenCount > 0 || showHidden) && (
          <button
            className={`mini ${showHidden ? 'on' : ''}`}
            title="Boxes hidden from this console — usually another timer's, in a shared account"
            onClick={() => setShowHidden(!showHidden)}
          >
            Hidden ({hiddenCount})
          </button>
        )}
        {admin && (
          <>
            <button
              className="mini"
              disabled={busy || !status?.configured}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.pollDecoders();
                  setDecoders(r.decoders ?? []);
                  setMsg('Polled RaceResult.');
                } catch (err) {
                  setMsg(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              ⟳ Poll now
            </button>
            <button className="mini primary" onClick={() => setSettingsOpen(true)}>
              ⚙ RaceResult
            </button>
          </>
        )}
      </div>

      <div className="wire-count">
        {status?.configured ? (
          <>
            {online} of {ours.length} online · polling every {status.intervalS}s · last poll{' '}
            {fmtAge(status.lastPollMs)}
            {status.enabled === false && <span className="warn-text"> · polling paused</span>}
            {status.lastError && <span className="warn-text"> · {status.lastError}</span>}
          </>
        ) : (
          <span className="dim">
            Not connected to RaceResult{admin ? ' — press ⚙ RaceResult to add an API key.' : '.'}
          </span>
        )}
        {msg && <span className="dim"> · {msg}</span>}
      </div>

      {ours.length > 0 && (
        <div className="decoder-map">
          <DecoderMap decoders={ours} selected={selected} onSelect={(id: string) => setSelected((c) => (c === id ? undefined : id))} />
        </div>
      )}

      <div className="setup-grid one-col">
        <section>
          <table className="setup-table fleet-table decoder-table">
            <thead>
              <tr>
                <th className="col-device">Device</th>
                <th className="col-type">Type</th>
                <th className="col-where">Location</th>
                <th className="col-batt">Battery</th>
                <th>Status</th>
                <th className="col-seen">Last online</th>
                {admin && <th className="col-hide"></th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr
                  key={d.deviceId}
                  className={`${d.deviceId === selected ? 'selected' : ''} ${d.hidden ? 'is-hidden' : ''}`}
                  onClick={() => setSelected((c) => (c === d.deviceId ? undefined : d.deviceId))}
                >
                  <td className="col-device">
                    <div className="t-label">
                      <span className={`decoder-dot ${d.connected ? 'on' : 'off'}`} />
                      {d.name}
                    </div>
                    <div className="t-imei">{d.deviceId}</div>
                  </td>
                  <td className="dim col-type">{d.type}</td>
                  <td className="col-where">
                    {d.lat === undefined || d.lon === undefined || (d.lat === 0 && d.lon === 0) ? (
                      <span className="dim">no position</span>
                    ) : (
                      <>
                        <div className="where-place">{places[d.deviceId] ?? '—'}</div>
                        <div className="where-coords mono">
                          {d.lat.toFixed(5)}, {d.lon.toFixed(5)}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="col-batt">
                    {d.battery === undefined ? (
                      <span className="dim">—</span>
                    ) : (
                      // dimmed when offline: the reading is from whenever the box
                      // last reported, which may be a year ago
                      <span
                        className={`batt ${d.battery < 20 ? 'low' : d.battery < 60 ? 'mid' : 'high'} ${
                          d.connected ? '' : 'stale'
                        }`}
                      >
                        <span className="batt-shell">
                          <span className="batt-fill" style={{ width: `${Math.min(100, Math.max(0, d.battery))}%` }} />
                        </span>
                        <span className="batt-pct">{Math.round(d.battery)}%</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`decoder-state ${d.connected ? 'on' : 'off'}`}>
                      {d.connected ? 'Online' : 'Offline'}
                    </span>
                    {/* These describe the box as it was when last heard from. On an
                        offline one that may be a year stale, so saying "timing" or
                        "on battery" would be asserting something we do not know. */}
                    {d.connected && (
                      <>
                        {d.inStandby && <span className="decoder-flag">standby</span>}
                        {d.hasPower === false && <span className="decoder-flag warn">on battery</span>}
                        {d.inTimingMode && <span className="decoder-flag ok">timing</span>}
                        {d.readerHealthy === false && <span className="decoder-flag bad">reader</span>}
                        {d.errorFlags && d.errorFlags !== '0' && (
                          <span className="decoder-flag bad" title="Error flags reported by the device">
                            err {d.errorFlags}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="dim col-seen" title={lastOnline(d.received).title}>
                    {d.connected ? <span className="ok-text">online now</span> : lastOnline(d.received).text}
                  </td>
                  {admin && (
                    <td className="col-hide">
                      <button
                        className="mini"
                        title={
                          d.hidden
                            ? 'Track this box again'
                            : 'Hide this box — it keeps coming back from the API but is not yours'
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void setHidden(d.deviceId, !d.hidden);
                        }}
                      >
                        {d.hidden ? '↩ Restore' : '✕ Hide'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={admin ? 7 : 6} className="dim">
                    {decoders.length === 0 ? 'No decoders yet.' : 'Nothing matches that filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>

      {settingsOpen && (
        <DecoderSettingsDialog
          status={status}
          hasKey={hasKey}
          ask={ask}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function DecoderSettingsDialog({
  status,
  hasKey,
  ask,
  onClose,
  onSaved,
}: {
  status?: DecoderStatus;
  hasKey: boolean;
  ask: (req: ConfirmRequest) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [customerId, setCustomerId] = useState(String(status?.customerId ?? ''));
  const [apiKey, setApiKey] = useState('');
  const [intervalS, setIntervalS] = useState(String(status?.intervalS ?? 60));
  const [enabled, setEnabled] = useState(status?.enabled ?? true);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(undefined);
    try {
      setMsg(await fn());
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-device" onClick={(e) => e.stopPropagation()}>
        <h3>RaceResult connection</h3>
        <p className="dialog-sub">
          Polls your RaceResult account for decoder, TrackBox and Ubidium status. The key is stored on the
          server and never sent back to this page.
        </p>

        <div className="dialog-row">
          <label>
            Customer ID
            <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} inputMode="numeric" />
          </label>
          <label>
            Poll every (s)
            <input value={intervalS} onChange={(e) => setIntervalS(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        <div className="dialog-row">
          <label>
            API key {hasKey && <span className="dim">— a key is stored; leave blank to keep it</span>}
            <input
              ref={keyRef}
              type="password"
              autoComplete="off"
              placeholder={hasKey ? '••••••••••••' : 'paste the RaceResult API key'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </label>
        </div>
        <label className="dialog-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Poll automatically
        </label>

        {msg && <p className="hint">{msg}</p>}

        <div className="dialog-actions">
          <button
            className="mini"
            disabled={busy || !customerId}
            onClick={() =>
              run(async () => {
                const r = await api.testDecoders({ customerId: Number(customerId), apiKey: apiKey || undefined });
                return `Connected — ${r.devices} device${r.devices === 1 ? '' : 's'} visible.`;
              })
            }
          >
            Test
          </button>
          {status?.configured && (
            <button
              className="mini danger"
              disabled={busy}
              onClick={() =>
                ask({
                  title: 'Disconnect RaceResult?',
                  body: 'Polling stops and the stored API key is deleted. The decoders already listed stay until they are polled again.',
                  confirmLabel: 'Disconnect',
                  danger: true,
                  onConfirm: async () => {
                    await api.disconnectDecoders();
                    onSaved();
                  },
                })
              }
            >
              Disconnect
            </button>
          )}
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button
            className="mini primary"
            disabled={busy || !customerId || (!hasKey && !apiKey)}
            onClick={() =>
              run(async () => {
                await api.saveDecoderSettings({
                  customerId: Number(customerId),
                  apiKey: apiKey || undefined,
                  intervalS: Number(intervalS),
                  enabled,
                });
                onSaved();
                return 'Saved.';
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

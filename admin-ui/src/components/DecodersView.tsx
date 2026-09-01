import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import type { DecoderPub, DecoderStatus } from '../types';
import type { ConfirmRequest } from './Confirm';
import { DecoderMap } from './MapView';

const fmtAge = (ms?: number) => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/**
 * Device clock against ours at the moment we asked — the drift that matters.
 *
 * Only meaningful while the box is online. For an offline one the reported
 * time is simply when it was last heard from, so the difference is days and
 * says nothing about its clock.
 */
function drift(d: DecoderPub): string | undefined {
  if (!d.connected) return undefined;
  if (!d.deviceTime || !d.requestTime) return undefined;
  const a = Date.parse(d.deviceTime);
  const b = Date.parse(d.requestTime);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  const secs = Math.round((a - b) / 1000);
  if (Math.abs(secs) < 1) return 'in step';
  return `${secs > 0 ? '+' : ''}${secs}s`;
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
  const [selected, setSelected] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decoders.filter(
      (d) =>
        (!onlineOnly || d.connected) &&
        (!q || d.name.toLowerCase().includes(q) || d.deviceId.toLowerCase().includes(q) || d.type.toLowerCase().includes(q)),
    );
  }, [decoders, query, onlineOnly]);

  const online = decoders.filter((d) => d.connected).length;

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
            {online} of {decoders.length} online · polling every {status.intervalS}s · last poll{' '}
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

      {decoders.length > 0 && (
        <div className="decoder-map">
          <DecoderMap decoders={decoders} selected={selected} onSelect={(id: string) => setSelected((c) => (c === id ? undefined : id))} />
        </div>
      )}

      <div className="setup-grid one-col">
        <section>
          <table className="setup-table fleet-table decoder-table">
            <thead>
              <tr>
                <th className="col-device">Device</th>
                <th className="col-type">Type</th>
                <th className="col-batt">Battery</th>
                <th>Status</th>
                <th className="col-clock">Clock</th>
                <th className="col-seen">Last poll</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr
                  key={d.deviceId}
                  className={d.deviceId === selected ? 'selected' : ''}
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
                  <td className="col-batt">
                    {d.battery === undefined ? (
                      <span className="dim">—</span>
                    ) : (
                      <span className={`batt ${d.battery < 20 ? 'low' : d.battery < 60 ? 'mid' : 'high'}`}>
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
                    {d.inStandby && <span className="decoder-flag">standby</span>}
                    {d.hasPower === false && <span className="decoder-flag warn">on battery</span>}
                    {d.inTimingMode && <span className="decoder-flag ok">timing</span>}
                    {d.readerHealthy === false && <span className="decoder-flag bad">reader</span>}
                    {d.errorFlags && d.errorFlags !== '0' && (
                      <span className="decoder-flag bad" title="Error flags reported by the device">
                        err {d.errorFlags}
                      </span>
                    )}
                  </td>
                  <td className="col-clock dim" title={`device ${d.deviceTime ?? '—'} / asked ${d.requestTime ?? '—'}`}>
                    {drift(d) ?? '—'}
                  </td>
                  <td className="dim col-seen">{fmtAge(d.seenMs)}</td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="dim">
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

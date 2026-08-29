import { useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import { MiniMap } from './MapView';
import type { DeviceAssignment, DeviceIssue, DeviceRow, FleetRow, Owner } from '../types';

/**
 * Fleet page: the permanent tracker inventory — shared by every event.
 * Rows are read-only; View opens live location/health, Edit opens the edit
 * modal, and Add a device is a modal too. Latest ping shows for every device
 * whether or not it is in any event.
 */
export function FleetView({ readonly }: { readonly: boolean }) {
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [newOwner, setNewOwner] = useState('');
  const [historyImei, setHistoryImei] = useState<string>();
  const [detailImei, setDetailImei] = useState<string>();
  const [editImei, setEditImei] = useState<string>(); // '' = new device
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();

  const reload = () => {
    api.fleet().then(setFleet).catch(console.error);
    api.owners().then(setOwners).catch(console.error);
    api.devices().then(setDevices).catch(console.error);
  };
  useEffect(reload, []);

  // live refresh while the detail dialog is open (position/battery/ping follow)
  useEffect(() => {
    if (detailImei === undefined) return;
    const t = setInterval(() => api.fleet().then(setFleet).catch(console.error), 5000);
    return () => clearInterval(t);
  }, [detailImei]);

  const fleetImeis = new Set(fleet.map((f) => f.imei));
  const fleetByImei = new Map(fleet.map((f) => [f.imei, f]));
  const fmtSeen = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

  const detail = detailImei !== undefined ? fleetByImei.get(detailImei) : undefined;
  const editing = editImei !== undefined && editImei !== '' ? fleetByImei.get(editImei) : undefined;

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Tracker fleet</span>
        {msg && <span className={`setup-msg ${msg.kind}`}>{msg.text}</span>}
        <span className="spacer" />
        {!readonly && (
          <button className="mini primary" onClick={() => setEditImei('')}>
            + Add device
          </button>
        )}
      </div>
      <div className="setup-grid one-col">
        <section>
          <table className="setup-table fleet-table">
            <thead>
              <tr><th>Device</th><th>Model</th><th>Owner</th><th>Battery</th><th>Latest ping</th><th>Events</th><th></th></tr>
            </thead>
            <tbody>
              {fleet.map((f) => (
                <tr key={f.imei} className={f.retired ? 'retired-row' : ''} onClick={() => setDetailImei(f.imei)}>
                  <td>
                    <div className="t-label">
                      {f.label}
                      {f.retired ? <span className="dim"> (retired)</span> : ''}
                    </div>
                    <div className="t-imei">{f.imei}</div>
                  </td>
                  <td className="dim">{f.model ?? '—'}</td>
                  <td className="dim">{f.owner ?? '—'}</td>
                  <td>
                    <FleetBattery row={f} />
                  </td>
                  <td className="dim ping-cell">{fmtSeen(f.last_received_ms)}</td>
                  <td className="events-cell">
                    {f.events.length === 0 && <span className="dim">—</span>}
                    {f.events.map((e) => (
                      <span key={e.id} className={`event-badge ${e.active ? 'active' : ''}`} title={e.name}>
                        {e.id}
                      </span>
                    ))}
                    {f.events.length > 1 && (
                      <span className="multi-event-warn" title={`In ${f.events.length} events: ${f.events.map((e) => e.name).join(', ')}`}>
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="fleet-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="mini" title="Live location & details" onClick={() => setDetailImei(f.imei)}>
                      👁 View
                    </button>
                    <button
                      className={`mini ${f.openIssues > 0 ? 'has-issues' : ''}`}
                      title={f.openIssues > 0 ? `${f.openIssues} open issue(s)` : 'History & issue log'}
                      onClick={() => setHistoryImei(f.imei)}
                    >
                      {f.openIssues > 0 ? `🔧${f.openIssues}` : '🕘'}
                    </button>
                    {!readonly && (
                      <button className="mini" onClick={() => setEditImei(f.imei)}>
                        ✎ Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!readonly && (
            <>
              <h4>Owners</h4>
              <div className="owner-chips">
                {owners.map((o) => (
                  <span className="chip" key={o.id}>
                    {o.name}
                    <button
                      title="Remove (only when no devices are linked)"
                      onClick={async () => {
                        try {
                          await api.deleteOwner(o.id);
                          setOwners(await api.owners());
                        } catch (err) {
                          setMsg({ kind: 'err', text: (err as Error).message });
                        }
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <input className="w-owner" value={newOwner} placeholder="New owner…" onChange={(e) => setNewOwner(e.target.value)} />
                <button
                  className="mini"
                  disabled={!newOwner.trim()}
                  onClick={async () => {
                    try {
                      await api.addOwner(newOwner);
                      setNewOwner('');
                      setOwners(await api.owners());
                    } catch (err) {
                      setMsg({ kind: 'err', text: (err as Error).message });
                    }
                  }}
                >
                  + Add
                </button>
              </div>

              {devices.filter((dv) => !fleetImeis.has(dv.imei)).length > 0 && (
                <>
                  <h4>Seen on the wire, not in the fleet</h4>
                  <table className="setup-table dim-table">
                    <tbody>
                      {devices
                        .filter((dv) => !fleetImeis.has(dv.imei))
                        .map((dv) => (
                          <tr key={dv.imei}>
                            <td className="mono">{dv.imei}</td>
                            <td>{dv.protocol}</td>
                            <td>{dv.battery != null ? `${dv.battery}%` : ''}</td>
                            <td>{fmtSeen(dv.last_received_ms)}</td>
                            <td>
                              <button
                                className="mini"
                                onClick={async () => {
                                  try {
                                    await api.saveFleet({ imei: dv.imei, label: dv.imei, hasBattery: true, retired: false });
                                    reload();
                                  } catch (err) {
                                    setMsg({ kind: 'err', text: (err as Error).message });
                                  }
                                }}
                              >
                                + To fleet
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </section>
      </div>

      {detail && (
        <DeviceDetailDialog
          row={detail}
          readonly={readonly}
          onClose={() => setDetailImei(undefined)}
          onEdit={() => {
            setDetailImei(undefined);
            setEditImei(detail.imei);
          }}
          onHistory={() => {
            setDetailImei(undefined);
            setHistoryImei(detail.imei);
          }}
        />
      )}

      {editImei !== undefined && (
        <DeviceEditDialog
          existing={editing}
          owners={owners}
          takenImeis={fleetImeis}
          onClose={() => setEditImei(undefined)}
          onSaved={(label) => {
            setEditImei(undefined);
            setMsg({ kind: 'ok', text: `Device ${label} saved.` });
            reload();
          }}
          onError={(text) => setMsg({ kind: 'err', text })}
        />
      )}

      {historyImei && (
        <DeviceHistoryDialog
          imei={historyImei}
          label={fleetByImei.get(historyImei)?.label ?? historyImei}
          readonly={readonly}
          onClose={() => setHistoryImei(undefined)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

/** Battery bar for a fleet row (uses the last battery seen on the wire). */
function FleetBattery({ row }: { row: FleetRow }) {
  if (!row.hasBattery) return <span className="batt-ext" title="Vehicle powered">EXT</span>;
  const pct = row.seen_battery;
  if (pct == null) return <span className="dim">—</span>;
  const cls = pct < 20 ? 'low' : pct < 60 ? 'mid' : 'high';
  return (
    <span className={`batt ${cls}`} title={`${pct}% at last ping`}>
      <span className="batt-shell">
        <span className="batt-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="batt-pct">{Math.round(pct)}%</span>
    </span>
  );
}

/** Live device view: location map, coordinates, battery, ping age. */
function DeviceDetailDialog({
  row,
  readonly,
  onClose,
  onEdit,
  onHistory,
}: {
  row: FleetRow;
  readonly: boolean;
  onClose: () => void;
  onEdit: () => void;
  onHistory: () => void;
}) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(() => tick(), 1000);
    return () => clearInterval(t);
  }, []);

  const ageS = row.last_received_ms ? Math.max(0, Math.round((Date.now() - row.last_received_ms) / 1000)) : undefined;
  const fmtAge =
    ageS === undefined ? 'never heard from' : ageS < 60 ? `${ageS}s ago` : ageS < 3600 ? `${Math.floor(ageS / 60)}m ${ageS % 60}s ago` : `${Math.floor(ageS / 3600)}h+ ago`;
  const hasPos = row.last_lat != null && row.last_lon != null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-device" onClick={(e) => e.stopPropagation()}>
        <h3>
          {row.label} <span className="mono dim">{row.imei}</span>
          {row.retired ? <span className="clamp-badge">RETIRED</span> : null}
        </h3>

        <div className="window-stats">
          <div className="window-stat">
            <span className="window-stat-label">Model</span>
            <span className="window-stat-value">{row.model ?? '—'}</span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Owner</span>
            <span className="window-stat-value">{row.owner ?? '—'}</span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Battery</span>
            <span className="window-stat-value">
              <FleetBattery row={row} />
            </span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Last ping</span>
            <span className={`window-stat-value ${ageS !== undefined && ageS < 60 ? 'fwd-ok' : ''}`}>{fmtAge}</span>
          </div>
        </div>

        {hasPos ? (
          <>
            <MiniMap lat={row.last_lat!} lon={row.last_lon!} />
            <div className="device-coords">
              <span className="mono">
                {row.last_lat!.toFixed(6)}, {row.last_lon!.toFixed(6)}
              </span>
              <button
                className="mini"
                onClick={() => navigator.clipboard?.writeText(`${row.last_lat}, ${row.last_lon}`).catch(() => {})}
              >
                Copy
              </button>
              <a
                className="mini export-link"
                href={`https://maps.google.com/maps?z=15&t=m&q=loc:${row.last_lat}+${row.last_lon}`}
                target="_blank"
                rel="noreferrer"
              >
                Google Maps ↗
              </a>
            </div>
            <p className="hint">Position and battery refresh automatically while this is open.</p>
          </>
        ) : (
          <p className="hint">No position reported yet — the map appears after the device's first ping.</p>
        )}

        {row.notes && <p className="device-notes">📝 {row.notes}</p>}

        <div className="dialog-actions">
          <button className="mini" onClick={onHistory}>
            🕘 History{row.openIssues > 0 ? ` · 🔧${row.openIssues}` : ''}
          </button>
          {!readonly && (
            <button className="mini" onClick={onEdit}>
              ✎ Edit
            </button>
          )}
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Add / edit a fleet device. */
function DeviceEditDialog({
  existing,
  owners,
  takenImeis,
  onClose,
  onSaved,
  onError,
}: {
  existing?: FleetRow;
  owners: Owner[];
  takenImeis: Set<string>;
  onClose: () => void;
  onSaved: (label: string) => void;
  onError: (text: string) => void;
}) {
  const isNew = !existing;
  const [imei, setImei] = useState(existing?.imei ?? '');
  const [label, setLabel] = useState(existing?.label ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [ownerId, setOwnerId] = useState(existing?.ownerId != null ? String(existing.ownerId) : '');
  const [hasBattery, setHasBattery] = useState(existing ? !!existing.hasBattery : true);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [retired, setRetired] = useState(existing ? !!existing.retired : false);

  const imeiOk = /^\d{15}$/.test(imei);
  const duplicate = isNew && imeiOk && takenImeis.has(imei);
  const valid = imeiOk && !duplicate && label.trim().length > 0;

  const save = async () => {
    try {
      await api.saveFleet({
        imei,
        label: label.trim(),
        model: model || null,
        hasBattery,
        notes: notes.trim() || null,
        ownerId: ownerId === '' ? null : Number(ownerId),
        retired,
      });
      onSaved(label.trim());
    } catch (err) {
      onError((err as Error).message);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-device" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? 'Add a device' : `Edit ${existing!.label}`}</h3>
        <div className="dialog-row">
          <label>
            IMEI (15 digits)
            <input
              value={imei}
              disabled={!isNew}
              onChange={(e) => setImei(e.target.value.replace(/\D/g, ''))}
              placeholder="015181000128000"
              autoFocus={isNew}
            />
          </label>
          <label>
            Label (general name)
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GL300 #7" autoFocus={!isNew} />
          </label>
        </div>
        <div className="dialog-row">
          <label>
            Model
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">—</option>
              <option value="GL300">GL300</option>
              <option value="GL320">GL320</option>
              <option value="GL30">GL30</option>
              <option value="GV500CNA">GV500CNA</option>
              <option value="other">other</option>
            </select>
          </label>
          <label>
            Owner
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">—</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="dialog-check">
          <input type="checkbox" checked={hasBattery} onChange={(e) => setHasBattery(e.target.checked)} />
          Battery powered (uncheck for in-car units like the GV500)
        </label>
        <div className="dialog-row">
          <label>
            Notes
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. purchased 2026, spare antenna" />
          </label>
        </div>
        {!isNew && (
          <label className="dialog-check">
            <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} />
            Retired (kept in history, hidden from event pickers)
          </label>
        )}
        {duplicate && <p className="dialog-error">That IMEI is already in the fleet.</p>}
        {imei !== '' && !imeiOk && <p className="hint">IMEI must be exactly 15 digits ({imei.length} so far).</p>}
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button className="mini primary" disabled={!valid} onClick={save}>
            {isNew ? '+ Add device' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeviceHistoryDialog({
  imei,
  label,
  readonly,
  onClose,
  onChanged,
}: {
  imei: string;
  label: string;
  readonly?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [assignments, setAssignments] = useState<DeviceAssignment[]>([]);
  const [issues, setIssues] = useState<DeviceIssue[]>([]);
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState<'note' | 'issue' | 'fault'>('issue');
  const [err, setErr] = useState<string>();

  const load = () =>
    api
      .fleetHistory(imei)
      .then((h: { assignments: DeviceAssignment[]; issues: DeviceIssue[] }) => {
        setAssignments(h.assignments);
        setIssues(h.issues);
      })
      .catch((e) => setErr((e as Error).message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imei]);

  const fmt = (ms: number) => new Date(ms).toLocaleString();
  const open = issues.filter((i) => i.resolved_ms === null);
  const closed = issues.filter((i) => i.resolved_ms !== null);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-history" onClick={(e) => e.stopPropagation()}>
        <h3>
          {label} <span className="mono dim">{imei}</span>
        </h3>
        {err && <p className="dialog-error">{err}</p>}

        {!readonly && (
          <>
            <h4>Log an issue</h4>
            <div className="form-row">
              <label>
                Severity
                <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
                  <option value="note">note</option>
                  <option value="issue">issue</option>
                  <option value="fault">fault</option>
                </select>
              </label>
              <label>
                What happened
                <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. battery drains fast in cold" />
              </label>
              <button
                className="mini primary self-end"
                disabled={!text.trim()}
                onClick={async () => {
                  try {
                    await api.addIssue(imei, text, severity);
                    setText('');
                    await load();
                    onChanged();
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                + Log
              </button>
            </div>
          </>
        )}

        {open.length > 0 && (
          <>
            <h4>Open issues</h4>
            {open.map((i) => (
              <div className="issue-row" key={i.id}>
                <span className={`issue-sev ${i.severity}`}>{i.severity}</span>
                <span className="issue-text">{i.text}</span>
                <span className="dim">
                  {fmt(i.t_ms)}
                  {i.by ? ` · ${i.by}` : ''}
                </span>
                {!readonly && (
                  <button
                    className="mini"
                    onClick={async () => {
                      try {
                        await api.resolveIssue(i.id);
                        await load();
                        onChanged();
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  >
                    Resolve
                  </button>
                )}
              </div>
            ))}
          </>
        )}

        {closed.length > 0 && (
          <>
            <h4>Resolved issues</h4>
            {closed.map((i) => (
              <div className="issue-row resolved" key={i.id}>
                <span className={`issue-sev ${i.severity}`}>{i.severity}</span>
                <span className="issue-text">{i.text}</span>
                <span className="dim">
                  {fmt(i.t_ms)} → {fmt(i.resolved_ms!)}
                  {i.resolved_by ? ` by ${i.resolved_by}` : ''}
                </span>
              </div>
            ))}
          </>
        )}

        <h4>Event assignment history</h4>
        {assignments.length === 0 && <p className="hint">No recorded assignments yet — changes made from Setup are logged from here on.</p>}
        {assignments.map((a) => (
          <div className="issue-row" key={a.id}>
            <span className={`assign-action ${a.action}`}>{a.action === 'added' ? '＋' : '－'}</span>
            <span className="issue-text">{a.event_name ?? a.event_id}</span>
            <span className="dim">
              {fmt(a.t_ms)}
              {a.by ? ` · ${a.by}` : ''}
            </span>
          </div>
        ))}

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

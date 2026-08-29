import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DeviceAssignment, DeviceIssue, DeviceRow, FleetRow, Owner } from '../types';

/**
 * Fleet page: the permanent tracker inventory — shared by every event.
 * Latest ping (with locate link) shows for every device whether or not it is
 * in any event; the Events column shows memberships with the active ones
 * highlighted and a warning when a device is in more than one event.
 */
export function FleetView({ readonly }: { readonly: boolean }) {
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [owners, setOwners] = useState<Owner[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [newOwner, setNewOwner] = useState('');
  const [historyImei, setHistoryImei] = useState<string>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();

  const reload = () => {
    api.fleet().then(setFleet).catch(console.error);
    api.owners().then(setOwners).catch(console.error);
    api.devices().then(setDevices).catch(console.error);
  };
  useEffect(reload, []);

  const saveFleetRow = async (row: FleetRow) => {
    try {
      await api.saveFleet({
        imei: row.imei,
        label: row.label,
        model: row.model,
        hasBattery: !!row.hasBattery,
        notes: row.notes,
        ownerId: row.ownerId,
        retired: !!row.retired,
      });
      setMsg({ kind: 'ok', text: `Fleet tracker ${row.label || row.imei} saved.` });
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const fleetImeis = new Set(fleet.map((f) => f.imei));
  const fleetByImei = new Map(fleet.map((f) => [f.imei, f]));
  const fmtSeen = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Tracker fleet</span>
        {msg && <span className={`setup-msg ${msg.kind}`}>{msg.text}</span>}
        <span className="spacer" />
      </div>
      <div className="setup-grid one-col">
        <section>
          <table className="setup-table">
            <thead>
              <tr><th>Label</th><th>IMEI</th><th>Model</th><th>Owner</th><th>Batt</th><th>Latest ping</th><th>Events</th><th></th></tr>
            </thead>
            <tbody>
              {fleet.map((f, i) => (
                <tr key={f.imei} className={f.retired ? 'retired-row' : ''}>
                  <td>
                    <input
                      disabled={readonly}
                      value={f.label}
                      onChange={(e) => setFleet(fleet.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    />
                  </td>
                  <td className="mono">{f.imei}</td>
                  <td>
                    <input
                      className="w-num"
                      disabled={readonly}
                      value={f.model ?? ''}
                      placeholder="GL300"
                      onChange={(e) => setFleet(fleet.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))}
                    />
                  </td>
                  <td>
                    <select
                      className="w-owner"
                      disabled={readonly}
                      value={f.ownerId ?? ''}
                      onChange={(e) =>
                        setFleet(
                          fleet.map((x, j) =>
                            j === i ? { ...x, ownerId: e.target.value === '' ? null : Number(e.target.value) } : x,
                          ),
                        )
                      }
                    >
                      <option value="">—</option>
                      {owners.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      disabled={readonly}
                      checked={!!f.hasBattery}
                      title="Uncheck for vehicle-powered units"
                      onChange={(e) =>
                        setFleet(fleet.map((x, j) => (j === i ? { ...x, hasBattery: e.target.checked ? 1 : 0 } : x)))
                      }
                    />
                  </td>
                  <td className="dim ping-cell">
                    {fmtSeen(f.last_received_ms)}
                    {f.seen_battery != null ? ` · ${f.seen_battery}%` : ''}
                    {f.last_lat != null && f.last_lon != null && (
                      <a
                        className="locate-link"
                        href={`https://maps.google.com/maps?z=14&t=m&q=loc:${f.last_lat}+${f.last_lon}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`Locate: ${f.last_lat}, ${f.last_lon}`}
                      >
                        📍
                      </a>
                    )}
                  </td>
                  <td className="events-cell">
                    {f.events.length === 0 && <span className="dim">—</span>}
                    {f.events.map((e) => (
                      <span key={e.id} className={`event-badge ${e.active ? 'active' : ''}`} title={e.name}>
                        {e.id}
                      </span>
                    ))}
                    {f.events.length > 1 && (
                      <span
                        className="multi-event-warn"
                        title={`In ${f.events.length} events: ${f.events.map((e) => e.name).join(', ')}`}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="fleet-actions">
                    <button
                      className={`mini ${f.openIssues > 0 ? 'has-issues' : ''}`}
                      title={f.openIssues > 0 ? `${f.openIssues} open issue(s)` : 'History & issue log'}
                      onClick={() => setHistoryImei(f.imei)}
                    >
                      {f.openIssues > 0 ? `🔧${f.openIssues}` : '🕘'}
                    </button>
                    {!readonly && (
                      <>
                        <button className="mini" onClick={() => saveFleetRow(f)}>
                          Save
                        </button>
                        <button
                          className="mini"
                          title={f.retired ? 'Return to service' : 'Retire (kept in history, hidden from pickers)'}
                          onClick={() => saveFleetRow({ ...f, retired: f.retired ? 0 : 1 })}
                        >
                          {f.retired ? 'Unretire' : 'Retire'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {!readonly && (
            <>
              <NewFleetRow owners={owners} existing={fleetImeis} onSaved={reload} onMsg={setMsg} />

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

interface NewDevice {
  imei: string;
  label: string;
  model: string | null;
  ownerId: number | null;
  hasBattery: number;
  notes: string | null;
}

function NewFleetRow({
  owners,
  existing,
  onSaved,
  onMsg,
}: {
  owners: Owner[];
  existing: Set<string>;
  onSaved: () => void;
  onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  const [imei, setImei] = useState('');
  const [label, setLabel] = useState('');
  const [model, setModel] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [hasBattery, setHasBattery] = useState(true);
  const [notes, setNotes] = useState('');

  const imeiOk = /^\d{15}$/.test(imei);
  const duplicate = imeiOk && existing.has(imei);
  const valid = imeiOk && !duplicate && label.trim().length > 0;

  const add = async (d: NewDevice) => {
    try {
      await api.saveFleet({
        imei: d.imei,
        label: d.label,
        model: d.model,
        hasBattery: !!d.hasBattery,
        notes: d.notes,
        ownerId: d.ownerId,
        retired: false,
      });
      onMsg({ kind: 'ok', text: `Device ${d.label} added to the fleet.` });
      onSaved();
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <div className="new-device-form">
      <h4>Add a device</h4>
      <div className="form-row">
        <label>
          IMEI (15 digits)
          <input
            className="w-imei"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/\D/g, ''))}
            placeholder="015181000128000"
          />
        </label>
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GL300 #7" />
        </label>
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
      <div className="form-row">
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. purchased 2026, spare antenna" />
        </label>
        <label className="check-inline">
          <input type="checkbox" checked={hasBattery} onChange={(e) => setHasBattery(e.target.checked)} />
          Battery powered (uncheck for in-car units)
        </label>
        <button
          className="mini primary self-end"
          disabled={!valid}
          onClick={() => {
            add({
              imei,
              label: label.trim(),
              model: model || null,
              ownerId: ownerId === '' ? null : Number(ownerId),
              hasBattery: hasBattery ? 1 : 0,
              notes: notes.trim() || null,
            });
            setImei('');
            setLabel('');
            setModel('');
            setOwnerId('');
            setHasBattery(true);
            setNotes('');
          }}
        >
          + Add device
        </button>
      </div>
      {duplicate && <p className="dialog-error">That IMEI is already in the fleet.</p>}
      {imei !== '' && !imeiOk && <p className="hint">IMEI must be exactly 15 digits ({imei.length} so far).</p>}
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

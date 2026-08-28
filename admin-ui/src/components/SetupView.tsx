import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { CourseInfo, DeviceRow, EventConfigT, FleetRow, UserRow } from '../types';

/**
 * Event setup.
 * The fleet registry (tracker inventory) is persistent and event-independent —
 * edits there save immediately. The event sections (what we're tracking, which
 * fleet trackers are matched to it, races/courses) edit the event config and
 * apply on "Save & rebuild"; the server refuses while a race is armed or live.
 */
export function SetupView({ ask, onSaved }: { ask: (req: ConfirmRequest) => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<EventConfigT>();
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const reloadFleet = () => {
    api.fleet().then(setFleet).catch(console.error);
    api.devices().then(setDevices).catch(console.error);
    api.users().then(setUsers).catch(console.error);
  };
  const reload = () => {
    api.getConfig().then((c) => {
      setCfg(c);
      setDirty(false);
    }).catch(console.error);
    api.courses().then(setCourses).catch(console.error);
    reloadFleet();
  };
  useEffect(reload, []);

  if (!cfg) return <div className="loading">Loading setup…</div>;

  const edit = (fn: (c: EventConfigT) => void) => {
    const next = structuredClone(cfg);
    fn(next);
    setCfg(next);
    setDirty(true);
    setMsg(undefined);
  };

  const save = async () => {
    try {
      await api.putConfig(cfg);
      setDirty(false);
      setMsg({ kind: 'ok', text: 'Saved — engines rebuilt.' });
      onSaved();
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const uploadCourse = async (file: File) => {
    try {
      const text = await file.text();
      const res = await api.uploadCourse(file.name.replace(/\.kml$/i, ''), text);
      setMsg({ kind: 'ok', text: `Course ${res.file}: ${res.lengthMi.toFixed(2)} mi, ${res.points} points` });
      setCourses(await api.courses());
    } catch (err) {
      setMsg({ kind: 'err', text: `Course upload failed: ${(err as Error).message}` });
    }
  };

  const saveFleetRow = async (row: FleetRow) => {
    try {
      await api.saveFleet({
        imei: row.imei,
        label: row.label,
        model: row.model,
        hasBattery: !!row.hasBattery,
        notes: row.notes,
        retired: !!row.retired,
      });
      setMsg({ kind: 'ok', text: `Fleet tracker ${row.label || row.imei} saved.` });
      reloadFleet();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const rosterImeis = new Set(cfg.trackers.map((t) => t.imei));
  const fleetImeis = new Set(fleet.map((f) => f.imei));
  const fleetByImei = new Map(fleet.map((f) => [f.imei, f]));

  /** Add a fleet tracker to the event roster (label/battery from the registry). */
  const addToRoster = (c: EventConfigT, imei: string) => {
    if (c.trackers.some((t) => t.imei === imei)) return;
    const f = fleetByImei.get(imei);
    c.trackers.push({ imei, label: f?.label ?? imei, hasBattery: f ? !!f.hasBattery : true });
  };

  const fmtSeen = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

  const courseFor = (file: string) => courses.find((k) => k.file === file);

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Event setup</span>
        {msg && <span className={`setup-msg ${msg.kind}`}>{msg.text}</span>}
        <span className="spacer" />
        <button className="mini" onClick={reload} disabled={!dirty}>
          Discard changes
        </button>
        <button className="mini primary" onClick={save} disabled={!dirty}>
          Save & rebuild
        </button>
      </div>

      <div className="setup-grid">
        <section>
          <h3>Tracker fleet</h3>
          <p className="hint">The permanent inventory — shared by every event. Edits save immediately.</p>
          <table className="setup-table">
            <thead>
              <tr><th>Label</th><th>IMEI</th><th>Model</th><th>Batt</th><th>Last seen</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {fleet.map((f, i) => (
                <tr key={f.imei} className={f.retired ? 'retired-row' : ''}>
                  <td>
                    <input
                      value={f.label}
                      onChange={(e) => setFleet(fleet.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    />
                  </td>
                  <td className="mono">{f.imei}</td>
                  <td>
                    <input
                      className="w-num"
                      value={f.model ?? ''}
                      placeholder="GL300"
                      onChange={(e) => setFleet(fleet.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))}
                    />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={!!f.hasBattery}
                      title="Uncheck for vehicle-powered units"
                      onChange={(e) => setFleet(fleet.map((x, j) => (j === i ? { ...x, hasBattery: e.target.checked ? 1 : 0 } : x)))}
                    />
                  </td>
                  <td className="dim">
                    {fmtSeen(f.last_received_ms)}
                    {f.seen_battery != null ? ` · ${f.seen_battery}%` : ''}
                  </td>
                  <td>
                    <button className="mini" onClick={() => saveFleetRow(f)}>Save</button>
                  </td>
                  <td>
                    <button
                      className="mini"
                      title={f.retired ? 'Return to service' : 'Retire (kept in history, hidden from pickers)'}
                      onClick={() => saveFleetRow({ ...f, retired: f.retired ? 0 : 1 })}
                    >
                      {f.retired ? 'Unretire' : 'Retire'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <NewFleetRow onAdd={(imei, label) => saveFleetRow({ imei, label, model: null, hasBattery: 1, notes: null, retired: 0, seen_battery: null, last_received_ms: null, last_t_utc_ms: null, protocol: null })} />

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
                            onClick={() =>
                              saveFleetRow({ imei: dv.imei, label: dv.imei, model: null, hasBattery: 1, notes: null, retired: 0, seen_battery: null, last_received_ms: null, last_t_utc_ms: null, protocol: null })
                            }
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
        </section>

        <section>
          <h3>Event</h3>
          <div className="form-row">
            <label>
              Name
              <input value={cfg.name} onChange={(e) => edit((c) => (c.name = e.target.value))} />
            </label>
            <label>
              Meet ID
              <input
                value={cfg.meetId}
                inputMode="numeric"
                onChange={(e) => edit((c) => (c.meetId = Number(e.target.value) || 0))}
              />
            </label>
            <label>
              Output units (Firebase)
              <select
                value={cfg.outputUnits}
                onChange={(e) => edit((c) => (c.outputUnits = e.target.value as EventConfigT['outputUnits']))}
              >
                <option value="miles">miles</option>
                <option value="kilometers">kilometers</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Report interval (s)
              <input
                value={cfg.reportIntervalS ?? 10}
                inputMode="numeric"
                title="Expected tracker report cadence — drives the age coloring"
                onChange={(e) => edit((c) => (c.reportIntervalS = Number(e.target.value) || 10))}
              />
            </label>
            <label>
              Window back (min inc)
              <input
                value={cfg.snapDefaults.minInc}
                inputMode="decimal"
                onChange={(e) => edit((c) => (c.snapDefaults.minInc = Number(e.target.value) || 0.2))}
              />
            </label>
            <label>
              Window ahead (max inc)
              <input
                value={cfg.snapDefaults.maxInc}
                inputMode="decimal"
                onChange={(e) => edit((c) => (c.snapDefaults.maxInc = Number(e.target.value) || 1))}
              />
            </label>
            <label>
              Initial window
              <input
                value={cfg.snapDefaults.initialMax}
                inputMode="decimal"
                onChange={(e) => edit((c) => (c.snapDefaults.initialMax = Number(e.target.value) || 0.5))}
              />
            </label>
          </div>
        </section>

        <section>
          <h3>What we're tracking</h3>
          <p className="hint">
            Define the roles for this event, then match each to fleet trackers — ★ first is the primary,
            the rest are failover backups in order.
          </p>
          {cfg.roles.map((role, ri) => (
            <div className="role-edit" key={ri}>
              <div className="form-row">
                <label>
                  Key
                  <input value={role.key} onChange={(e) => edit((c) => (c.roles[ri].key = e.target.value))} />
                </label>
                <label>
                  Label
                  <input value={role.label} onChange={(e) => edit((c) => (c.roles[ri].label = e.target.value))} />
                </label>
                <label>
                  Map cmd
                  <input
                    className="w-num"
                    value={role.cmd ?? ''}
                    onChange={(e) =>
                      edit((c) => (c.roles[ri].cmd = e.target.value === '' ? undefined : Number(e.target.value)))
                    }
                  />
                </label>
                <label>
                  Clock slot
                  <input
                    className="w-num"
                    value={role.clockSlot ?? ''}
                    onChange={(e) =>
                      edit((c) => (c.roles[ri].clockSlot = e.target.value === '' ? undefined : Number(e.target.value)))
                    }
                  />
                </label>
                <label>
                  Map event
                  <input
                    value={role.mapEvent ?? ''}
                    onChange={(e) => edit((c) => (c.roles[ri].mapEvent = e.target.value || undefined))}
                  />
                </label>
                <button className="mini danger self-end" onClick={() => edit((c) => c.roles.splice(ri, 1))}>
                  ✕
                </button>
              </div>
              <div className="role-trackers-edit">
                {role.trackers.map((imei, ti) => {
                  const t = cfg.trackers.find((x) => x.imei === imei);
                  return (
                    <span className="chip" key={imei}>
                      {ti === 0 ? '★ ' : ''}
                      {t?.label ?? imei}
                      {ti > 0 && (
                        <button
                          title="Move up (first = primary)"
                          onClick={() =>
                            edit((c) => {
                              const arr = c.roles[ri].trackers;
                              [arr[ti - 1], arr[ti]] = [arr[ti], arr[ti - 1]];
                            })
                          }
                        >
                          ↑
                        </button>
                      )}
                      <button onClick={() => edit((c) => c.roles[ri].trackers.splice(ti, 1))}>✕</button>
                    </span>
                  );
                })}
                <select
                  value=""
                  onChange={(e) => {
                    const imei = e.target.value;
                    if (imei) {
                      edit((c) => {
                        addToRoster(c, imei); // matching a fleet tracker pulls it into the event roster
                        c.roles[ri].trackers.push(imei);
                      });
                    }
                  }}
                >
                  <option value="">+ match tracker…</option>
                  {fleet
                    .filter((f) => !f.retired && !role.trackers.includes(f.imei))
                    .map((f) => (
                      <option key={f.imei} value={f.imei}>
                        {f.label}{rosterImeis.has(f.imei) ? '' : ' (fleet)'}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          ))}
          <button
            className="mini"
            onClick={() => edit((c) => c.roles.push({ key: '', label: '', trackers: [] }))}
          >
            + Add role
          </button>
        </section>

        <section>
          <h3>Event roster</h3>
          <p className="hint">Fleet trackers matched to this event. Labels here are per-event (e.g. "Lead A").</p>
          <table className="setup-table">
            <thead>
              <tr><th>Fleet tracker</th><th>Event label</th><th></th></tr>
            </thead>
            <tbody>
              {cfg.trackers.map((t, i) => {
                const f = fleetByImei.get(t.imei);
                return (
                  <tr key={t.imei || i}>
                    <td>
                      <span>{f?.label ?? '—'}</span> <span className="mono dim">{t.imei}</span>
                    </td>
                    <td>
                      <input value={t.label} onChange={(e) => edit((c) => (c.trackers[i].label = e.target.value))} />
                    </td>
                    <td>
                      <button
                        className="mini danger"
                        onClick={() =>
                          edit((c) => {
                            const imei = c.trackers[i].imei;
                            c.trackers.splice(i, 1);
                            for (const r of c.roles) r.trackers = r.trackers.filter((x) => x !== imei);
                          })
                        }
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) edit((c) => addToRoster(c, e.target.value));
            }}
          >
            <option value="">+ Add from fleet…</option>
            {fleet
              .filter((f) => !f.retired && !rosterImeis.has(f.imei))
              .map((f) => (
                <option key={f.imei} value={f.imei}>
                  {f.label} ({f.imei})
                </option>
              ))}
          </select>
        </section>

        <section>
          <h3>Races</h3>
          <table className="setup-table">
            <thead>
              <tr><th>ID</th><th>Name</th><th>Course</th><th>Distance</th><th>Units</th><th></th></tr>
            </thead>
            <tbody>
              {cfg.races.map((race, i) => {
                const k = courseFor(race.course);
                return (
                  <tr key={i}>
                    <td>
                      <input value={race.id} onChange={(e) => edit((c) => (c.races[i].id = e.target.value))} />
                    </td>
                    <td>
                      <input value={race.name} onChange={(e) => edit((c) => (c.races[i].name = e.target.value))} />
                    </td>
                    <td>
                      <select value={race.course} onChange={(e) => edit((c) => (c.races[i].course = e.target.value))}>
                        {!courses.some((x) => x.file === race.course) && <option value={race.course}>{race.course}</option>}
                        {courses.map((x) => (
                          <option key={x.file} value={x.file}>
                            {x.file.replace('courses/', '')}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num course-dist">
                      {k
                        ? race.units === 'miles'
                          ? `${k.lengthMi.toFixed(2)} mi`
                          : `${k.lengthKm.toFixed(2)} km`
                        : '—'}
                    </td>
                    <td>
                      <select
                        value={race.units}
                        onChange={(e) => edit((c) => (c.races[i].units = e.target.value as 'miles' | 'kilometers'))}
                      >
                        <option value="miles">miles</option>
                        <option value="kilometers">kilometers</option>
                      </select>
                    </td>
                    <td>
                      <button className="mini danger" onClick={() => edit((c) => c.races.splice(i, 1))}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            className="mini"
            onClick={() =>
              edit((c) =>
                c.races.push({ id: '', name: '', course: courses[0]?.file ?? '', units: 'miles' }),
              )
            }
          >
            + Add race
          </button>
        </section>

        <section>
          <h3>Operator logins</h3>
          <p className="hint">Accounts for this console. Everyone signed in can run races and edit setup.</p>
          <table className="setup-table">
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td className="dim">added {new Date(u.created_at_ms).toLocaleDateString()}</td>
                  <td>
                    <button
                      className="mini danger"
                      onClick={() =>
                        ask({
                          title: `Remove login "${u.username}"?`,
                          body: 'Their sessions are signed out immediately.',
                          confirmLabel: 'Remove',
                          danger: true,
                          onConfirm: async () => {
                            try {
                              await api.deleteUser(u.username);
                              setUsers(await api.users());
                            } catch (err) {
                              setMsg({ kind: 'err', text: (err as Error).message });
                            }
                          },
                        })
                      }
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <NewUserRow
            onAdd={async (username, password) => {
              try {
                await api.addUser(username, password);
                setUsers(await api.users());
                setMsg({ kind: 'ok', text: `Login "${username}" created.` });
              } catch (err) {
                setMsg({ kind: 'err', text: (err as Error).message });
              }
            }}
          />
          <ViewerPinRow onMsg={setMsg} ask={ask} />
        </section>

        <section>
          <h3>Courses</h3>
          <table className="setup-table">
            <thead>
              <tr><th>File</th><th>Length</th><th>Points</th></tr>
            </thead>
            <tbody>
              {courses.map((k) => (
                <tr key={k.file}>
                  <td className="mono">{k.file}</td>
                  <td>
                    {k.lengthMi.toFixed(2)} mi / {k.lengthKm.toFixed(2)} km
                  </td>
                  <td>{k.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <input
            ref={fileRef}
            type="file"
            accept=".kml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadCourse(f);
              e.target.value = '';
            }}
          />
          <button className="mini" onClick={() => fileRef.current?.click()}>
            ⬆ Upload KML course
          </button>
          <p className="hint">Export from Google Earth as a single-path LineString. Length is measured on upload.</p>
        </section>
      </div>
    </div>
  );
}

function ViewerPinRow({
  onMsg,
  ask,
}: {
  onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void;
  ask: (req: ConfirmRequest) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [pin, setPin] = useState('');

  useEffect(() => {
    api.viewerEnabled().then(setEnabled).catch(() => {});
  }, []);

  const setNewPin = async () => {
    try {
      await api.setViewerPin(pin);
      setEnabled(true);
      setPin('');
      onMsg({ kind: 'ok', text: 'Viewer PIN set — existing viewer sessions were signed out.' });
    } catch (err) {
      onMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <>
      <h4>Viewer access</h4>
      <p className="hint">
        A shared PIN lets announcers, spotters, and displays watch (map, distances, health) with no
        controls — the server refuses every change from a viewer session.
        {enabled ? ' Currently ENABLED — share the console URL and the PIN.' : ' Currently disabled.'}
      </p>
      <div className="form-row">
        <label>
          {enabled ? 'New PIN (replaces current)' : 'PIN (4–12 digits)'}
          <input
            value={pin}
            inputMode="numeric"
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="e.g. 260426"
          />
        </label>
        <button className="mini self-end" disabled={pin.length < 4} onClick={setNewPin}>
          {enabled ? 'Replace PIN' : 'Enable viewer access'}
        </button>
        {enabled && (
          <button
            className="mini danger self-end"
            onClick={() =>
              ask({
                title: 'Disable viewer access?',
                body: 'All viewer sessions are signed out immediately.',
                confirmLabel: 'Disable',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.setViewerPin(null);
                    setEnabled(false);
                    onMsg({ kind: 'ok', text: 'Viewer access disabled.' });
                  } catch (err) {
                    onMsg({ kind: 'err', text: (err as Error).message });
                  }
                },
              })
            }
          >
            Disable
          </button>
        )}
      </div>
    </>
  );
}

function NewUserRow({ onAdd }: { onAdd: (username: string, password: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const valid = /^[a-zA-Z0-9._-]{2,32}$/.test(username) && password.length >= 8 && password === confirm;
  return (
    <div className="form-row">
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value.trim())} autoComplete="off" />
      </label>
      <label>
        Password (min 8)
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </label>
      <label>
        Confirm
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </label>
      <button
        className="mini self-end"
        disabled={!valid}
        onClick={() => {
          onAdd(username, password);
          setUsername('');
          setPassword('');
          setConfirm('');
        }}
      >
        + Add login
      </button>
    </div>
  );
}

function NewFleetRow({ onAdd }: { onAdd: (imei: string, label: string) => void }) {
  const [imei, setImei] = useState('');
  const [label, setLabel] = useState('');
  const valid = /^\d{15}$/.test(imei) && label.trim().length > 0;
  return (
    <div className="form-row">
      <label>
        New IMEI
        <input className="w-imei" value={imei} onChange={(e) => setImei(e.target.value.trim())} placeholder="15 digits" />
      </label>
      <label>
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="GL300 #7" />
      </label>
      <button
        className="mini self-end"
        disabled={!valid}
        onClick={() => {
          onAdd(imei, label.trim());
          setImei('');
          setLabel('');
        }}
      >
        + Add to fleet
      </button>
    </div>
  );
}

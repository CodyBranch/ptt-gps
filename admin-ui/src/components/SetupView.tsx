import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { CourseInfo, DeviceRow, EventConfigT } from '../types';

/**
 * Event setup: edit the event config (trackers, roles, races, units) and manage
 * course files. Saves write the JSON back on the server and rebuild the engines
 * — the server refuses while any race is armed or live.
 */
export function SetupView({ onSaved }: { onSaved: () => void }) {
  const [cfg, setCfg] = useState<EventConfigT>();
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    api.getConfig().then(setCfg).catch(console.error);
    api.courses().then(setCourses).catch(console.error);
    api.devices().then(setDevices).catch(console.error);
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

  const knownImeis = new Set(cfg.trackers.map((t) => t.imei));

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
          <h3>Trackers</h3>
          <table className="setup-table">
            <thead>
              <tr><th>IMEI</th><th>Label</th><th>Battery</th><th></th></tr>
            </thead>
            <tbody>
              {cfg.trackers.map((t, i) => (
                <tr key={i}>
                  <td>
                    <input
                      className="w-imei"
                      value={t.imei}
                      onChange={(e) => edit((c) => (c.trackers[i].imei = e.target.value.trim()))}
                    />
                  </td>
                  <td>
                    <input value={t.label} onChange={(e) => edit((c) => (c.trackers[i].label = e.target.value))} />
                  </td>
                  <td className="center">
                    <input
                      type="checkbox"
                      checked={t.hasBattery}
                      title="Uncheck for vehicle-powered units (GV500)"
                      onChange={(e) => edit((c) => (c.trackers[i].hasBattery = e.target.checked))}
                    />
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
              ))}
            </tbody>
          </table>
          <button
            className="mini"
            onClick={() => edit((c) => c.trackers.push({ imei: '', label: '', hasBattery: true }))}
          >
            + Add tracker
          </button>

          {devices.filter((dv) => !knownImeis.has(dv.imei)).length > 0 && (
            <>
              <h4>Seen on the wire (not in this event)</h4>
              <table className="setup-table dim-table">
                <tbody>
                  {devices
                    .filter((dv) => !knownImeis.has(dv.imei))
                    .map((dv) => (
                      <tr key={dv.imei}>
                        <td className="mono">{dv.imei}</td>
                        <td>{dv.battery != null ? `${dv.battery}%` : ''}</td>
                        <td>{dv.last_received_ms ? new Date(dv.last_received_ms).toLocaleString() : ''}</td>
                        <td>
                          <button
                            className="mini"
                            onClick={() => edit((c) => c.trackers.push({ imei: dv.imei, label: dv.imei, hasBattery: true }))}
                          >
                            + Add
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
          <h3>Roles</h3>
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
                    if (e.target.value) edit((c) => c.roles[ri].trackers.push(e.target.value));
                  }}
                >
                  <option value="">+ tracker…</option>
                  {cfg.trackers
                    .filter((t) => t.imei && !role.trackers.includes(t.imei))
                    .map((t) => (
                      <option key={t.imei} value={t.imei}>
                        {t.label || t.imei}
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
          <p className="hint">★ first tracker is the primary; the rest are failover backups in order.</p>
        </section>

        <section>
          <h3>Races</h3>
          <table className="setup-table">
            <thead>
              <tr><th>ID</th><th>Name</th><th>Course</th><th>Course units</th><th></th></tr>
            </thead>
            <tbody>
              {cfg.races.map((race, i) => (
                <tr key={i}>
                  <td>
                    <input value={race.id} onChange={(e) => edit((c) => (c.races[i].id = e.target.value))} />
                  </td>
                  <td>
                    <input value={race.name} onChange={(e) => edit((c) => (c.races[i].name = e.target.value))} />
                  </td>
                  <td>
                    <select value={race.course} onChange={(e) => edit((c) => (c.races[i].course = e.target.value))}>
                      {!courses.some((k) => k.file === race.course) && <option value={race.course}>{race.course}</option>}
                      {courses.map((k) => (
                        <option key={k.file} value={k.file}>
                          {k.file.replace('courses/', '')} ({k.lengthMi.toFixed(1)} mi)
                        </option>
                      ))}
                    </select>
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
              ))}
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

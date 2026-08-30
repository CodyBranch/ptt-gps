import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { CourseInfo, EventConfigT, FirebaseConn, FleetRow } from '../types';
import { Toast } from './Toast';
import { TrackerPicker } from './TrackerPicker';
import { CoursePicker } from './CoursePicker';
import { NumberField } from './NumberField';

/**
 * Setup for one active event: details & dates, Firebase outputs, what we're
 * tracking (roles matched to fleet trackers), the event roster, races and
 * courses. Saves rebuild that event's engines; refused while a race is armed
 * or live.
 */
export function EventSetup({
  eventId,
  ask,
  onSaved,
}: {
  eventId: string;
  ask: (req: ConfirmRequest) => void;
  onSaved: () => void;
}) {
  const [cfg, setCfg] = useState<EventConfigT>();
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [fbConns, setFbConns] = useState<FirebaseConn[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [showCourseList, setShowCourseList] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => {
    api
      .getConfig(eventId)
      .then((c) => {
        setCfg(c);
        setDirty(false);
      })
      .catch((err) => setMsg({ kind: 'err', text: (err as Error).message }));
    api.courses().then(setCourses).catch(console.error);
    api.fleet().then(setFleet).catch(console.error);
    api.firebaseList().then(setFbConns).catch(console.error);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [eventId]);

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
      await api.putConfig(eventId, cfg);
      setDirty(false);
      setMsg({ kind: 'ok', text: cfg._active === false ? 'Saved.' : 'Saved — engines rebuilt.' });
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

  const rosterImeis = new Set(cfg.trackers.map((t) => t.imei));
  const fleetByImei = new Map(fleet.map((f) => [f.imei, f]));

  const addToRoster = (c: EventConfigT, imei: string) => {
    if (c.trackers.some((t) => t.imei === imei)) return;
    const f = fleetByImei.get(imei);
    c.trackers.push({ imei, label: f?.label ?? imei, hasBattery: f ? !!f.hasBattery : true });
  };

  const courseFor = (file: string) => courses.find((k) => k.file === file);

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Setup — {cfg.name}</span>
        <span className="spacer" />
        <button className="mini" onClick={reload} disabled={!dirty}>
          Discard changes
        </button>
        <button className="mini primary" onClick={save} disabled={!dirty}>
          {cfg._active === false ? 'Save' : 'Save & rebuild'}
        </button>
      </div>

      <div className="setup-grid">
        <section>
          <h3>Event details</h3>
          <div className="form-row">
            <label>
              Name
              <input value={cfg.name} onChange={(e) => edit((c) => (c.name = e.target.value))} />
            </label>
            <label>
              Meet ID
              <NumberField value={cfg.meetId} min={-1} onCommit={(n) => edit((c) => (c.meetId = n))} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Start date
              <input
                type="date"
                value={cfg.startDate ?? ''}
                onChange={(e) => edit((c) => (c.startDate = e.target.value || undefined))}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={cfg.endDate ?? ''}
                onChange={(e) => edit((c) => (c.endDate = e.target.value || undefined))}
              />
            </label>
            <label>
              Output units
              <select value={cfg.outputUnits} onChange={(e) => edit((c) => (c.outputUnits = e.target.value as EventConfigT['outputUnits']))}>
                <option value="miles">miles</option>
                <option value="kilometers">kilometers</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Report interval (s)
              <NumberField value={cfg.reportIntervalS ?? 10} onCommit={(n) => edit((c) => (c.reportIntervalS = n))} />
            </label>
            <label>
              Window back
              <NumberField value={cfg.snapDefaults.minInc} onCommit={(n) => edit((c) => (c.snapDefaults.minInc = n))} />
            </label>
            <label>
              Window ahead
              <NumberField value={cfg.snapDefaults.maxInc} onCommit={(n) => edit((c) => (c.snapDefaults.maxInc = n))} />
            </label>
            <label>
              Initial window
              <NumberField value={cfg.snapDefaults.initialMax} onCommit={(n) => edit((c) => (c.snapDefaults.initialMax = n))} />
            </label>
          </div>

          <EventPinRow eventId={eventId} ask={ask} onMsg={setMsg} />

          <h4>Firebase outputs</h4>
          {cfg.firebase.length === 0 && (
            <p className="hint">None — this event runs with the debug publisher (nothing leaves the box).</p>
          )}
          {cfg.firebase.map((t, i) => (
            <div className="form-row" key={i}>
              <label>
                Connection
                <select value={t.connection} onChange={(e) => edit((c) => (c.firebase[i].connection = e.target.value))}>
                  {!fbConns.some((x) => x.name === t.connection) && <option value={t.connection}>{t.connection} (missing!)</option>}
                  {fbConns.map((x) => (
                    <option key={x.name} value={x.name}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Flavor
                <select value={t.flavor} onChange={(e) => edit((c) => (c.firebase[i].flavor = e.target.value as 'ptt' | 'krush'))}>
                  <option value="ptt">ptt (Scoreboard + Clock)</option>
                  <option value="krush">krush (Clock + GPSMap)</option>
                </select>
              </label>
              <button className="mini danger self-end" onClick={() => edit((c) => c.firebase.splice(i, 1))}>
                ✕
              </button>
            </div>
          ))}
          <button
            className="mini"
            disabled={fbConns.length === 0}
            title={fbConns.length === 0 ? 'Add a Firebase connection on the System page first' : ''}
            onClick={() => edit((c) => c.firebase.push({ connection: fbConns[0].name, flavor: 'ptt' }))}
          >
            + Add Firebase output
          </button>
        </section>

        <section>
          <h3>What we're tracking</h3>
          <p className="hint">
            Define the roles, then match each to fleet trackers — ★ first is the primary, the rest are
            failover backups in order.
          </p>
          <p className="hint">
            <strong>Clock slot</strong> (1–4) is which scoreboard readout the role's distance feeds:
            it writes <span className="mono">distanceComplete</span> to Meta/Clock and{' '}
            <span className="mono">Distance</span> to PTT-Scoreboard, numbered by the slot (slot 1 uses the
            un-numbered keys). Leave it blank and the distance never reaches the clock.{' '}
            <strong>Map cmd</strong> and <strong>Map event</strong> are the Krush map feed: together they write{' '}
            <span className="mono">GPSMap/&lt;cmd&gt;</span> with that event name. Both are needed — a cmd
            without an event name publishes nothing — and they only apply to a Krush-flavour Firebase output.
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
                <label title="Krush map feed channel: writes GPSMap/<cmd>. Needs Map event set too.">
                  Map cmd
                  <input
                    className="w-num"
                    value={role.cmd ?? ''}
                    onChange={(e) => edit((c) => (c.roles[ri].cmd = e.target.value === '' ? undefined : Number(e.target.value)))}
                  />
                </label>
                <label title="Scoreboard readout 1–4: distanceComplete<slot> on Meta/Clock, Distance<slot> on PTT-Scoreboard. Blank = not published to the clock.">
                  Clock slot
                  <input
                    className="w-num"
                    value={role.clockSlot ?? ''}
                    onChange={(e) =>
                      edit((c) => (c.roles[ri].clockSlot = e.target.value === '' ? undefined : Number(e.target.value)))
                    }
                  />
                </label>
                <label title="Event name written into the GPSMap payload, e.g. elite_women. Krush feed only.">
                  Map event
                  <input value={role.mapEvent ?? ''} onChange={(e) => edit((c) => (c.roles[ri].mapEvent = e.target.value || undefined))} />
                </label>
                <button className="mini danger self-end" onClick={() => edit((c) => c.roles.splice(ri, 1))}>
                  ✕
                </button>
              </div>
              <label className="role-vehicle">
                Covered by
                <select
                  value={role.vehicle}
                  onChange={(e) => edit((c) => (c.roles[ri].vehicle = e.target.value))}
                >
                  {!cfg.vehicles.some((v) => v.key === role.vehicle) && (
                    <option value={role.vehicle}>{role.vehicle || '— pick a vehicle —'}</option>
                  )}
                  {cfg.vehicles.map((v) => (
                    <option key={v.key} value={v.key}>
                      {v.label || v.key}
                    </option>
                  ))}
                </select>
                {cfg.roles.filter((r) => r.vehicle === role.vehicle).length > 1 && (
                  <span className="warn-text" title="Two roles are assigned to the same vehicle">
                    ⚠ shared
                  </span>
                )}
              </label>
            </div>
          ))}
          <button
            className="mini"
            onClick={() => edit((c) => c.roles.push({ key: '', label: '', vehicle: c.vehicles[0]?.key ?? '' }))}
          >
            + Add role
          </button>

          <h4>Vehicles</h4>
          <p className="hint">
            The cars, motos and vans that carry trackers. A role above is assigned to one of these, and swapping
            that assignment mid-race moves coverage without touching hardware — ★ is the vehicle's primary
            tracker, the rest are its failover backups.
          </p>
          {cfg.vehicles.map((vehicle, vi) => (
            <div className="role-edit" key={vi}>
              <div className="form-row">
                <label>
                  Key
                  <input value={vehicle.key} onChange={(e) => edit((c) => (c.vehicles[vi].key = e.target.value))} />
                </label>
                <label>
                  Label
                  <input value={vehicle.label} onChange={(e) => edit((c) => (c.vehicles[vi].label = e.target.value))} />
                </label>
                <button
                  className="mini danger self-end"
                  onClick={() =>
                    ask({
                      title: `Remove vehicle "${vehicle.label || vehicle.key}"?`,
                      body: cfg.roles.some((r) => r.vehicle === vehicle.key)
                        ? 'A role is assigned to it and will need reassigning before this saves.'
                        : undefined,
                      confirmLabel: 'Remove',
                      danger: true,
                      onConfirm: () => edit((c) => c.vehicles.splice(vi, 1)),
                    })
                  }
                >
                  ✕
                </button>
              </div>
              <div className="role-trackers-edit">
                {vehicle.trackers.map((imei, ti) => {
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
                              const arr = c.vehicles[vi].trackers;
                              [arr[ti - 1], arr[ti]] = [arr[ti], arr[ti - 1]];
                            })
                          }
                        >
                          ↑
                        </button>
                      )}
                      <button onClick={() => edit((c) => c.vehicles[vi].trackers.splice(ti, 1))}>✕</button>
                    </span>
                  );
                })}
                <TrackerPicker
                  placeholder="+ match tracker…"
                  eventId={cfg.id}
                  options={fleet.filter((f) => !f.retired && !vehicle.trackers.includes(f.imei))}
                  onPick={(imei) =>
                    edit((c) => {
                      addToRoster(c, imei);
                      c.vehicles[vi].trackers.push(imei);
                    })
                  }
                />
              </div>
            </div>
          ))}
          <button className="mini" onClick={() => edit((c) => c.vehicles.push({ key: '', label: '', trackers: [] }))}>
            + Add vehicle
          </button>

          <h4>Event roster</h4>
          <p className="hint">Fleet trackers matched to this event; labels here are per-event.</p>
          <table className="setup-table">
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
                            // dropping a tracker from the roster takes it off
                            // whichever vehicle was carrying it
                            for (const v of c.vehicles) v.trackers = v.trackers.filter((x) => x !== imei);
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
          <TrackerPicker
            placeholder="+ Add from fleet…"
            eventId={cfg.id}
            options={fleet.filter((f) => !f.retired && !rosterImeis.has(f.imei))}
            onPick={(imei) => edit((c) => addToRoster(c, imei))}
          />
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
                      <CoursePicker
                        courses={courses}
                        value={race.course}
                        units={race.units}
                        onPick={(file) => edit((c) => (c.races[i].course = file))}
                      />
                    </td>
                    <td className="num course-dist">
                      {k ? (race.units === 'miles' ? `${k.lengthMi.toFixed(2)} mi` : `${k.lengthKm.toFixed(2)} km`) : '—'}
                    </td>
                    <td>
                      <select value={race.units} onChange={(e) => edit((c) => (c.races[i].units = e.target.value as 'miles' | 'kilometers'))}>
                        <option value="miles">miles</option>
                        <option value="kilometers">kilometers</option>
                      </select>
                    </td>
                    <td>
                      <button
                        className="mini danger"
                        onClick={() =>
                          ask({
                            title: `Remove race "${race.name || race.id}"?`,
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: () => edit((c) => c.races.splice(i, 1)),
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
          <button
            className="mini"
            onClick={() =>
              // a new race measures the way the event publishes unless changed
              edit((c) => c.races.push({ id: '', name: '', course: courses[0]?.file ?? '', units: c.outputUnits }))
            }
          >
            + Add race
          </button>

          {/* The picker above searches these; the full list is a reference,
              so it stays folded rather than pushing the page down by 85 rows. */}
          <button className="mini completed-toggle" onClick={() => setShowCourseList(!showCourseList)}>
            {showCourseList ? '▾' : '▸'} Courses (shared by all events) —{' '}
            {courses.filter((k) => !k.archived).length}
          </button>
          {showCourseList && (
            <table className="setup-table">
              <tbody>
                {courses
                  .filter((k) => !k.archived)
                  .map((k) => (
                    <tr key={k.file}>
                      <td className="mono">{k.file}</td>
                      <td>
                        {k.lengthMi.toFixed(2)} mi / {k.lengthKm.toFixed(2)} km
                      </td>
                      <td>{k.points} pts</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
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
          <p className="hint">
            Export from Google Earth as a single-path LineString. Length is measured on upload. Mile/km posts, aid
            stations and other markers are set up per course on the Courses page — they carry across every event that
            uses that course.
          </p>
        </section>
      </div>

      <Toast msg={msg} onDone={() => setMsg(undefined)} />
    </div>
  );
}

function EventPinRow({
  eventId,
  ask,
  onMsg,
}: {
  eventId: string;
  ask: (req: ConfirmRequest) => void;
  onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [pin, setPin] = useState('');

  useEffect(() => {
    api.eventViewerPinEnabled(eventId).then(setEnabled).catch(() => {});
  }, [eventId]);

  return (
    <>
      <h4>Viewer PIN for this event</h4>
      <p className="hint">
        Grants view-only access to <b>this event only</b>. The global PIN (System page) already covers
        every event — don't duplicate it here.{enabled ? ' Currently ENABLED.' : ' Currently not set.'}
      </p>
      <div className="form-row">
        <label>
          {enabled ? 'New PIN (replaces current)' : 'PIN (4–12 digits)'}
          <input value={pin} inputMode="numeric" onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button
          className="mini self-end"
          disabled={pin.length < 4}
          onClick={async () => {
            try {
              await api.setEventViewerPin(eventId, pin);
              setEnabled(true);
              setPin('');
              onMsg({ kind: 'ok', text: 'Event viewer PIN set — all viewer sessions were signed out.' });
            } catch (err) {
              onMsg({ kind: 'err', text: (err as Error).message });
            }
          }}
        >
          {enabled ? 'Replace' : 'Set PIN'}
        </button>
        {enabled && (
          <button
            className="mini danger self-end"
            onClick={() =>
              ask({
                title: 'Remove this event’s viewer PIN?',
                body: 'Viewers using it are signed out. The global PIN keeps working.',
                confirmLabel: 'Remove',
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.setEventViewerPin(eventId, null);
                    setEnabled(false);
                    onMsg({ kind: 'ok', text: 'Event viewer PIN removed.' });
                  } catch (err) {
                    onMsg({ kind: 'err', text: (err as Error).message });
                  }
                },
              })
            }
          >
            Remove
          </button>
        )}
      </div>
    </>
  );
}

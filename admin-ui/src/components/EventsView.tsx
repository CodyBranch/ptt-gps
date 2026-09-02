import { useEffect, useReducer, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { CourseInfo, EventListing, EventSnap, Units } from '../types';
import { PublishBadge, RaceRows, ReportingCount } from './EventLive';
import { Toast } from './Toast';

/**
 * Event library. Several events can be active (running) at once. Sorted:
 * active first, then nearest upcoming by start date, then undated; completed
 * events (end date in the past) are hidden behind a toggle.
 */
export function EventsView({
  live,
  lastSeen,
  displayUnits,
  ask,
  onChanged,
  onOpenSetup,
  onOpenEvent,
  onManageCourses,
}: {
  /** Snapshot of the running events — active cards show their live state. */
  live: EventSnap[];
  lastSeen: Record<string, number>;
  displayUnits: Units;
  ask: (req: ConfirmRequest) => void;
  onChanged: () => void;
  onOpenSetup: (eventId: string) => void;
  onOpenEvent: (eventId: string, tab?: string) => void;
  onManageCourses: () => void;
}) {
  const [events, setEvents] = useState<EventListing[]>([]);
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // packet ages go stale on their own between snapshots
  useEffect(() => {
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);
  // create form
  const [name, setName] = useState('');
  const [meetId, setMeetId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [copyFrom, setCopyFrom] = useState('');

  const reload = () => {
    api
      .events()
      .then((r) => setEvents(r.events))
      .catch(console.error);
    api.courses().then(setCourses).catch(console.error);
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const liveById = new Map(live.map((e) => [e.event.id, e]));
  const loadedSet = new Set(liveById.keys());
  const isCompleted = (e: EventListing) =>
    !loadedSet.has(e.id) && (!!e.completedAt || (!!e.endDate && e.endDate < today));

  const sortKey = (e: EventListing): [number, string] => {
    if (loadedSet.has(e.id)) return [0, e.startDate ?? '9999'];
    if (!isCompleted(e)) return [1, e.startDate ?? '9999-99-99'];
    return [2, e.endDate ?? ''];
  };
  const sorted = [...events]
    .filter((e) => !e.error)
    .sort((a, b) => {
      const [ga, ka] = sortKey(a);
      const [gb, kb] = sortKey(b);
      if (ga !== gb) return ga - gb;
      // completed: most recent first; others: soonest first
      return ga === 2 ? kb.localeCompare(ka) : ka.localeCompare(kb);
    });
  const visible = sorted.filter((e) => !isCompleted(e));
  const completed = sorted.filter(isCompleted);
  const broken = events.filter((e) => e.error);

  const activate = (e: EventListing) =>
    ask({
      title: `Activate "${e.name}"?`,
      body: 'Starts its engines and tracker listeners alongside any other active events.',
      confirmLabel: 'Activate',
      onConfirm: async () => {
        try {
          await api.loadEvent(e.file);
          setMsg({ kind: 'ok', text: `"${e.name}" is running.` });
          onChanged();
          reload();
        } catch (err) {
          setMsg({ kind: 'err', text: (err as Error).message });
        }
      },
    });

  const deactivate = (e: EventListing) =>
    ask({
      title: `Deactivate "${e.name}"?`,
      body: 'Stops its engines. Not allowed while one of its races is armed or live.',
      confirmLabel: 'Deactivate',
      danger: true,
      onConfirm: async () => {
        try {
          await api.unloadEvent(e.id);
          setMsg({ kind: 'ok', text: `"${e.name}" stopped.` });
          onChanged();
          reload();
        } catch (err) {
          setMsg({ kind: 'err', text: (err as Error).message });
        }
      },
    });

  const complete = (e: EventListing) =>
    ask({
      title: `Complete "${e.name}"?`,
      body: e.id && loadedSet.has(e.id)
        ? 'Stops its engines and files it under completed events. Refused while a race is armed or live.'
        : 'Files it under completed events. Nothing is deleted — reopen it any time.',
      confirmLabel: 'Complete',
      onConfirm: async () => {
        try {
          await api.completeEvent(e.id, true);
          setMsg({ kind: 'ok', text: `"${e.name}" completed.` });
          onChanged();
          reload();
        } catch (err) {
          setMsg({ kind: 'err', text: (err as Error).message });
        }
      },
    });

  const reopen = async (e: EventListing) => {
    try {
      await api.completeEvent(e.id, false);
      setMsg({ kind: 'ok', text: `"${e.name}" reopened.` });
      onChanged();
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const create = async () => {
    try {
      const res = await api.createEvent({
        id: name,
        name: name.trim(),
        meetId: Number(meetId) || 0,
        startDate: startDate || undefined,
        endDate: endDate || startDate || undefined,
        copyFromFile: copyFrom || undefined,
      });
      setMsg({ kind: 'ok', text: `Created ${res.file} — activate it, then finish setup.` });
      setName('');
      setMeetId('');
      setStartDate('');
      setEndDate('');
      setCopyFrom('');
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const dateRange = (e: EventListing) => {
    if (!e.startDate && !e.endDate) return 'no dates set';
    if (e.startDate && e.endDate && e.startDate !== e.endDate) return `${e.startDate} → ${e.endDate}`;
    return e.startDate ?? e.endDate ?? '';
  };

  const card = (e: EventListing) => {
    const ev = liveById.get(e.id);
    const active = !!ev;
    const running = ev?.races.some((r) => r.status === 'live');
    return (
      <div key={e.file} className={`event-card ${active ? 'active' : ''} ${running ? 'running' : ''}`}>
        <div className="event-card-head">
          <span className="event-card-name">{e.name}</span>
          {ev ? <PublishBadge on={ev.publishEnabled} /> : null}
          {active && <span className="active-badge">ACTIVE</span>}
        </div>
        <div className="event-card-meta">
          {dateRange(e)} · meet {e.meetId} ·{' '}
          {ev ? (
            <ReportingCount ev={ev} lastSeen={lastSeen} now={now} />
          ) : (
            <>
              {e.races} race{e.races === 1 ? '' : 's'} · {e.trackers} tracker{e.trackers === 1 ? '' : 's'}
            </>
          )}
        </div>
        {/* An active event shows the same live picture as Home: a row per
            race with its state and how much of its fleet is reporting. */}
        {ev && (
          <div className="event-card-races">
            <RaceRows ev={ev} lastSeen={lastSeen} now={now} displayUnits={displayUnits} onOpenRace={(raceId) => onOpenEvent(e.id, raceId)} />
          </div>
        )}
        <div className="event-card-actions">
          {active ? (
            <>
              <button className="mini" onClick={() => onOpenEvent(e.id)}>
                Open →
              </button>
              <button className="mini" onClick={() => onOpenSetup(e.id)}>
                ⚙ Setup
              </button>
              <button className="mini danger" onClick={() => deactivate(e)}>
                Deactivate
              </button>
              {/* stops it and files it in one go — the end of a meet day */}
              <button className="mini" onClick={() => complete(e)}>
                ✓ Complete
              </button>
            </>
          ) : isCompleted(e) ? (
            <>
              <button className="mini" onClick={() => reopen(e)}>
                ↩ Reopen
              </button>
              <button className="mini" onClick={() => onOpenSetup(e.id)}>
                ⚙ Setup
              </button>
            </>
          ) : (
            <>
              <button className="mini primary" onClick={() => activate(e)}>
                Activate
              </button>
              {/* build it during the week; activate on meet day */}
              <button className="mini" onClick={() => onOpenSetup(e.id)}>
                ⚙ Setup
              </button>
              <button className="mini" onClick={() => complete(e)}>
                ✓ Complete
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Events</span>
        <span className="spacer" />
      </div>

      <div className="events-layout">
        <div className="events-column">
          {visible.map(card)}
          {broken.map((e) => (
            <div key={e.file} className="event-card broken">
              <div className="event-card-head">
                <span className="event-card-name">{e.file}</span>
              </div>
              <div className="event-card-err">{e.error}</div>
            </div>
          ))}
          {completed.length > 0 && (
            <button className="mini completed-toggle" onClick={() => setShowCompleted(!showCompleted)}>
              {showCompleted ? '▾' : '▸'} Completed events ({completed.length})
            </button>
          )}
          {showCompleted && completed.map(card)}
        </div>

        <div className="event-card new event-create">
          <div className="event-card-head">
            <span className="event-card-name">New event</span>
          </div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Boston Marathon 2027" />
          </label>
          <div className="form-row">
            <label>
              Meet ID
              <input value={meetId} inputMode="numeric" onChange={(e) => setMeetId(e.target.value)} />
            </label>
            <label>
              Start date
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label>
              End date
              <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
          <label>
            Start from
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">Blank event</option>
              {sorted.map((e) => (
                <option key={e.file} value={e.file}>
                  Copy of {e.name}
                </option>
              ))}
            </select>
          </label>
          <button className="mini primary" disabled={!name.trim()} onClick={create}>
            + Create event
          </button>
          <p className="hint">Copying carries over the roster, roles, races, courses, and Firebase outputs.</p>

          <div className="event-card-head course-lib-head">
            <span className="event-card-name">Course library</span>
            <span className="dim">{courses.filter((c) => !c.archived).length} courses</span>
          </div>
          <p className="hint">
            Courses are shared by every event and reused year after year — upload, rename, archive and see which
            events use each one on the Courses page.
          </p>
          <button className="mini" onClick={onManageCourses}>
            🗺 Manage courses →
          </button>
        </div>
      </div>

      <Toast msg={msg} onDone={() => setMsg(undefined)} />
    </div>
  );
}

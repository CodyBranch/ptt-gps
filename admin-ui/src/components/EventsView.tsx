import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { EventListing } from '../types';

/**
 * Event library: every event config on the server. One event is active
 * (its races and listeners are the ones running); switching is guarded
 * server-side while a race is armed or live. New events start blank or as a
 * copy of a previous event — the copy-last-year workflow.
 */
export function EventsView({
  ask,
  onActivated,
}: {
  ask: (req: ConfirmRequest) => void;
  onActivated: () => void;
}) {
  const [events, setEvents] = useState<EventListing[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [name, setName] = useState('');
  const [meetId, setMeetId] = useState('');
  const [copyFrom, setCopyFrom] = useState('');

  const reload = () => {
    api
      .events()
      .then((r: { active: string; events: EventListing[] }) => {
        setEvents(r.events);
        setActiveId(r.active);
      })
      .catch(console.error);
  };
  useEffect(reload, []);

  const activate = (e: EventListing) => {
    ask({
      title: `Activate "${e.name}"?`,
      body: 'The console and tracker listeners switch to this event. Not allowed while a race is armed or live.',
      confirmLabel: 'Activate',
      onConfirm: async () => {
        try {
          await api.activateEvent(e.file);
          setMsg({ kind: 'ok', text: `"${e.name}" is now active.` });
          onActivated();
          reload();
        } catch (err) {
          setMsg({ kind: 'err', text: (err as Error).message });
        }
      },
    });
  };

  const create = async () => {
    try {
      const res = await api.createEvent({
        id: name,
        name: name.trim(),
        meetId: Number(meetId) || 0,
        copyFromFile: copyFrom || undefined,
      });
      setMsg({ kind: 'ok', text: `Created ${res.file} — activate it, then finish setup.` });
      setName('');
      setMeetId('');
      setCopyFrom('');
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Events</span>
        {msg && <span className={`setup-msg ${msg.kind}`}>{msg.text}</span>}
        <span className="spacer" />
      </div>

      <div className="events-list">
        {events.map((e) => (
          <div key={e.file} className={`event-card ${e.id === activeId ? 'active' : ''} ${e.error ? 'broken' : ''}`}>
            <div className="event-card-head">
              <span className="event-card-name">{e.name}</span>
              {e.id === activeId && <span className="active-badge">ACTIVE</span>}
            </div>
            <div className="event-card-meta">
              meet {e.meetId} · {e.races} race{e.races === 1 ? '' : 's'} · {e.trackers} tracker
              {e.trackers === 1 ? '' : 's'}
            </div>
            <div className="event-card-file mono">{e.file}</div>
            {e.error && <div className="event-card-err">{e.error}</div>}
            {e.id !== activeId && !e.error && (
              <button className="mini primary" onClick={() => activate(e)}>
                Activate
              </button>
            )}
          </div>
        ))}

        <div className="event-card new">
          <div className="event-card-head">
            <span className="event-card-name">New event</span>
          </div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Boston Marathon 2027" />
          </label>
          <label>
            Meet ID
            <input value={meetId} inputMode="numeric" onChange={(e) => setMeetId(e.target.value)} />
          </label>
          <label>
            Start from
            <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">Blank event</option>
              {events
                .filter((e) => !e.error)
                .map((e) => (
                  <option key={e.file} value={e.file}>
                    Copy of {e.name}
                  </option>
                ))}
            </select>
          </label>
          <button className="mini primary" disabled={!name.trim()} onClick={create}>
            + Create event
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { defaultBoardConfig, type CoursePayload, type EventSnap, type RaceSnap } from '../types';
import { BOARD_H, BOARD_W, CourseBoard } from './CourseBoard';

/**
 * The board as it goes out: the whole screen, nothing else on it.
 *
 * No sidebar, no controls, no cursor affordances, no page chrome of any kind -
 * this is pointed at a capture card or a projector and anything drawn over it
 * is in shot. It is driven entirely from the control page, through the board
 * config on the event snapshot, so the machine running this needs nobody at
 * its keyboard once it is open.
 *
 * Scaled rather than reflowed. The design is a fixed 1920x1080 canvas, so on
 * any other size it is scaled to fit and letterboxed, which keeps type sizes
 * and spacing exactly as they were set up rather than rearranging live.
 */
export function BoardOutput({ ev }: { ev: EventSnap | null }) {
  const [course, setCourse] = useState<CoursePayload | null>(null);
  const [now, setNow] = useState(Date.now());
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // A clock has to tick between snapshots; everything else arrives with one.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const config = ev?.board ?? defaultBoardConfig();

  const race: RaceSnap | null = useMemo(() => {
    if (!ev) return null;
    if (config.raceId) return ev.races.find((r) => r.raceId === config.raceId) ?? null;
    // Following the meet: whatever is running, then whatever is about to.
    return ev.races.find((r) => r.status === 'live') ?? ev.races.find((r) => r.status === 'armed') ?? null;
  }, [ev, config.raceId]);

  useEffect(() => {
    if (!race) return void setCourse(null);
    let live = true;
    api
      .course(race.eventId, race.raceId)
      .then((c) => live && setCourse(c))
      .catch(() => live && setCourse(null));
    return () => {
      live = false;
    };
  }, [race?.eventId, race?.raceId]);

  const scale = Math.min(size.w / BOARD_W, size.h / BOARD_H);

  if (!ev) {
    return (
      <div className="board-output">
        <div className="board-output-wait">Waiting for the meet…</div>
      </div>
    );
  }

  return (
    <div className="board-output">
      <div
        className="board-output-canvas"
        style={{
          width: BOARD_W,
          height: BOARD_H,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <CourseBoard
          event={ev.event}
          race={race}
          course={course}
          config={config}
          startedMs={race?.startedMs ?? null}
          now={now}
        />
      </div>
    </div>
  );
}

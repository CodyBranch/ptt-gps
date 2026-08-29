import { useState } from 'react';
import type { RaceSnap, TrackerPub } from '../types';

export function WindowDialog({
  race,
  tracker,
  onClose,
  onSet,
  onRelease,
}: {
  race: RaceSnap;
  tracker: TrackerPub;
  onClose: () => void;
  onSet: (start: number, end: number, latch: boolean) => void;
  onRelease: () => void;
}) {
  const [start, setStart] = useState(tracker.window.min.toFixed(2));
  const [end, setEnd] = useState(tracker.window.max.toFixed(2));
  const [latch, setLatch] = useState(tracker.window.mode === 'clamped');
  const [error, setError] = useState<string>();
  const [outsideAck, setOutsideAck] = useState(false);
  const unit = race.units === 'miles' ? 'mi' : 'km';
  const held = tracker.window.mode === 'clamped';

  const clearFeedback = () => {
    setError(undefined);
    setOutsideAck(false);
  };

  const outsideZone = () => {
    const s = Number(start);
    const e = Number(end);
    return (
      Number.isFinite(s) && Number.isFinite(e) && tracker.distance !== undefined &&
      (tracker.distance < s || tracker.distance > e)
    );
  };

  const submit = () => {
    const s = Number(start);
    const e = Number(end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return setError('Enter numeric distances.');
    if (e <= s) return setError('End must be greater than start.');
    if (s < 0 || e > race.courseLength) return setError(`Must be within 0–${race.courseLength.toFixed(2)} ${unit}.`);
    if (outsideZone() && !outsideAck) {
      setError(
        `Last snapped position (${tracker.distance!.toFixed(2)} ${unit}) is outside this range — press again to set anyway.`,
      );
      setOutsideAck(true);
      return;
    }
    onSet(s, e, latch);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-window" onClick={(e) => e.stopPropagation()}>
        <h3>
          Snap window <span className="dialog-subject">{tracker.label}</span>
          {held && <span className="clamp-badge">HELD</span>}
        </h3>

        <div className="window-stats">
          <div className="window-stat">
            <span className="window-stat-label">Course</span>
            <span className="window-stat-value">0 – {race.courseLength.toFixed(2)} {unit}</span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Current window</span>
            <span className="window-stat-value">
              {tracker.window.min.toFixed(2)} – {tracker.window.max.toFixed(2)} {unit}
            </span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Last snapped</span>
            <span className="window-stat-value">
              {tracker.distance !== undefined ? `${tracker.distance.toFixed(2)} ${unit}` : '—'}
            </span>
          </div>
        </div>

        <div className="dialog-row">
          <label>
            Start ({unit})
            <input
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                clearFeedback();
              }}
              inputMode="decimal"
              autoFocus
            />
          </label>
          <label>
            End ({unit})
            <input
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                clearFeedback();
              }}
              inputMode="decimal"
            />
          </label>
        </div>

        <div className="mode-picker">
          <button className={!latch ? 'on' : ''} onClick={() => { setLatch(false); clearFeedback(); }}>
            One-shot reset
          </button>
          <button className={latch ? 'on' : ''} onClick={() => { setLatch(true); clearFeedback(); }}>
            Hold to zone
          </button>
        </div>
        <p className="mode-hint">
          {latch
            ? 'The window stays locked inside these bounds until released — for overlap trouble or an untrusted tracker.'
            : 'Snaps the next fix inside this range, then normal auto-advance resumes.'}
        </p>

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          {held && (
            <button className="mini" onClick={onRelease}>
              Release hold
            </button>
          )}
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button className="mini primary" onClick={submit}>
            {outsideAck ? 'Set anyway' : latch ? 'Set & hold' : 'Reset window'}
          </button>
        </div>
      </div>
    </div>
  );
}

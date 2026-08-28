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
        `Last snapped position (${tracker.distance!.toFixed(2)} ${unit}) is outside this zone — press again to set anyway.`,
      );
      setOutsideAck(true);
      return;
    }
    onSet(s, e, latch);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Snap window — {tracker.label}</h3>
        <p className="dialog-sub">
          Course 0–{race.courseLength.toFixed(2)} {unit} · current window {tracker.window.min.toFixed(2)}–
          {tracker.window.max.toFixed(2)}
          {tracker.window.mode === 'clamped' ? ' (HELD)' : ''}
        </p>
        <div className="dialog-row">
          <label>
            Start ({unit})
            <input
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setError(undefined);
                setOutsideAck(false);
              }}
              inputMode="decimal"
            />
          </label>
          <label>
            End ({unit})
            <input
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                setError(undefined);
                setOutsideAck(false);
              }}
              inputMode="decimal"
            />
          </label>
        </div>
        {error && <p className="dialog-error">{error}</p>}
        <label className="dialog-check">
          <input type="checkbox" checked={latch} onChange={(e) => setLatch(e.target.checked)} />
          Hold to zone (window cannot leave these bounds until released)
        </label>
        <div className="dialog-actions">
          {tracker.window.mode === 'clamped' && (
            <button className="mini" onClick={onRelease}>
              Release hold
            </button>
          )}
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Cancel
          </button>
          <button className="mini primary" onClick={submit}>
            {latch ? 'Set & hold' : 'Reset window'}
          </button>
        </div>
      </div>
    </div>
  );
}

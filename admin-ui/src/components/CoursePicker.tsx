import { useRef, useState } from 'react';
import { useDismissOnOutside } from '../hooks';
import type { CourseInfo, Units } from '../types';

/**
 * Choose a course for a race out of a library that is now 85 deep.
 *
 * Unlike the tracker picker this one carries a value: closed it shows the
 * chosen course, focused it clears to a search box so you can type "gans" or
 * "8k" instead of hunting through an alphabetical list. Archived courses stay
 * out of the way but remain selectable if a race already points at one, so an
 * old event still resolves.
 */
export function CoursePicker({
  courses,
  value,
  units,
  onPick,
}: {
  courses: CourseInfo[];
  value: string;
  /** The race's units, so the length reads the way the race measures. */
  units: Units;
  onPick: (file: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(wrapRef, open, () => {
    setOpen(false);
    setQuery('');
  });

  const nameOf = (c: CourseInfo) => c.label || c.file.replace('courses/', '');
  const selected = courses.find((c) => c.file === value);
  const len = (c: CourseInfo) =>
    units === 'miles' ? `${c.lengthMi.toFixed(2)} mi` : `${c.lengthKm.toFixed(2)} km`;

  const q = query.trim().toLowerCase();
  const shown = courses
    .filter((c) => !c.archived || c.file === value)
    .filter((c) => (!q ? true : [nameOf(c), c.file, c.notes].some((v) => (v ?? '').toLowerCase().includes(q))))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }));

  const choose = (file: string) => {
    onPick(file);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="course-picker" ref={wrapRef}>
      <input
        value={open ? query : selected ? nameOf(selected) : value.replace('courses/', '')}
        placeholder="Search courses…"
        onFocus={() => {
          setOpen(true);
          setQuery('');
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && shown.length === 1) choose(shown[0].file);
        }}
      />
      {open && (
        <div className="picker-list course-picker-list">
          {shown.length === 0 && <div className="tracker-picker-empty">No matching course</div>}
          {shown.map((c) => (
            <button
              key={c.file}
              className={`tracker-picker-row ${c.file === value ? 'chosen' : ''}`}
              onClick={() => choose(c.file)}
            >
              <span className="tp-label">{nameOf(c)}</span>
              {c.archived && <span className="course-tag">ARCHIVED</span>}
              <span className="tp-owner dim">{len(c)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

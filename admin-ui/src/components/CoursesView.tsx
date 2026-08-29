import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ConfirmRequest } from './Confirm';
import type { CourseInfo, Units } from '../types';
import { CoursePreview } from './MapView';

/**
 * The course library. A course outlives the event it was drawn for — the same
 * KML gets pointed at year after year — so courses are managed here as shared
 * assets with their own history, not as a per-event upload. Deleting one that
 * an old event still references would break replaying that race, so deletes are
 * refused while anything points at it; archiving hides it from pickers instead.
 */
export function CoursesView({
  displayUnits,
  ask,
  onOpenEvent,
}: {
  displayUnits: Units;
  ask: (req: ConfirmRequest) => void;
  onOpenEvent: (eventId: string) => void;
}) {
  const [courses, setCourses] = useState<CourseInfo[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [openFile, setOpenFile] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string>('');

  const reload = () => api.courses().then(setCourses).catch(console.error);
  useEffect(() => {
    reload();
  }, []);

  const upload = async (f: File, replaceFile?: string) => {
    try {
      const text = await f.text();
      const name = replaceFile ? replaceFile.replace(/^courses\//, '') : f.name;
      const res = await api.uploadCourse(name.replace(/\.kml$/i, ''), text, !!replaceFile);
      setMsg({
        kind: 'ok',
        text: `${res.replaced ? 'Replaced' : 'Added'} ${res.file} — ${res.lengthMi.toFixed(2)} mi, ${res.points} points`,
      });
      reload();
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  const len = (c: CourseInfo) =>
    displayUnits === 'miles' ? `${c.lengthMi.toFixed(2)} mi` : `${c.lengthKm.toFixed(2)} km`;

  const visible = courses.filter((c) => showArchived || !c.archived);
  const archivedCount = courses.filter((c) => c.archived).length;
  const open = courses.find((c) => c.file === openFile);

  return (
    <div className="setup">
      <div className="setup-bar">
        <span className="setup-title">Courses</span>
        {msg && <span className={`setup-msg ${msg.kind}`}>{msg.text}</span>}
        <span className="spacer" />
        <button className="mini primary" onClick={() => fileRef.current?.click()}>
          ⬆ Upload course
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".kml"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) upload(f);
        }}
      />
      <input
        ref={replaceRef}
        type="file"
        accept=".kml"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) upload(f, replaceTarget.current);
        }}
      />

      <div className="courses-wrap">
        {courses.length === 0 && (
          <div className="home-empty">
            <p>No courses yet. Upload a KML exported from Google Earth as a single path.</p>
            <button className="mini primary" onClick={() => fileRef.current?.click()}>
              ⬆ Upload course
            </button>
          </div>
        )}

        {visible.map((c) => (
          <div key={c.file} className={`course-card ${c.archived ? 'archived' : ''}`}>
            <div className="course-card-head">
              <button className="course-name" onClick={() => setOpenFile(c.file)}>
                {c.label || c.file.replace('courses/', '')}
              </button>
              {c.archived && <span className="course-tag">ARCHIVED</span>}
              {c.inActiveEvent && <span className="course-tag live">IN ACTIVE EVENT</span>}
            </div>
            <div className="course-card-meta">
              <span className="mono">{c.file.replace('courses/', '')}</span> · {len(c)} · {c.points} points
              {c.createdMs ? ` · added ${new Date(c.createdMs).toLocaleDateString()}` : ''}
            </div>
            {c.notes && <div className="course-notes">{c.notes}</div>}
            <div className="course-uses">
              {(c.uses?.length ?? 0) === 0 ? (
                <span className="dim">Not used by any event</span>
              ) : (
                <>
                  <span className="course-uses-label">
                    Used by {c.eventCount} event{c.eventCount === 1 ? '' : 's'}:
                  </span>
                  {c.uses!.map((u) => (
                    <button
                      key={`${u.eventId}/${u.raceId}`}
                      className="course-use"
                      title={`${u.eventName} — ${u.raceName}`}
                      onClick={() => onOpenEvent(u.eventId)}
                    >
                      {u.eventName} <span className="dim">· {u.raceName}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="home-actions">
              <button className="mini" onClick={() => setOpenFile(c.file)}>
                Details
              </button>
              <button
                className="mini"
                onClick={() => {
                  replaceTarget.current = c.file;
                  replaceRef.current?.click();
                }}
                title="Upload new geometry under the same name"
              >
                ⟳ Replace
              </button>
              <a className="mini linkbtn" href={api.courseDownloadUrl(c.file)}>
                ⬇ Download
              </a>
            </div>
          </div>
        ))}

        {archivedCount > 0 && (
          <button className="mini completed-toggle" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '▾' : '▸'} Archived courses ({archivedCount})
          </button>
        )}
      </div>

      {open && (
        <CourseDialog
          course={open}
          displayUnits={displayUnits}
          ask={ask}
          onClose={() => setOpenFile(undefined)}
          onChanged={(nextFile) => {
            reload();
            setOpenFile(nextFile);
          }}
          onMsg={setMsg}
          onOpenEvent={onOpenEvent}
        />
      )}
    </div>
  );
}

function CourseDialog({
  course,
  displayUnits,
  ask,
  onClose,
  onChanged,
  onMsg,
  onOpenEvent,
}: {
  course: CourseInfo;
  displayUnits: Units;
  ask: (req: ConfirmRequest) => void;
  onClose: () => void;
  onChanged: (nextFile?: string) => void;
  onMsg: (m: { kind: 'ok' | 'err'; text: string }) => void;
  onOpenEvent: (eventId: string) => void;
}) {
  const [label, setLabel] = useState(course.label ?? '');
  const [notes, setNotes] = useState(course.notes ?? '');
  const [rename, setRename] = useState(course.file.replace('courses/', '').replace(/\.kml$/i, ''));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveMeta = () =>
    run(async () => {
      await api.updateCourse(course.file, { label, notes });
      onMsg({ kind: 'ok', text: 'Course details saved.' });
      onChanged(course.file);
    });

  const doRename = () =>
    run(async () => {
      const res = await api.renameCourse(course.file, rename);
      onMsg({
        kind: 'ok',
        text: res.updated.length
          ? `Renamed to ${res.file} and updated ${res.updated.join(', ')}`
          : `Renamed to ${res.file}`,
      });
      onChanged(res.file);
    });

  const toggleArchive = () =>
    run(async () => {
      await api.updateCourse(course.file, { archived: !course.archived });
      onMsg({ kind: 'ok', text: course.archived ? 'Course restored.' : 'Course archived — hidden from race pickers.' });
      onChanged(course.file);
    });

  const remove = () =>
    ask({
      title: `Delete ${course.file.replace('courses/', '')}?`,
      body: 'The KML is removed from the server. This cannot be undone — archive instead if you may need it again.',
      confirmLabel: 'Delete course',
      danger: true,
      onConfirm: () =>
        run(async () => {
          await api.deleteCourse(course.file);
          onMsg({ kind: 'ok', text: 'Course deleted.' });
          onClose();
          onChanged(undefined);
        }),
    });

  const uses = course.uses ?? [];

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-course" onClick={(e) => e.stopPropagation()}>
        <h3>{course.label || course.file.replace('courses/', '')}</h3>

        <div className="window-stats">
          <div className="window-stat">
            <span className="window-stat-label">Length</span>
            <span className="window-stat-value">
              {displayUnits === 'miles' ? `${course.lengthMi.toFixed(2)} mi` : `${course.lengthKm.toFixed(2)} km`}
            </span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Points</span>
            <span className="window-stat-value">{course.points}</span>
          </div>
          <div className="window-stat">
            <span className="window-stat-label">Used by</span>
            <span className="window-stat-value">
              {course.eventCount ?? 0} event{course.eventCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <CoursePreview file={course.file} />

        <label className="dlg-field">
          Display name
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={course.file.replace('courses/', '')} />
        </label>
        <label className="dlg-field">
          Notes
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. USATF certified MA-2024-017, measured 2024-01-12"
          />
        </label>

        <div className="course-history">
          <span className="window-stat-label">Event history</span>
          {uses.length === 0 ? (
            <p className="hint">No event references this course yet.</p>
          ) : (
            <div className="course-history-list">
              {[...uses]
                .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))
                .map((u) => (
                  <button key={`${u.eventId}/${u.raceId}`} className="course-history-row" onClick={() => onOpenEvent(u.eventId)}>
                    <span className="dim mono">{u.startDate ?? '—'}</span>
                    <span className="course-history-name">{u.eventName}</span>
                    <span className="dim">{u.raceName}</span>
                  </button>
                ))}
            </div>
          )}
        </div>

        <label className="dlg-field">
          File name
          <div className="course-rename">
            <input value={rename} onChange={(e) => setRename(e.target.value)} />
            <span className="dim">.kml</span>
            <button className="mini" disabled={busy} onClick={doRename}>
              Rename
            </button>
          </div>
        </label>
        <p className="hint">Renaming rewrites every event that points at this course.</p>

        {err && <p className="login-error">{err}</p>}

        <div className="dialog-actions">
          <button className="mini danger" disabled={busy} onClick={remove}>
            Delete
          </button>
          <button className="mini" disabled={busy} onClick={toggleArchive}>
            {course.archived ? 'Restore' : 'Archive'}
          </button>
          <span className="spacer" />
          <button className="mini" onClick={onClose}>
            Close
          </button>
          <button className="mini primary" disabled={busy} onClick={saveMeta}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

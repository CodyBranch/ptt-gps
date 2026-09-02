import { RELEASES, VERSION } from '../changelog';
import { inline } from './HelpView';

const SECTIONS: Array<{ key: 'added' | 'changed' | 'fixed'; label: string }> = [
  { key: 'added', label: 'Added' },
  { key: 'changed', label: 'Changed' },
  { key: 'fixed', label: 'Fixed' },
];

/**
 * What changed, and when — reading from the same file the sidebar takes its
 * version from, so the number on screen and the notes below it agree.
 */
export function ChangelogView() {
  return (
    <div className="setup help">
      <div className="setup-bar">
        <span className="setup-title">Changelog</span>
      </div>

      <div className="changelog-layout">
        <article className="help-body">
          <header className="help-head">
            <h1>What&rsquo;s changed</h1>
            <p className="help-sub">
              This console is running <span className="mono">v{VERSION}</span>. Newest first.
            </p>
          </header>

          {RELEASES.map((r) => (
            <section key={r.version} className="help-section release">
              <h2>
                <span className="release-version">v{r.version}</span>
                <span className="release-date">{r.date}</span>
              </h2>
              {r.summary && <p className="release-summary">{inline(r.summary)}</p>}
              {SECTIONS.map(({ key, label }) => {
                const items = r[key];
                if (!items || items.length === 0) return null;
                return (
                  <div className="release-group" key={key}>
                    <h3 className={`release-kind ${key}`}>{label}</h3>
                    <ul className="help-bullets">
                      {items.map((it, i) => (
                        <li key={i}>{inline(it)}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

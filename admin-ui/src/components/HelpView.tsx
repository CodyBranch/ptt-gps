import { useEffect, useState, type ReactNode } from 'react';
import { MANUAL, type Block } from '../manual';

/** The tiny inline markup the manual uses: **bold** and `code`. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<strong key={key++}>{m[1]}</strong>);
    else out.push(<span className="mono" key={key++}>{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function BlockView({ b }: { b: Block }) {
  switch (b.t) {
    case 'p':
      return <p>{inline(b.text)}</p>;
    case 'h3':
      return <h3>{inline(b.text)}</h3>;
    case 'steps':
      return (
        <ol className="help-steps">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ol>
      );
    case 'bullets':
      return (
        <ul className="help-bullets">
          {b.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ul>
      );
    case 'note':
      return <p className="help-note">{inline(b.text)}</p>;
    case 'warn':
      return <p className="help-warn">{inline(b.text)}</p>;
    case 'table':
      return (
        <div className="help-table-wrap">
          <table className="help-table">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'shot':
      return (
        <figure className="help-shot">
          <img src={`/docs/${b.src}`} alt={b.caption} loading="lazy" />
          <figcaption>{b.caption}</figcaption>
        </figure>
      );
  }
}

/**
 * The manual, in the console.
 *
 * Same content as the printed PDF — both render `manual.ts`, so the page and
 * the paper cannot drift apart. Sections are anchored, so a link to one part
 * of the manual can be handed to someone.
 */
export function HelpView() {
  const [active, setActive] = useState(MANUAL.sections[0].id);

  // highlight whichever section is on screen
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px' },
    );
    for (const s of MANUAL.sections) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="setup help">
      <div className="setup-bar">
        <span className="setup-title">Help</span>
        <span className="spacer" />
        <a className="mini linkbtn" href="/docs/primetime-gps-manual.pdf" target="_blank" rel="noreferrer">
          ⭳ Download PDF
        </a>
      </div>

      <div className="help-layout">
        <nav className="help-toc">
          {MANUAL.sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? 'on' : ''}>
              {s.title}
            </a>
          ))}
        </nav>

        <article className="help-body">
          <header className="help-head">
            <h1>{MANUAL.title}</h1>
            <p className="help-sub">{MANUAL.subtitle}</p>
          </header>
          {MANUAL.sections.map((s) => (
            <section key={s.id} id={s.id} className="help-section">
              <h2>{s.title}</h2>
              {s.blocks.map((b, i) => (
                <BlockView key={i} b={b} />
              ))}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

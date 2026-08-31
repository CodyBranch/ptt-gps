/**
 * Build the printed manual.
 *
 * Renders the same `manual.ts` the in-app Help page uses into a standalone
 * print stylesheet, then has Chrome print it to PDF. Screenshots are inlined
 * as data URIs so the HTML is a single portable file too.
 *
 *   node tools/build-manual.mjs [--out admin-ui/public/docs]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const OUT = path.resolve(arg('out', 'admin-ui/public/docs'));
const SHOTS = OUT; // captured alongside the built manual
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome not found — set the path in tools/build-manual.mjs');

// manual.ts is TypeScript; strip the types rather than pull in a compiler.
// It is plain data with one exported const, so this is safe and stays honest:
// if the shape ever stops being plain data, this throws instead of guessing.
const tsSource = fs.readFileSync('admin-ui/src/manual.ts', 'utf8');
const jsSource = tsSource
  .replace(/^export type Block[\s\S]*?;\n/m, '')
  .replace(/^export interface Section[\s\S]*?\n}\n/m, '')
  .replace(/export const MANUAL: \{[\s\S]*?\} = \{/m, 'export const MANUAL = {');
const tmpModule = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-')), 'manual.mjs');
fs.writeFileSync(tmpModule, jsSource);
const { MANUAL } = await import(pathToFileURL(tmpModule).href);
if (!MANUAL?.sections?.length) throw new Error('manual.ts did not yield sections');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The same tiny inline markup the Help page understands. */
const inline = (text) =>
  esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

const dataUri = (file) => {
  const p = path.join(SHOTS, file);
  if (!fs.existsSync(p)) {
    console.warn(`[manual] missing screenshot: ${file}`);
    return null;
  }
  return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
};

function block(b) {
  switch (b.t) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'h3':
      return `<h3>${inline(b.text)}</h3>`;
    case 'steps':
      return `<ol>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>`;
    case 'bullets':
      return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
    case 'note':
      return `<p class="note">${inline(b.text)}</p>`;
    case 'warn':
      return `<p class="warn">${inline(b.text)}</p>`;
    case 'table':
      return (
        `<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
        b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
        `</tbody></table>`
      );
    case 'shot': {
      const src = dataUri(b.src);
      if (!src) return '';
      return `<figure><img src="${src}" alt="${esc(b.caption)}"><figcaption>${esc(b.caption)}</figcaption></figure>`;
    }
    default:
      return '';
  }
}

const today = new Date().toISOString().slice(0, 10);
const toc = MANUAL.sections
  .map((s, i) => `<li><span class="n">${i + 1}</span> ${esc(s.title)}</li>`)
  .join('');
const body = MANUAL.sections
  .map(
    (s, i) =>
      `<section id="${s.id}"><h2><span class="n">${i + 1}</span> ${esc(s.title)}</h2>` +
      s.blocks.map(block).join('') +
      `</section>`,
  )
  .join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(MANUAL.title)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  /* Set both explicitly: without a background the page inherits the reader's
     dark mode and the text disappears when the HTML is opened in a browser. */
  html, body { background: #ffffff; }
  body {
    font: 10.5pt/1.55 "Segoe UI", system-ui, -apple-system, sans-serif;
    color: #16181d; margin: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  code { font-family: Consolas, ui-monospace, monospace; font-size: 0.92em; background: #eef0f4;
         padding: 1px 4px; border-radius: 3px; }
  strong { font-weight: 650; }

  /* cover */
  .cover { height: 247mm; display: flex; flex-direction: column; justify-content: center;
           page-break-after: always; }
  .cover .brand { color: #c8102e; font-weight: 800; letter-spacing: 3px; font-size: 12pt; margin-bottom: 10mm; }
  .cover h1 { font-size: 30pt; line-height: 1.15; margin: 0 0 6mm; }
  .cover p { font-size: 12pt; color: #444a55; max-width: 130mm; margin: 0 0 16mm; }
  .cover .meta { font-size: 9.5pt; color: #6b7280; }

  /* contents */
  .toc { page-break-after: always; }
  .toc h2 { font-size: 15pt; margin: 0 0 6mm; }
  .toc ol { list-style: none; padding: 0; margin: 0; }
  .toc li { padding: 2.6mm 0; border-bottom: 1px solid #e3e6ec; font-size: 11pt; }

  .n { color: #c8102e; font-weight: 700; margin-right: 3mm; }

  section { page-break-before: always; }
  h2 { font-size: 16pt; margin: 0 0 5mm; padding-bottom: 2mm; border-bottom: 2px solid #c8102e; }
  h3 { font-size: 11.5pt; margin: 7mm 0 2mm; }
  p { margin: 0 0 3mm; }
  ul, ol { margin: 0 0 4mm 6mm; padding-left: 4mm; }
  li { margin-bottom: 1.6mm; }

  .note, .warn { padding: 3mm 4mm; border-radius: 2mm; background: #f4f6fa; border-left: 3px solid #2f6fed; }
  .warn { background: #fff6ed; border-left-color: #d97706; }

  table { width: 100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 9.5pt;
          page-break-inside: avoid; }
  th { text-align: left; padding: 2mm 2.5mm; border-bottom: 1.5px solid #16181d;
       font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px; color: #4b5563; }
  td { padding: 2.2mm 2.5mm; border-bottom: 1px solid #e3e6ec; vertical-align: top; }
  tr td:first-child { font-weight: 600; }

  figure { margin: 4mm 0 5mm; page-break-inside: avoid; }
  figure img { width: 100%; border: 1px solid #d5d9e2; border-radius: 2mm; display: block; }
  figcaption { font-size: 8.5pt; color: #6b7280; text-align: center; margin-top: 1.5mm; }
</style></head>
<body>
  <div class="cover">
    <div class="brand">PRIMETIME TIMING</div>
    <h1>${esc(MANUAL.title.replace(/^Primetime GPS — /, ''))}</h1>
    <p>${esc(MANUAL.subtitle)}</p>
    <div class="meta">Primetime GPS console &middot; ${today}</div>
  </div>
  <div class="toc"><h2>Contents</h2><ol>${toc}</ol></div>
  ${body}
</body></html>`;

fs.mkdirSync(OUT, { recursive: true });
const htmlPath = path.join(OUT, 'primetime-gps-manual.html');
fs.writeFileSync(htmlPath, html);
console.log(`[manual] ${path.basename(htmlPath)} (${Math.round(html.length / 1024)} KB)`);

const pdfPath = path.join(OUT, 'primetime-gps-manual.pdf');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-chrome-'));
const r = spawnSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profile}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ],
  { encoding: 'utf8', timeout: 180000 },
);
if (!fs.existsSync(pdfPath)) throw new Error(`chrome did not produce a PDF: ${r.stderr ?? ''}`);
console.log(`[manual] ${path.basename(pdfPath)} (${Math.round(fs.statSync(pdfPath).size / 1024)} KB)`);

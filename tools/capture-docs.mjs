/**
 * Screenshot the console for the manual.
 *
 * Drives a headless Chrome over the DevTools protocol — no extra dependency,
 * Node's built-in WebSocket is enough. The console needs a session, so it logs
 * in first and injects the cookie; and it runs the simulator while it works, so
 * the race pages show a race actually running rather than an empty course.
 *
 *   node tools/capture-docs.mjs --user <admin> --pass <password>
 *     [--base http://localhost:8080] [--out admin-ui/public/docs]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8080');
const OUT = path.resolve(arg('out', 'admin-ui/public/docs'));
const USER = arg('user');
const PASS = arg('pass');
const EVENT = arg('event', 'test-gans-creek');
const RACE = arg('race', 'womens-6k');
const PORT = 9333;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].find((p) => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome not found — set the path in tools/capture-docs.mjs');
if (!USER || !PASS) throw new Error('Usage: node tools/capture-docs.mjs --user <admin> --pass <password>');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client: one websocket, id-matched replies, event listeners. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // --- session -----------------------------------------------------------
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const setCookie = login.headers.get('set-cookie');
  const body = await login.json();
  if (!body.ok || !setCookie) throw new Error(`login failed: ${body.error ?? 'no cookie'}`);
  const [cookiePair] = setCookie.split(';');
  const [cookieName, cookieValue] = cookiePair.split('=');
  const cookieHeader = cookiePair;
  const api = (p, method = 'POST', payload) =>
    fetch(`${BASE}${p}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: cookieHeader },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }).then((r) => r.json());

  // --- a race worth photographing ----------------------------------------
  console.log('[docs] starting a race for the screenshots…');
  await api(`/api/sim/stop`, 'POST', {});
  await api(`/api/events/${EVENT}/races/${RACE}/lifecycle`, 'POST', { action: 'reset' });
  await api(`/api/events/${EVENT}/races/${RACE}/lifecycle`, 'POST', { action: 'arm' });
  await api(`/api/events/${EVENT}/races/${RACE}/lifecycle`, 'POST', { action: 'start' });
  await api(`/api/sim/start`, 'POST', {
    eventId: EVENT,
    raceId: RACE,
    timescale: 8,
    intervalS: 3,
    jitterM: 5,
  });
  await sleep(18000); // let the vehicles get clear of the start line

  // --- browser -----------------------------------------------------------
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-docs-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    // Mapbox needs WebGL, and there is no GPU on a headless box
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    'about:blank',
  ]);
  chrome.stderr.on('data', () => {});
  process.on('exit', () => chrome.kill());

  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const target = targets.find((t) => t.type === 'page');
  if (!target) throw new Error('no chrome page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  const url = new URL(BASE);
  await cdp.send('Network.setCookie', {
    name: cookieName,
    value: cookieValue,
    domain: url.hostname,
    path: '/',
  });

  const setViewport = (width, height) =>
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: width < 500,
    });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  /** Navigate, wait for the app to settle, optionally run a step, then shoot. */
  async function shot(name, route, opts = {}) {
    const { width = 1440, height = 900, wait = 2600, before, fullPage = false } = opts;
    await setViewport(width, height);
    await cdp.send('Page.navigate', { url: `${BASE}${route}` });
    await sleep(wait);
    if (before) {
      await evaluate(before);
      await sleep(opts.afterWait ?? 1400);
    }
    // Maps finish late — give the canvas a beat to draw before shooting.
    if (await evaluate(`!!document.querySelector('.mapboxgl-canvas')`)) await sleep(2600);

    const params = { format: 'png', captureBeyondViewport: fullPage };
    if (fullPage) {
      const m = await cdp.send('Page.getLayoutMetrics');
      params.clip = {
        x: 0,
        y: 0,
        width: m.cssContentSize.width,
        height: Math.min(m.cssContentSize.height, 4000),
        scale: 1,
      };
    }
    const { data } = await cdp.send('Page.captureScreenshot', params);
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`[docs] ${name}.png (${kb} KB)`);
  }

  const SHOTS = [
    // --- getting in ---
    { name: 'home', route: '/' },
    { name: 'home-mobile', route: '/', width: 390, height: 844 },

    // --- events ---
    { name: 'events', route: '/events' },

    // --- setup ---
    { name: 'setup-details', route: `/event/${EVENT}/setup` },
    {
      name: 'setup-tracking',
      route: `/event/${EVENT}/setup`,
      before: `document.querySelectorAll('.setup-grid section')[1]?.scrollIntoView({block:'start'})`,
    },
    {
      name: 'setup-races',
      route: `/event/${EVENT}/setup`,
      before: `[...document.querySelectorAll('.setup-grid h3')].find(h=>/race/i.test(h.textContent))?.scrollIntoView({block:'start'})`,
    },

    // --- courses ---
    { name: 'courses', route: '/courses' },
    {
      name: 'course-detail',
      route: '/courses',
      before: `document.querySelector('.course-name')?.click()`,
      afterWait: 2600,
    },

    // --- fleet ---
    { name: 'fleet', route: '/fleet' },
    {
      name: 'fleet-device',
      route: '/fleet',
      before: `(()=>{const r=[...document.querySelectorAll('.fleet-table tbody tr')];(r.find(x=>/Krush-3/.test(x.textContent))||r[2]).click()})()`,
      afterWait: 2600,
    },

    // --- running a race ---
    { name: 'race-live', route: `/event/${EVENT}/${RACE}` },
    {
      name: 'race-selected',
      route: `/event/${EVENT}/${RACE}`,
      before: `document.querySelectorAll('.tracker-table tbody tr')[0]?.click()`,
    },
    {
      name: 'race-window',
      route: `/event/${EVENT}/${RACE}`,
      before: `document.querySelector('.tracker-table button.mini')?.click()`,
      afterWait: 1200,
    },
    {
      name: 'race-move-tracker',
      route: `/event/${EVENT}/${RACE}`,
      before: `document.querySelectorAll('.t-move')[1]?.click()`,
      afterWait: 900,
    },
    { name: 'race-mobile', route: `/event/${EVENT}/${RACE}`, width: 390, height: 844 },

    // --- viewers ---
    { name: 'viewer-full', route: '/watch' },
    { name: 'viewer-distances', route: '/watch/distances' },
    { name: 'viewer-distances-mobile', route: '/watch/distances', width: 390, height: 844 },

    // --- diagnostics ---
    { name: 'wire-log', route: '/wire', wait: 3200 },
    { name: 'sim', route: '/sim' },
    { name: 'system', route: '/system' },
    // Last on purpose: this one signs the browser out, so nothing after it
    // would be able to load. Only the browser's cookie is dropped — calling the
    // logout API would kill the session the whole run is using.
    { name: 'login', route: '/', signedOut: true },
  ];

  const only = arg('only');
  for (const s of only ? SHOTS.filter((x) => x.name === only) : SHOTS) {
    const { name, route, signedOut, ...opts } = s;
    try {
      if (signedOut) await cdp.send('Network.clearBrowserCookies');
      await shot(name, route, opts);
    } catch (err) {
      console.error(`[docs] ${name} FAILED: ${err.message}`);
    }
  }

  // --- put the event back the way we found it ----------------------------
  await api(`/api/sim/stop`, 'POST', {});
  await api(`/api/events/${EVENT}/races/${RACE}/lifecycle`, 'POST', { action: 'reset' });
  ws.close();
  chrome.kill();
  console.log(`[docs] done — ${SHOTS.length} shots in ${OUT}`);
}

await main();
process.exit(0);

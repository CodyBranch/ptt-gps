/**
 * Talking to the console's API from a script.
 *
 * The console authenticates with an HttpOnly session cookie, and `fetch` keeps
 * no cookie jar, so the token has to be carried by hand from the login
 * response onto every later request. Write endpoints answer
 * `{ ok, result }` and read endpoints answer the bare object, which is the one
 * asymmetry worth hiding here rather than in each tool.
 */

import process from 'node:process';
import readline from 'node:readline';

/** Sign in and return the cookie header to send with later calls. */
export async function login(server, user, password) {
  const res = await fetch(`${server}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  return (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')])
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');
}

/**
 * One API call. Returns the unwrapped result, or throws with whatever the
 * server said went wrong — a 400 carrying a message is the normal way this
 * API refuses something, and the message is the useful part.
 */
export async function call(server, cookie, method, apiPath, body) {
  const res = await fetch(`${server}${apiPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json — fall through to the raw text in the error */
  }
  if (!res.ok || json?.ok === false) {
    throw new Error(`${method} ${apiPath} -> ${res.status} ${json?.error ?? text}`);
  }
  return json && 'result' in json ? json.result : json;
}

/** The password from the environment, or asked for if there is a terminal. */
export async function password(user) {
  if (process.env.PTT_PASSWORD) return process.env.PTT_PASSWORD;
  if (!process.stdin.isTTY) {
    throw new Error('No terminal to ask on — set PTT_PASSWORD in the environment.');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`password for ${user}: `, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

/** --flag value / --flag parsing shared by the tools. */
export function args(argv, valued = []) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (valued.includes(argv[i].slice(2))) i++;
      continue;
    }
    positional.push(argv[i]);
  }
  return { flag, has: (name) => argv.includes(`--${name}`), positional };
}

/** CSV with quoted fields, as the fleet and assignment sheets are exported. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const head = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

import type { Units } from './types';

async function post(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
}

async function getJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result ?? json;
}

/** Course ids travel as "courses/<name>"; the routes want just "<name>". */
const courseName = (file: string) => file.replace(/^courses\//, '');

export const api = {
  // --- race operations (event-scoped) ---
  lifecycle: (eventId: string, raceId: string, action: 'arm' | 'start' | 'finish' | 'reset') =>
    post(`/api/events/${eventId}/races/${raceId}/lifecycle`, { action }),

  setActive: (eventId: string, raceId: string, roleKey: string, imei: string) =>
    post(`/api/events/${eventId}/races/${raceId}/roles/${roleKey}/active`, { imei }),

  setSource: (eventId: string, raceId: string, roleKey: string, source: 'gps' | 'splits') =>
    post(`/api/events/${eventId}/races/${raceId}/roles/${roleKey}/source`, { source }),

  setWindow: (eventId: string, raceId: string, imei: string, start: number, end: number, latch: boolean) =>
    post(`/api/events/${eventId}/races/${raceId}/trackers/${imei}/window`, { start, end, latch }),

  releaseWindow: (eventId: string, raceId: string, imei: string) =>
    send(`/api/events/${eventId}/races/${raceId}/trackers/${imei}/window`, 'DELETE'),

  course: (eventId: string, raceId: string): Promise<{ line: GeoJSON.Feature; length: number; units: string }> =>
    getJson(`/api/events/${eventId}/races/${raceId}/course`),

  setPublishing: (eventId: string, enabled: boolean) => post(`/api/events/${eventId}/publishing`, { enabled }),

  // --- events ---
  events: (): Promise<{ loaded: string[]; events: import('./types').EventListing[] }> => getJson('/api/events'),

  createEvent: (opts: { id: string; name: string; meetId: number; startDate?: string; endDate?: string; copyFromFile?: string }) =>
    send('/api/events', 'POST', opts) as Promise<{ file: string }>,

  loadEvent: (file: string) => post(`/api/events/${encodeURIComponent(file)}/load`),
  unloadEvent: (eventId: string) => post(`/api/events/${encodeURIComponent(eventId)}/unload`),

  getConfig: (eventId: string) => getJson(`/api/events/${eventId}/config`),
  putConfig: (eventId: string, config: unknown) => send(`/api/events/${eventId}/config`, 'PUT', config),

  // --- courses (shared) ---
  courses: () => getJson('/api/courses'),

  uploadCourse: async (name: string, kmlText: string, replace = false) => {
    const res = await fetch(`/api/courses/${encodeURIComponent(name)}${replace ? '?replace=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.google-earth.kml+xml' },
      body: kmlText,
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.result as { file: string; lengthMi: number; points: number; replaced: boolean };
  },

  // Routes take the bare filename — avoids an encoded slash in the path.
  courseGeometry: (file: string) => getJson(`/api/courses/${encodeURIComponent(courseName(file))}/geometry`),
  courseMarkers: (file: string) => getJson(`/api/courses/${encodeURIComponent(courseName(file))}/markers`),
  saveCourseMarkers: (
    file: string,
    body: { auto?: boolean; units?: Units; markers?: Array<{ at: number; label: string; kind?: 'point' | 'post' | 'timing' }> },
  ) => send(`/api/courses/${encodeURIComponent(courseName(file))}/markers`, 'PUT', body),
  locateOnCourse: (file: string, lat: number, lon: number) =>
    send(`/api/courses/${encodeURIComponent(courseName(file))}/locate`, 'POST', { lat, lon }) as Promise<{
      at: number;
      lat: number;
      lon: number;
    }>,
  updateCourse: (file: string, patch: { label?: string; notes?: string; archived?: boolean }) =>
    send(`/api/courses/${encodeURIComponent(courseName(file))}`, 'PUT', patch),
  renameCourse: (file: string, to: string) =>
    send(`/api/courses/${encodeURIComponent(courseName(file))}/rename`, 'POST', { to }) as Promise<{
      file: string;
      updated: string[];
    }>,
  deleteCourse: (file: string) => send(`/api/courses/${encodeURIComponent(courseName(file))}`, 'DELETE'),
  courseDownloadUrl: (file: string) => `/api/courses/${encodeURIComponent(courseName(file))}/download`,

  // --- fleet + owners + history ---
  fleet: () => getJson('/api/fleet'),
  devices: () => getJson('/api/devices'),
  owners: () => getJson('/api/owners'),
  addOwner: (name: string) => send('/api/owners', 'POST', { name }) as Promise<{ id: number; name: string }>,
  deleteOwner: (id: number) => send(`/api/owners/${id}`, 'DELETE'),

  saveFleet: (t: {
    imei: string;
    label: string;
    model?: string | null;
    hasBattery: boolean;
    notes?: string | null;
    ownerId?: number | null;
    retired: boolean;
  }) => post('/api/fleet', t),

  fleetHistory: (imei: string) => getJson(`/api/fleet/${imei}/history`),
  addIssue: (imei: string, text: string, severity: 'note' | 'issue' | 'fault') =>
    post(`/api/fleet/${imei}/issues`, { text, severity }),
  resolveIssue: (id: number) => post(`/api/fleet/issues/${id}/resolve`),

  // --- users / viewer PIN ---
  users: () => getJson('/api/users'),
  addUser: (username: string, password: string, role: 'admin' | 'staff' = 'staff') =>
    post('/api/users', { username, password, role }),
  deleteUser: (username: string) => send(`/api/users/${encodeURIComponent(username)}`, 'DELETE'),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/me/password', { currentPassword, newPassword }),
  viewerEnabled: async (): Promise<boolean> => {
    try {
      return !!(await getJson('/api/viewer-enabled')).enabled;
    } catch {
      return false;
    }
  },
  setViewerPin: (pin: string | null) => send('/api/viewer-pin', 'PUT', { pin }),
  eventViewerPinEnabled: async (eventId: string): Promise<boolean> => {
    try {
      return !!(await getJson(`/api/events/${eventId}/viewer-pin`)).enabled;
    } catch {
      return false;
    }
  },
  setEventViewerPin: (eventId: string, pin: string | null) => send(`/api/events/${eventId}/viewer-pin`, 'PUT', { pin }),

  // --- firebase ---
  firebaseList: () => getJson('/api/firebase'),
  firebaseAdd: (name: string, databaseURL: string, serviceAccount: unknown) =>
    post('/api/firebase', { name, databaseURL, serviceAccount }),
  firebaseDelete: (name: string) => send(`/api/firebase/${encodeURIComponent(name)}`, 'DELETE'),
  firebaseTest: async (name: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
    const res = await fetch(`/api/firebase/${encodeURIComponent(name)}/test`, { method: 'POST' });
    return res.json();
  },
  firebaseRead: async (name: string, path: string): Promise<unknown> => {
    const json = await getJson(`/api/firebase/${encodeURIComponent(name)}/data?path=${encodeURIComponent(path)}`);
    if (json.ok === false) throw new Error(json.error);
    return json.value;
  },
  firebaseWrite: (name: string, path: string, value: unknown, method: 'set' | 'update' | 'delete') =>
    send(`/api/firebase/${encodeURIComponent(name)}/data`, 'PUT', { path, value, method }),

  // --- forwards / split feed / tunnel / sim ---
  forwards: () => getJson('/api/forwards'),
  setForwards: (targets: Array<{ host: string; port: number; enabled: boolean }>) =>
    send('/api/forwards', 'PUT', { targets }),

  ingestToken: async (): Promise<string | null> => (await getJson('/api/ingest-token')).token,
  regenerateIngestToken: async (): Promise<string> => (await send('/api/ingest-token', 'POST')).token,

  tunnelStatus: () => getJson('/api/tunnel'),
  tunnelApply: (opts: { enabled?: boolean; domain?: string; authtoken?: string }) => send('/api/tunnel', 'PUT', opts),

  simStatus: () => getJson('/api/sim'),
  simStart: (opts: {
    eventId: string;
    raceId: string;
    timescale: number;
    intervalS: number;
    jitterM: number;
    paces: Record<string, number>;
    extraTargets?: string;
  }) => post('/api/sim/start', opts),
  simStop: () => post('/api/sim/stop'),
};

const MI_PER_KM = 0.621371;

/** Convert a distance from course units into the display unit. */
export function toDisplay(value: number, from: 'miles' | 'kilometers', to: 'miles' | 'kilometers'): number {
  if (from === to) return value;
  return from === 'miles' ? value / MI_PER_KM : value * MI_PER_KM;
}

export const unitAbbr = (u: 'miles' | 'kilometers') => (u === 'miles' ? 'mi' : 'km');

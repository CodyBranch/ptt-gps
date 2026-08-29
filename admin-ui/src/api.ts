async function post(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
}

export const api = {
  lifecycle: (raceId: string, action: 'arm' | 'start' | 'finish' | 'reset') =>
    post(`/api/races/${raceId}/lifecycle`, { action }),

  setActive: (raceId: string, roleKey: string, imei: string) =>
    post(`/api/races/${raceId}/roles/${roleKey}/active`, { imei }),

  setSource: (raceId: string, roleKey: string, source: 'gps' | 'splits') =>
    post(`/api/races/${raceId}/roles/${roleKey}/source`, { source }),

  setWindow: (raceId: string, imei: string, start: number, end: number, latch: boolean) =>
    post(`/api/races/${raceId}/trackers/${imei}/window`, { start, end, latch }),

  releaseWindow: async (raceId: string, imei: string) => {
    const res = await fetch(`/api/races/${raceId}/trackers/${imei}/window`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },

  course: async (raceId: string): Promise<{ line: GeoJSON.Feature; length: number; units: string }> => {
    const res = await fetch(`/api/races/${raceId}/course`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  getConfig: async () => {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  putConfig: async (config: unknown) => {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  courses: async () => {
    const res = await fetch('/api/courses');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  uploadCourse: async (name: string, kmlText: string) => {
    const res = await fetch(`/api/courses/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.google-earth.kml+xml' },
      body: kmlText,
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.result as { file: string; lengthMi: number; points: number };
  },

  devices: async () => {
    const res = await fetch('/api/devices');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  fleet: async () => {
    const res = await fetch('/api/fleet');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  saveFleet: async (t: { imei: string; label: string; model?: string | null; hasBattery: boolean; notes?: string | null; retired: boolean }) => {
    const res = await fetch('/api/fleet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(t),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  deleteFleet: async (imei: string) => {
    const res = await fetch(`/api/fleet/${imei}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },

  setPublishing: async (enabled: boolean) => {
    const res = await fetch('/api/publishing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  ingestToken: async (): Promise<string | null> => {
    const res = await fetch('/api/ingest-token');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).token;
  },

  regenerateIngestToken: async (): Promise<string> => {
    const res = await fetch('/api/ingest-token', { method: 'POST' });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.token;
  },

  simStatus: async () => {
    const res = await fetch('/api/sim');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  simStart: async (opts: { raceId: string; timescale: number; intervalS: number; jitterM: number; paces: Record<string, number> }) => {
    const res = await fetch('/api/sim/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  simStop: async () => {
    const res = await fetch('/api/sim/stop', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },

  firebaseList: async () => {
    const res = await fetch('/api/firebase');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  firebaseAdd: async (name: string, databaseURL: string, serviceAccount: unknown) => {
    const res = await fetch('/api/firebase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, databaseURL, serviceAccount }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  firebaseDelete: async (name: string) => {
    const res = await fetch(`/api/firebase/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  firebaseTest: async (name: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
    const res = await fetch(`/api/firebase/${encodeURIComponent(name)}/test`, { method: 'POST' });
    return res.json();
  },

  firebaseRead: async (name: string, path: string): Promise<unknown> => {
    const res = await fetch(`/api/firebase/${encodeURIComponent(name)}/data?path=${encodeURIComponent(path)}`);
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.value;
  },

  firebaseWrite: async (name: string, path: string, value: unknown, method: 'set' | 'update' | 'delete') => {
    const res = await fetch(`/api/firebase/${encodeURIComponent(name)}/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, value, method }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  tunnelStatus: async () => {
    const res = await fetch('/api/tunnel');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  tunnelApply: async (opts: { enabled?: boolean; domain?: string; authtoken?: string }) => {
    const res = await fetch('/api/tunnel', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.result;
  },

  viewerEnabled: async (): Promise<boolean> => {
    const res = await fetch('/api/viewer-enabled');
    if (!res.ok) return false;
    return !!(await res.json()).enabled;
  },

  setViewerPin: async (pin: string | null) => {
    const res = await fetch('/api/viewer-pin', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  users: async () => {
    const res = await fetch('/api/users');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  addUser: async (username: string, password: string, role: 'admin' | 'staff' = 'staff') => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  deleteUser: async (username: string) => {
    const res = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },

  events: async () => {
    const res = await fetch('/api/events');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  createEvent: async (opts: { id: string; name: string; meetId: number; copyFromFile?: string }) => {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.result as { file: string };
  },

  activateEvent: async (file: string) => {
    const res = await fetch(`/api/events/${encodeURIComponent(file)}/activate`, { method: 'POST' });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
  },
};

const MI_PER_KM = 0.621371;

/** Convert a distance from course units into the display unit. */
export function toDisplay(value: number, from: 'miles' | 'kilometers', to: 'miles' | 'kilometers'): number {
  if (from === to) return value;
  return from === 'miles' ? value / MI_PER_KM : value * MI_PER_KM;
}

export const unitAbbr = (u: 'miles' | 'kilometers') => (u === 'miles' ? 'mi' : 'km');

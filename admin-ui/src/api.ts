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

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
};

/**
 * Reverse geocoding for decoder positions — "38.9012, -92.3301" is precise but
 * useless at a glance; "Columbia, MO" tells you which meet a box is sitting at.
 *
 * Done in the browser with the publishable Mapbox token the maps already use,
 * and cached only for the session: geocoding results are licensed for display,
 * not for keeping, so nothing is written to the database.
 */

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';

/** ~11 m — far tighter than a box ever moves, and it collapses jitter. */
const key = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

// Warm from the tab's own store so flipping between pages does not re-ask.
try {
  const saved = sessionStorage.getItem('ptt-geocode');
  if (saved) for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, string>)) cache.set(k, v);
} catch {
  /* a private window, or storage is off; the cache just starts empty */
}

function persist() {
  try {
    sessionStorage.setItem('ptt-geocode', JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* not worth failing a page over */
  }
}

export function cachedPlace(lat: number, lon: number): string | undefined {
  return cache.get(key(lat, lon));
}

/** "Columbia, MO" — the town and the state code, nothing more. */
export async function reverseGeocode(lat: number, lon: number): Promise<string | undefined> {
  if (!TOKEN) return undefined;
  const k = key(lat, lon);
  const hit = cache.get(k);
  if (hit !== undefined) return hit || undefined;
  const running = inflight.get(k);
  if (running) return running;

  const p = (async () => {
    try {
      const url =
        `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lon}&latitude=${lat}` +
        `&types=place,region&limit=1&access_token=${TOKEN}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as {
        features?: Array<{ properties?: { name?: string; context?: Record<string, { name?: string; region_code?: string }> } }>;
      };
      const props = j.features?.[0]?.properties;
      const city = props?.context?.place?.name ?? props?.name;
      const region = props?.context?.region?.region_code ?? props?.context?.region?.name;
      const label = [city, region].filter(Boolean).join(', ');
      // An empty string is cached too — a place with no answer should not be
      // asked about again every time the page renders.
      cache.set(k, label);
      persist();
      return label || undefined;
    } catch {
      return undefined; // not cached: a network blip should be retryable
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * Resolve a batch without opening 95 connections at once. Reports each answer
 * as it lands so the table fills in progressively rather than all at the end.
 */
export async function reverseGeocodeAll(
  points: Array<{ id: string; lat: number; lon: number }>,
  onResolved: (id: string, place: string) => void,
  concurrency = 4,
): Promise<void> {
  const queue = points.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const place = await reverseGeocode(next.lat, next.lon);
      if (place) onResolved(next.id, place);
    }
  });
  await Promise.all(workers);
}

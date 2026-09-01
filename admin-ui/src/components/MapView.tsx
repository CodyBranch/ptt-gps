import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api, toDisplay, unitAbbr } from '../api';
import { MARKER_COLORS } from '../colors';
import type { DecoderPub, RaceSnap, TrackerPub, Units } from '../types';

export interface CourseMarker {
  at: number;
  label: string;
  kind: 'start' | 'finish' | 'unit' | 'custom' | 'timing';
  units?: 'miles' | 'kilometers';
  lat: number;
  lon: number;
}

// Mapbox publishable (pk.) token, supplied at build time — see .env.example.
// It is public by nature, but it is an account credential and GitHub's push
// protection rejects it in source, so it lives in the build environment.
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN ?? '';
if (!MAPBOX_TOKEN) {
  console.error('[map] VITE_MAPBOX_TOKEN is not set — copy admin-ui/.env.example to .env; maps will not render without it.');
}
mapboxgl.accessToken = MAPBOX_TOKEN;

const STYLES = {
  streets: 'mapbox://styles/mapbox/light-v10',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleKey = keyof typeof STYLES;

/** Band around the vehicles that stays lit during a live race. */
const BAND_BEHIND = { miles: 1, kilometers: 1.6 };
const BAND_AHEAD = { miles: 5, kilometers: 8 };
const COURSE_COLORS = ['#2f7ded', '#1fa860', '#c85fd4', '#e8842f', '#12a5a5'];

export interface MapSelection {
  raceId: string;
  imei: string;
}

/**
 * A timing box on the map. Square rather than round so it cannot be mistaken
 * for a vehicle at a glance, and hollow when the box is offline — the state you
 * are looking for is "which ones are dark".
 */
function decoderEl(d: DecoderPub, selected: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `decoder-marker ${d.connected ? 'on' : 'off'} ${selected ? 'selected' : ''}`;
  const box = document.createElement('div');
  box.className = 'decoder-marker-box';
  const label = document.createElement('div');
  label.className = 'decoder-marker-label';
  label.textContent = d.name;
  el.append(box, label);
  return el;
}

/**
 * Standalone map of every timing box, for the Decoders page. Fits itself to
 * whatever has a position; boxes without one simply do not appear.
 */
export function DecoderMap({
  decoders,
  selected,
  onSelect,
  onViewport,
}: {
  decoders: DecoderPub[];
  selected?: string;
  onSelect?: (deviceId: string) => void;
  /** Reports the visible area so the page can count what is on screen. */
  onViewport?: (b: { north: number; south: number; east: number; west: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  const fittedRef = useRef(false);
  // what was selected last render, so a deselect can be told from a re-render
  const prevSelectedRef = useRef<string | undefined>(undefined);
  // held in a ref so the map's listener never closes over a stale callback
  const viewportRef = useRef(onViewport);
  viewportRef.current = onViewport;
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: ref.current!,
      style: STYLES.streets,
      center: [-92.33, 38.9],
      zoom: 10,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    // Report the visible area after any pan, zoom or fly, and once on load.
    const report = () => {
      const b = map.getBounds();
      if (!b) return;
      viewportRef.current?.({ north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() });
    };
    map.on('moveend', report);
    map.once('load', report);
    mapRef.current = map;
    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const seen = new Set<string>();
    const bounds = new mapboxgl.LngLatBounds();

    for (const d of decoders) {
      if (d.lat === undefined || d.lon === undefined || (d.lat === 0 && d.lon === 0)) continue;
      seen.add(d.deviceId);
      bounds.extend([d.lon, d.lat]);
      let m = markers.get(d.deviceId);
      if (!m) {
        const el = decoderEl(d, d.deviceId === selected);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelect?.(d.deviceId);
        });
        m = new mapboxgl.Marker({ element: el }).setLngLat([d.lon, d.lat]).addTo(map);
        markers.set(d.deviceId, m);
      } else {
        m.setLngLat([d.lon, d.lat]);
        const el = m.getElement();
        el.className = `decoder-marker ${d.connected ? 'on' : 'off'} ${d.deviceId === selected ? 'selected' : ''}`;
        const label = el.querySelector('.decoder-marker-label');
        if (label) label.textContent = d.name;
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        m.remove();
        markers.delete(id);
      }
    }
    // fit once, so the operator's panning is not undone on every poll
    if (!fittedRef.current && !bounds.isEmpty() && !selected) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 15 });
      fittedRef.current = true;
    }
  }, [decoders, selected, onSelect]);

  /**
   * Picking a box flies to it; picking it again comes back out to everything.
   * With boxes spread across the country the wide view says nothing about
   * which corner one is on, and zooming by hand every time is tedious.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const was = prevSelectedRef.current;
    prevSelectedRef.current = selected;
    if (selected) {
      const d = decoders.find((x) => x.deviceId === selected);
      if (d?.lat !== undefined && d?.lon !== undefined && !(d.lat === 0 && d.lon === 0)) {
        map.flyTo({ center: [d.lon, d.lat], zoom: 15, duration: 900 });
      }
      return;
    }
    // deselected — back to the whole fleet, but not on the first render
    if (!was) return;
    const bounds = new mapboxgl.LngLatBounds();
    for (const d of decoders) {
      if (d.lat === undefined || d.lon === undefined || (d.lat === 0 && d.lon === 0)) continue;
      bounds.extend([d.lon, d.lat]);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 900 });
  }, [selected, decoders]);

  const switchStyle = (key: StyleKey) => {
    if (key === styleKey) return;
    setStyleKey(key);
    mapRef.current?.setStyle(STYLES[key]);
  };

  return (
    <div className="mini-map-wrap decoder-map-wrap">
      <div className="mini-map decoder-map-canvas" ref={ref} />
      <div className="map-style-toggle mini">
        <button className={styleKey === 'streets' ? 'on' : ''} onClick={() => switchStyle('streets')}>
          Map
        </button>
        <button className={styleKey === 'satellite' ? 'on' : ''} onClick={() => switchStyle('satellite')}>
          Satellite
        </button>
      </div>
    </div>
  );
}


/**
 * Small single-marker live map for the device detail dialog.
 *
 * Satellite matters more here than anywhere else: this map answers "where is
 * that tracker", and a bare street map tells you nothing when the answer is
 * "in the third trailer behind the school" or "under the trees by the creek".
 */
export function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markerRef = useRef<mapboxgl.Marker>(null);
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');

  useEffect(() => {
    const map = new mapboxgl.Map({ container: ref.current!, style: STYLES.streets, center: [lon, lat], zoom: 14 });
    const marker = new mapboxgl.Marker({ color: '#e70518' }).setLngLat([lon, lat]).addTo(map);
    mapRef.current = map;
    markerRef.current = marker;
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    markerRef.current?.setLngLat([lon, lat]);
    mapRef.current?.easeTo({ center: [lon, lat], duration: 500 });
  }, [lat, lon]);

  /** The marker is a DOM element, so it rides through a style swap untouched. */
  const switchStyle = (key: StyleKey) => {
    if (key === styleKey) return;
    setStyleKey(key);
    mapRef.current?.setStyle(STYLES[key]);
  };

  return (
    <div className="mini-map-wrap">
      <div className="mini-map" ref={ref} />
      <div className="map-style-toggle mini">
        <button className={styleKey === 'streets' ? 'on' : ''} onClick={() => switchStyle('streets')}>
          Map
        </button>
        <button className={styleKey === 'satellite' ? 'on' : ''} onClick={() => switchStyle('satellite')}>
          Satellite
        </button>
      </div>
    </div>
  );
}

/**
 * Course preview for the library: the line plus every placed marker. When
 * `onPick` is given, clicking the map reports where along the course you
 * clicked — that's how an aid station gets its mileage without measuring.
 */
export function CoursePreview({
  file,
  markers = [],
  onPick,
}: {
  file: string;
  markers?: CourseMarker[];
  onPick?: (lngLat: { lat: number; lon: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const readyRef = useRef(false);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  // 'load' fires after the markers have usually arrived; read them through a
  // ref so the handler doesn't draw the empty array it closed over.
  const markersRef = useRef(markers);
  markersRef.current = markers;

  useEffect(() => {
    let cancelled = false;
    api
      .courseGeometry(file)
      .then((data: { line: GeoJSON.Feature<GeoJSON.LineString> }) => {
        if (cancelled || !ref.current) return;
        const coords = data.line.geometry.coordinates as [number, number][];
        if (coords.length < 2) return;
        const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
        const map = new mapboxgl.Map({
          container: ref.current,
          style: STYLES.streets,
          bounds,
          fitBoundsOptions: { padding: 26 },
        });
        mapRef.current = map;
        map.on('click', (e) => pickRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
        map.on('load', () => {
          map.addSource('preview', { type: 'geojson', data: data.line });
          map.addLayer({
            id: 'preview',
            type: 'line',
            source: 'preview',
            paint: { 'line-color': '#2f7ded', 'line-width': 3 },
          });
          map.addSource('preview-markers', { type: 'geojson', data: emptyFc });
          map.addLayer({ id: 'preview-markers-dot', type: 'circle', source: 'preview-markers', paint: MARKER_DOT_PAINT });
          map.addLayer({
            id: 'preview-markers-label',
            type: 'symbol',
            source: 'preview-markers',
            layout: MARKER_LABEL_LAYOUT,
            paint: MARKER_LABEL_PAINT,
          });
          addTimingLayer(map, 'preview-markers-timing', 'preview-markers');
          readyRef.current = true;
          setMarkerData(map, markersRef.current);
        });
      })
      .catch(console.error);
    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  useEffect(() => {
    if (mapRef.current && readyRef.current) setMarkerData(mapRef.current, markers);
  }, [markers]);

  return <div className={`course-preview ${onPick ? 'pickable' : ''}`} ref={ref} />;
}

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** One look for course markers, shared by the race map and the course preview. */
export const MARKER_DOT_PAINT: mapboxgl.CircleLayerSpecification['paint'] = {
  'circle-radius': ['match', ['get', 'kind'], 'start', 6, 'finish', 6, 'custom', 5, 'timing', 5, 3.5],
  // distance posts are coloured by their unit — green miles, yellow kilometres
  // — so both sets stay readable on a course that carries each.
  'circle-color': [
    'case',
    ['==', ['get', 'kind'], 'start'], '#1fa860',
    ['==', ['get', 'kind'], 'finish'], '#e70518',
    ['==', ['get', 'kind'], 'timing'], '#c85fd4',
    ['==', ['get', 'kind'], 'custom'], '#5b74e8',
    ['==', ['get', 'units'], 'kilometers'], '#ffb02e',
    '#1fa860',
  ],
  'circle-stroke-width': 1.5,
  'circle-stroke-color': '#ffffff',
};
export const MARKER_LABEL_LAYOUT: mapboxgl.SymbolLayerSpecification['layout'] = {
  'text-field': ['get', 'label'],
  'text-size': ['match', ['get', 'kind'], 'unit', 10, 12],
  'text-offset': [0, 1.1],
  'text-anchor': 'top',
};

/**
 * Stopwatch badge for timing points. Drawn to a canvas and registered as a map
 * image rather than set as an emoji in the label — Mapbox renders labels from
 * SDF glyph fonts that have no emoji coverage, so ⏱ in a text-field silently
 * disappears.
 */
const STOPWATCH_ID = 'ptt-stopwatch';
function ensureStopwatch(map: mapboxgl.Map): void {
  if (map.hasImage(STOPWATCH_ID)) return;
  const px = 2;
  const size = 18 * px;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  if (!g) return;
  const c = size / 2;
  const r = 6.2 * px;
  g.lineWidth = 1.6 * px;
  g.strokeStyle = '#7a2f86';
  // crown + side button
  g.beginPath();
  g.moveTo(c - 2.6 * px, 2.1 * px);
  g.lineTo(c + 2.6 * px, 2.1 * px);
  g.stroke();
  g.beginPath();
  g.moveTo(c, 2.1 * px);
  g.lineTo(c, 4.1 * px);
  g.stroke();
  // body
  g.beginPath();
  g.arc(c, c + 1.1 * px, r, 0, Math.PI * 2);
  g.fillStyle = '#c85fd4';
  g.fill();
  g.stroke();
  // hand
  g.beginPath();
  g.moveTo(c, c + 1.1 * px);
  g.lineTo(c + 2.9 * px, c - 2.1 * px);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 1.5 * px;
  g.lineCap = 'round';
  g.stroke();
  map.addImage(STOPWATCH_ID, g.getImageData(0, 0, size, size), { pixelRatio: px });
}

/** Symbol layer drawing the stopwatch above timing-point markers. */
function addTimingLayer(map: mapboxgl.Map, id: string, source: string): void {
  ensureStopwatch(map);
  map.addLayer({
    id,
    type: 'symbol',
    source,
    filter: ['==', ['get', 'kind'], 'timing'],
    layout: {
      'icon-image': STOPWATCH_ID,
      'icon-anchor': 'bottom',
      'icon-offset': [0, -4],
      'icon-allow-overlap': true,
    },
  });
}
export const MARKER_LABEL_PAINT: mapboxgl.SymbolLayerSpecification['paint'] = {
  'text-color': '#1a2340',
  'text-halo-color': '#ffffff',
  'text-halo-width': 1.6,
};

/**
 * How far apart the unit posts have to be before they are worth drawing.
 *
 * A lap course is traced once per lap, so one street corner carries a mile
 * mark from every lap — a 124-mile race piles ~124 labels onto one loop. Zoomed
 * out you want the round numbers; zoomed in you want them all.
 */
const STEPS = [25, 10, 5, 2, 1];

export function markerStepFor(zoom: number, courseLength?: number): number {
  const byZoom = zoom < 9 ? 25 : zoom < 11 ? 10 : zoom < 12.5 ? 5 : zoom < 14 ? 2 : 1;
  // A 6k has five posts in total; thinning them by 25 leaves none, which is
  // not decluttering, it is deleting the course. Never coarser than roughly a
  // quarter of the course, so a short one keeps its marks at any zoom.
  if (!courseLength) return byZoom;
  const byLength = STEPS.find((s) => s <= courseLength / 4) ?? 1;
  return Math.min(byZoom, byLength);
}

/**
 * Which markers to draw right now.
 *
 * Start, finish, timing points and hand-placed marks are always drawn — there
 * are few of them and each one was put there deliberately. Only the unit posts
 * are thinned: by zoom, and during a live race to a band around where the
 * vehicles actually are, since lap one's marks are noise by lap four.
 */
export function visibleMarkers(
  markers: CourseMarker[],
  zoom: number,
  band?: { from: number; to: number; units: 'miles' | 'kilometers' },
  courseLength?: number,
): CourseMarker[] {
  const step = markerStepFor(zoom, courseLength);
  return markers.filter((m) => {
    if (m.kind !== 'unit') return true;
    // posts can be in either unit on the same course; compare in the band's
    const at = band ? toDisplay(m.at, m.units ?? band.units, band.units) : m.at;
    if (band && (at < band.from || at > band.to)) return false;
    return Math.abs(m.at / step - Math.round(m.at / step)) < 0.01;
  });
}

function setMarkerData(map: mapboxgl.Map, markers: CourseMarker[]) {
  const src = map.getSource('preview-markers') as mapboxgl.GeoJSONSource | undefined;
  src?.setData({
    type: 'FeatureCollection',
    features: markers.map((m) => ({
      type: 'Feature',
      properties: { label: m.label, kind: m.kind, units: m.units ?? '' },
      geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
    })),
  });
}

/** One map for one or many races: a course line per race, markers deduped by IMEI. */
export function MapView({
  races,
  selected,
  displayUnits,
  colors,
  labelOverrides,
  decimals = 2,
  decoders,
}: {
  races: RaceSnap[];
  selected?: MapSelection;
  /** Marker labels read in the console's units, like every other distance. */
  displayUnits: Units;
  /** Per-IMEI dot colour, shared with the panels so a dot maps to a row. */
  colors: Record<string, string>;
  /** Viewer pages name a marker by the role it is covering ("Lead Vehicle"),
   *  not the device on the bike — the role is what the watcher follows. */
  labelOverrides?: Record<string, string>;
  /** Decimals on the marker label; viewers can be given a coarser figure. */
  decimals?: number;
  /** RaceResult timing boxes, drawn alongside the vehicles when asked for. */
  decoders?: DecoderPub[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  const coursesRef = useRef(new Map<string, { line: GeoJSON.Feature; markers: CourseMarker[] }>());
  const loadedKeyRef = useRef<string>(null);
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');
  // With a full field of motos the name+distance labels overlap into an
  // unreadable pile; the colours alone are enough to tell them apart.
  const [showLabels, setShowLabels] = useState(true);
  // drives how densely the course posts are drawn; see visibleMarkers
  const [zoom, setZoom] = useState(11);
  // Timing boxes are off by default: they are course furniture, and the map is
  // primarily about where the vehicles are.
  const [showDecoders, setShowDecoders] = useState(false);
  const decoderMarkersRef = useRef(new Map<string, mapboxgl.Marker>());

  /** (Re-)add per-race course layers + the window-slice layer (lost on setStyle). */
  const applyCourseLayers = (fit: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    // clear all our layers, then re-add in order
    const style = map.getStyle();
    for (const layer of style?.layers ?? []) {
      if (layer.id.startsWith('course-') || layer.id.startsWith('markers-') || layer.id === 'window-slice') {
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      }
    }
    for (const srcId of Object.keys(style?.sources ?? {})) {
      if (srcId.startsWith('course-') || srcId.startsWith('markers-') || srcId === 'window-slice') {
        if (map.getSource(srcId)) map.removeSource(srcId);
      }
    }

    const bounds = new mapboxgl.LngLatBounds();
    let raceIdx = 0;
    for (const race of races) {
      const course = coursesRef.current.get(race.raceId);
      if (!course) continue;
      const id = `course-${race.raceId}`;
      map.addSource(id, { type: 'geojson', data: course.line });
      map.addLayer({
        id,
        type: 'line',
        source: id,
        paint: {
          'line-color': COURSE_COLORS[raceIdx % COURSE_COLORS.length],
          'line-width': 3,
          'line-opacity': 0.75,
        },
      });
      // Course markers: start/finish flags, mile/km posts, custom points.
      // Course markers are reference for a race in progress, so the source
      // starts empty and is filled only while that race is live — 68 mile and
      // km posts on a scheduled course is just clutter.
      const mid = `markers-${race.raceId}`;
      map.addSource(mid, { type: 'geojson', data: emptyFc });
      map.addLayer({ id: `${mid}-dot`, type: 'circle', source: mid, paint: MARKER_DOT_PAINT });
      map.addLayer({
        id: `${mid}-label`,
        type: 'symbol',
        source: mid,
        layout: MARKER_LABEL_LAYOUT,
        paint: MARKER_LABEL_PAINT,
      });
      addTimingLayer(map, `${mid}-timing`, mid);
      for (const c of (course.line as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates) {
        bounds.extend(c as [number, number]);
      }
      raceIdx++;
    }
    map.addSource('window-slice', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
    });
    map.addLayer({
      id: 'window-slice',
      type: 'line',
      source: 'window-slice',
      paint: { 'line-color': '#ffb02e', 'line-width': 6, 'line-opacity': 0.85 },
    });
    if (fit && !bounds.isEmpty()) map.fitBounds(bounds, { padding: 48 });
  };

  // init once
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: containerRef.current!,
      style: STYLES.streets,
      center: [-71.5, 42.23],
      zoom: 11,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.on('zoomend', () => setZoom(map.getZoom()));
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // load courses whenever the set of races changes
  const raceKey = races.map((r) => r.raceId).join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loadedKeyRef.current === raceKey) return;
    let cancelled = false;
    Promise.all(
      races.map(async (r) => {
        if (!coursesRef.current.has(r.raceId)) {
          const course = (await api.course(r.eventId, r.raceId)) as {
            line: GeoJSON.Feature;
            markers?: CourseMarker[];
          };
          coursesRef.current.set(r.raceId, { line: course.line, markers: course.markers ?? [] });
        }
      }),
    )
      .then(() => {
        if (cancelled) return;
        loadedKeyRef.current = raceKey;
        const run = () => applyCourseLayers(true);
        if (map.isStyleLoaded()) run();
        else map.once('load', run);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceKey]);

  // basemap style toggle — layers are lost on setStyle, so re-add after load
  const switchStyle = (key: StyleKey) => {
    const map = mapRef.current;
    if (!map || key === styleKey) return;
    setStyleKey(key);
    map.setStyle(STYLES[key]);
    map.once('style.load', () => applyCourseLayers(false));
  };

  // markers + selected window slice
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = markersRef.current;
    const seen = new Set<string>();

    // Union of trackers across races, deduped by IMEI (one physical device =
    // one marker). Prefer the selected race's copy, else the first with a fix.
    const byImei = new Map<string, { t: TrackerPub; units: Units }>();
    for (const race of races) {
      for (const t of race.trackers) {
        const existing = byImei.get(t.imei);
        const preferThis = selected?.imei === t.imei && selected.raceId === race.raceId;
        if (!existing || preferThis) byImei.set(t.imei, { t, units: race.units });
      }
    }

    for (const [imei, { t, units }] of byImei) {
      if (!t.lastFix) continue;
      seen.add(imei);
      let marker = markers.get(imei);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'map-marker';
        const dot = document.createElement('div');
        dot.className = 'map-marker-dot';
        dot.style.background = colors[imei] ?? MARKER_COLORS[0];
        const label = document.createElement('div');
        label.className = 'map-marker-label';
        el.append(dot, label);
        marker = new mapboxgl.Marker({ element: el }).setLngLat([t.lastFix.lon, t.lastFix.lat]).addTo(map);
        markers.set(imei, marker);
      } else {
        marker.setLngLat([t.lastFix.lon, t.lastFix.lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('selected', imei === selected?.imei);
      el.classList.toggle('no-label', !showLabels);
      el.classList.toggle('suspect', !!t.suspect);
      const label = el.querySelector('.map-marker-label') as HTMLDivElement;
      // The engine measures in the race's units; the label reads in the
      // operator's, and says which — an unlabelled 0.09 next to a panel
      // reading 0.14 km is just the same distance in miles.
      const dist =
        t.distance !== undefined
          ? ` · ${toDisplay(t.distance, units, displayUnits).toFixed(decimals)} ${unitAbbr(displayUnits)}`
          : '';
      label.textContent = `${labelOverrides?.[imei] ?? t.label}${dist}`;
    }
    for (const [imei, m] of markers) {
      if (!seen.has(imei)) {
        m.remove();
        markers.delete(imei);
      }
    }

    for (const race of races) {
      const src = map.getSource(`markers-${race.raceId}`) as mapboxgl.GeoJSONSource | undefined;
      if (!src) continue;
      const course = coursesRef.current.get(race.raceId);
      if (race.status !== 'live' || !course) {
        src.setData(emptyFc);
        continue;
      }
      // The band follows the vehicles: a little behind the last one so a mark
      // just passed is still on screen, and further ahead because what is
      // coming up is what anyone is actually asking about.
      const distances = race.trackers.map((t) => t.distance).filter((d): d is number => d !== undefined);
      const band = distances.length
        ? {
            from: Math.min(...distances) - BAND_BEHIND[race.units],
            to: Math.max(...distances) + BAND_AHEAD[race.units],
            units: race.units,
          }
        : undefined;
      src.setData({
        type: 'FeatureCollection',
        features: visibleMarkers(course.markers, zoom, band, race.courseLength).map((m) => ({
          type: 'Feature',
          properties: { label: m.label, kind: m.kind, units: m.units ?? '' },
          geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        })),
      });
    }

    const selRace = races.find((r) => r.raceId === selected?.raceId);
    const sel = selRace?.trackers.find((t) => t.imei === selected?.imei);
    const src = map.getSource('window-slice') as mapboxgl.GeoJSONSource | undefined;
    src?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: sel?.slice && sel.slice.length > 1 ? sel.slice : [] },
    });
  }, [races, selected, displayUnits, colors, showLabels, labelOverrides, decimals, zoom]);

  // timing boxes, as their own marker set so they never disturb the vehicles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = decoderMarkersRef.current;
    const wanted = showDecoders ? (decoders ?? []) : [];
    const seen = new Set<string>();
    for (const d of wanted) {
      if (d.lat === undefined || d.lon === undefined || (d.lat === 0 && d.lon === 0)) continue;
      seen.add(d.deviceId);
      let m = markers.get(d.deviceId);
      if (!m) {
        m = new mapboxgl.Marker({ element: decoderEl(d, false) }).setLngLat([d.lon, d.lat]).addTo(map);
        markers.set(d.deviceId, m);
      } else {
        m.setLngLat([d.lon, d.lat]);
        const el = m.getElement();
        el.className = `decoder-marker ${d.connected ? 'on' : 'off'}`;
        const label = el.querySelector('.decoder-marker-label');
        if (label) label.textContent = d.name;
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        m.remove();
        markers.delete(id);
      }
    }
  }, [decoders, showDecoders]);

  return (
    <div className="map-wrap">
      <div className="map" ref={containerRef} />
      <div className="map-style-toggle">
        <button className={styleKey === 'streets' ? 'on' : ''} onClick={() => switchStyle('streets')}>
          Map
        </button>
        <button className={styleKey === 'satellite' ? 'on' : ''} onClick={() => switchStyle('satellite')}>
          Satellite
        </button>
        <button
          className={`map-label-toggle ${showLabels ? 'on' : ''}`}
          title={showLabels ? 'Hide tracker names on the map' : 'Show tracker names on the map'}
          onClick={() => setShowLabels((v) => !v)}
        >
          Labels
        </button>
        {decoders && decoders.length > 0 && (
          <button
            className={showDecoders ? 'on' : ''}
            title={`${decoders.filter((d) => d.connected).length} of ${decoders.length} timing boxes online`}
            onClick={() => setShowDecoders((v) => !v)}
          >
            Decoders
          </button>
        )}
      </div>
      {races.length > 1 && (
        <div className="map-legend">
          {races.map((r, i) => (
            <span key={r.raceId}>
              <span className="legend-swatch" style={{ background: COURSE_COLORS[i % COURSE_COLORS.length] }} />
              {r.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

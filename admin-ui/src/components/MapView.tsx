import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RaceSnap, TrackerPub } from '../types';

export interface CourseMarker {
  at: number;
  label: string;
  kind: 'start' | 'finish' | 'unit' | 'custom' | 'timing';
  units?: 'miles' | 'kilometers';
  lat: number;
  lon: number;
}

// Public (pk.) Mapbox token — same account/token the legacy admin pages use.
// Override with VITE_MAPBOX_TOKEN at build time if the token is ever rotated.
mapboxgl.accessToken =
  import.meta.env.VITE_MAPBOX_TOKEN ??
  'MAPBOX_TOKEN_FROM_ENV';

const STYLES = {
  streets: 'mapbox://styles/mapbox/light-v10',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
} as const;
type StyleKey = keyof typeof STYLES;

const MARKER_COLORS = ['#e8484d', '#2f7ded', '#1fa860', '#c85fd4', '#e8842f', '#12a5a5', '#96981f', '#777'];
const COURSE_COLORS = ['#2f7ded', '#1fa860', '#c85fd4', '#e8842f', '#12a5a5'];

export interface MapSelection {
  raceId: string;
  imei: string;
}

/** Small single-marker live map for the device detail dialog. */
export function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markerRef = useRef<mapboxgl.Marker>(null);

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

  return <div className="mini-map" ref={ref} />;
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
export function MapView({ races, selected }: { races: RaceSnap[]; selected?: MapSelection }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  const coursesRef = useRef(new Map<string, { line: GeoJSON.Feature; markers: CourseMarker[] }>());
  const loadedKeyRef = useRef<string>(null);
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');

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
    const byImei = new Map<string, { t: TrackerPub; colorIdx: number }>();
    let idx = 0;
    for (const race of races) {
      for (const t of race.trackers) {
        const existing = byImei.get(t.imei);
        const preferThis = selected?.imei === t.imei && selected.raceId === race.raceId;
        if (!existing || preferThis) {
          byImei.set(t.imei, { t, colorIdx: existing?.colorIdx ?? idx });
        }
        if (!existing) idx++;
      }
    }

    for (const [imei, { t, colorIdx }] of byImei) {
      if (!t.lastFix) continue;
      seen.add(imei);
      let marker = markers.get(imei);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'map-marker';
        const dot = document.createElement('div');
        dot.className = 'map-marker-dot';
        dot.style.background = MARKER_COLORS[colorIdx % MARKER_COLORS.length];
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
      el.classList.toggle('suspect', !!t.suspect);
      const label = el.querySelector('.map-marker-label') as HTMLDivElement;
      label.textContent = `${t.label}${t.distance !== undefined ? ` · ${t.distance.toFixed(2)}` : ''}`;
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
      src.setData(
        race.status === 'live' && course
          ? {
              type: 'FeatureCollection',
              features: course.markers.map((m) => ({
                type: 'Feature',
                properties: { label: m.label, kind: m.kind, units: m.units ?? '' },
                geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
              })),
            }
          : emptyFc,
      );
    }

    const selRace = races.find((r) => r.raceId === selected?.raceId);
    const sel = selRace?.trackers.find((t) => t.imei === selected?.imei);
    const src = map.getSource('window-slice') as mapboxgl.GeoJSONSource | undefined;
    src?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: sel?.slice && sel.slice.length > 1 ? sel.slice : [] },
    });
  }, [races, selected]);

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

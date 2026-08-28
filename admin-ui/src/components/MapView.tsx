import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RaceSnap, TrackerPub } from '../types';

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

/** One map for one or many races: a course line per race, markers deduped by IMEI. */
export function MapView({ races, selected }: { races: RaceSnap[]; selected?: MapSelection }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  const coursesRef = useRef(new Map<string, GeoJSON.Feature>());
  const loadedKeyRef = useRef<string>(null);
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');

  /** (Re-)add per-race course layers + the window-slice layer (lost on setStyle). */
  const applyCourseLayers = (fit: boolean) => {
    const map = mapRef.current;
    if (!map) return;
    // clear all our layers, then re-add in order
    const style = map.getStyle();
    for (const layer of style?.layers ?? []) {
      if (layer.id.startsWith('course-') || layer.id === 'window-slice') {
        if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      }
    }
    for (const srcId of Object.keys(style?.sources ?? {})) {
      if (srcId.startsWith('course-') || srcId === 'window-slice') {
        if (map.getSource(srcId)) map.removeSource(srcId);
      }
    }

    const bounds = new mapboxgl.LngLatBounds();
    let raceIdx = 0;
    for (const race of races) {
      const course = coursesRef.current.get(race.raceId);
      if (!course) continue;
      const id = `course-${race.raceId}`;
      map.addSource(id, { type: 'geojson', data: course });
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
      for (const c of (course as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates) {
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
          const course = await api.course(r.raceId);
          coursesRef.current.set(r.raceId, course.line);
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

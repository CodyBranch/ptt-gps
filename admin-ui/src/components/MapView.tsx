import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { RaceSnap } from '../types';

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

export function MapView({ race, selectedImei }: { race: RaceSnap; selectedImei?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map>(null);
  const markersRef = useRef(new Map<string, mapboxgl.Marker>());
  const courseRef = useRef<GeoJSON.Feature | null>(null);
  const loadedRaceRef = useRef<string>(null);
  const [styleKey, setStyleKey] = useState<StyleKey>('streets');

  /** (Re-)add course + window-slice layers — needed after every setStyle. */
  const applyCourseLayers = (fit: boolean) => {
    const map = mapRef.current;
    const course = courseRef.current;
    if (!map || !course) return;
    for (const id of ['course-line', 'window-slice']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    map.addSource('course-line', { type: 'geojson', data: course });
    map.addLayer({
      id: 'course-line',
      type: 'line',
      source: 'course-line',
      paint: { 'line-color': '#2f7ded', 'line-width': 3, 'line-opacity': 0.8 },
    });
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
    if (fit) {
      const coords = (course as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates;
      const bounds = coords.reduce(
        (b, c) => b.extend(c as [number, number]),
        new mapboxgl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]),
      );
      map.fitBounds(bounds, { padding: 48 });
    }
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

  // course per race
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loadedRaceRef.current === race.raceId) return;
    let cancelled = false;
    api
      .course(race.raceId)
      .then((course) => {
        if (cancelled) return;
        courseRef.current = course.line;
        loadedRaceRef.current = race.raceId;
        const run = () => applyCourseLayers(true);
        if (map.isStyleLoaded()) run();
        else map.once('load', run);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [race.raceId]);

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

    race.trackers.forEach((t, i) => {
      if (!t.lastFix) return;
      seen.add(t.imei);
      let marker = markers.get(t.imei);
      if (!marker) {
        const el = document.createElement('div');
        el.className = 'map-marker';
        const dot = document.createElement('div');
        dot.className = 'map-marker-dot';
        dot.style.background = MARKER_COLORS[i % MARKER_COLORS.length];
        const label = document.createElement('div');
        label.className = 'map-marker-label';
        el.append(dot, label);
        marker = new mapboxgl.Marker({ element: el }).setLngLat([t.lastFix.lon, t.lastFix.lat]).addTo(map);
        markers.set(t.imei, marker);
      } else {
        marker.setLngLat([t.lastFix.lon, t.lastFix.lat]);
      }
      const el = marker.getElement();
      el.classList.toggle('selected', t.imei === selectedImei);
      el.classList.toggle('suspect', !!t.suspect);
      const label = el.querySelector('.map-marker-label') as HTMLDivElement;
      label.textContent = `${t.label}${t.distance !== undefined ? ` · ${t.distance.toFixed(2)}` : ''}`;
    });
    for (const [imei, m] of markers) {
      if (!seen.has(imei)) {
        m.remove();
        markers.delete(imei);
      }
    }

    const sel = race.trackers.find((t) => t.imei === selectedImei);
    const src = map.getSource('window-slice') as mapboxgl.GeoJSONSource | undefined;
    src?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: sel?.slice && sel.slice.length > 1 ? sel.slice : [] },
    });
  }, [race, selectedImei]);

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
    </div>
  );
}

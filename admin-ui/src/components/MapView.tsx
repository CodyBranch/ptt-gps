import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { api } from '../api';
import type { RaceSnap } from '../types';

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const MARKER_COLORS = ['#e8484d', '#2f7ded', '#1fa860', '#c85fd4', '#e8842f', '#12a5a5', '#96981f', '#777'];

export function MapView({ race, selectedImei }: { race: RaceSnap; selectedImei?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>(null);
  const markersRef = useRef(new Map<string, maplibregl.Marker>());
  const loadedRaceRef = useRef<string>(null);

  // init once
  useEffect(() => {
    const map = new maplibregl.Map({ container: containerRef.current!, style: OSM_STYLE, center: [-71.5, 42.23], zoom: 11 });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    mapRef.current = map;
    return () => map.remove();
  }, []);

  // course line per race
  useEffect(() => {
    const map = mapRef.current;
    if (!map || loadedRaceRef.current === race.raceId) return;
    let cancelled = false;

    const apply = async () => {
      const course = await api.course(race.raceId);
      if (cancelled) return;
      const addLayers = () => {
        for (const id of ['course-line', 'window-slice']) {
          if (map.getLayer(id)) map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        }
        map.addSource('course-line', { type: 'geojson', data: course.line });
        map.addLayer({
          id: 'course-line',
          type: 'line',
          source: 'course-line',
          paint: { 'line-color': '#2f7ded', 'line-width': 3, 'line-opacity': 0.75 },
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
        const coords = (course.line as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates;
        const bounds = coords.reduce(
          (b, c) => b.extend(c as [number, number]),
          new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]),
        );
        map.fitBounds(bounds, { padding: 48 });
        loadedRaceRef.current = race.raceId;
      };
      if (map.isStyleLoaded()) addLayers();
      else map.once('load', addLayers);
    };
    apply().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [race.raceId]);

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
        marker = new maplibregl.Marker({ element: el }).setLngLat([t.lastFix.lon, t.lastFix.lat]).addTo(map);
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
    const src = map.getSource('window-slice') as maplibregl.GeoJSONSource | undefined;
    src?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: sel?.slice && sel.slice.length > 1 ? sel.slice : [] },
    });
  }, [race, selectedImei]);

  return <div className="map" ref={containerRef} />;
}

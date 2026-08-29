import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { kml } from '@tmcw/togeojson';
import * as turf from '@turf/turf';
import type { Feature, LineString } from 'geojson';

export interface Course {
  /** The course path as a single LineString (start → finish). */
  line: Feature<LineString>;
  /** Total length in the given units. */
  length: number;
  units: 'miles' | 'kilometers';
}

/**
 * Load a course from KML (the course-prep workflow: Google Earth etc.) or
 * GeoJSON. Takes the first LineString found; a MultiGeometry/route split into
 * segments is not auto-joined — export the course as one path.
 */
export function loadCourse(filePath: string, units: 'miles' | 'kilometers'): Course {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseCourse(text, filePath.toLowerCase().endsWith('.kml'), units);
}

/** Parse course content directly (KML uploads from the setup UI). */
export function parseCourse(text: string, isKml: boolean, units: 'miles' | 'kilometers'): Course {
  let line: Feature<LineString> | undefined;

  if (isKml) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const fc = kml(doc as unknown as Parameters<typeof kml>[0]);
    line = extractLine(fc.features as Feature[]);
  } else {
    const gj = JSON.parse(text);
    const features: Feature[] =
      gj.type === 'FeatureCollection' ? gj.features
      : gj.type === 'Feature' ? [gj]
      : [{ type: 'Feature', properties: {}, geometry: gj }];
    line = extractLine(features);
  }

  if (!line) throw new Error('No LineString found in course file');
  // Strip altitude — 2D coordinates keep every turf operation consistent.
  line.geometry.coordinates = line.geometry.coordinates.map((c) => [c[0], c[1]]);
  return { line, length: turf.length(line, { units }), units };
}

export interface PlacedMarker {
  /** Distance along the course, in the course's own units. */
  at: number;
  label: string;
  kind: 'start' | 'finish' | 'unit' | 'custom' | 'timing';
  /** Which unit a distance post counts in — mile and km posts are drawn
   *  differently, and a course can carry both sets. */
  units?: 'miles' | 'kilometers';
  lat: number;
  lon: number;
}

const MI_PER_KM = 0.621371;
const convert = (v: number, from: 'miles' | 'kilometers', to: 'miles' | 'kilometers') =>
  from === to ? v : from === 'miles' ? v / MI_PER_KM : v * MI_PER_KM;

/**
 * Put a course's markers on the line: start, finish, whole-unit distance posts,
 * and the custom entries (aid stations, timing mats). Markers are authored
 * against the course in its own marker units — the posts are painted on the
 * road, so they don't change because a race measures itself in kilometres —
 * and are converted onto whatever units the caller's course is loaded in.
 */
export function placeMarkers(
  course: Course,
  cfg: {
    auto: boolean;
    units: 'miles' | 'kilometers';
    markers: Array<{ at: number; label: string; kind?: 'point' | 'post' | 'timing'; units?: 'miles' | 'kilometers' }>;
  },
): PlacedMarker[] {
  const out: PlacedMarker[] = [];
  const place = (at: number, label: string, kind: PlacedMarker['kind'], units?: 'miles' | 'kilometers') => {
    const clamped = Math.min(Math.max(at, 0), course.length);
    const p = turf.along(course.line, clamped, { units: course.units });
    out.push({ at: clamped, label, kind, units, lon: p.geometry.coordinates[0], lat: p.geometry.coordinates[1] });
  };

  place(0, 'START', 'start');
  place(course.length, 'FINISH', 'finish');

  if (cfg.auto) {
    const unit = cfg.units === 'miles' ? 'mi' : 'km';
    const lengthInMarkerUnits = convert(course.length, course.units, cfg.units);
    for (let d = 1; d < lengthInMarkerUnits; d++) {
      place(convert(d, cfg.units, course.units), `${d} ${unit}`, 'unit', cfg.units);
    }
  }
  for (const m of cfg.markers) {
    // each marker carries its own unit; fall back to the course's default
    const at = convert(m.at, m.units ?? cfg.units, course.units);
    if (at <= course.length) {
      const mu = m.units ?? cfg.units;
      place(at, m.label, m.kind === 'timing' ? 'timing' : m.kind === 'post' ? 'unit' : 'custom', mu);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Distance along the course of the point nearest to a lat/lon — lets the
 *  course editor place a marker by clicking the map. */
export function locateOnCourse(course: Course, lat: number, lon: number): { at: number; lat: number; lon: number } {
  const snapped = turf.nearestPointOnLine(course.line, turf.point([lon, lat]), { units: course.units });
  return {
    at: snapped.properties.location ?? 0,
    lon: snapped.geometry.coordinates[0],
    lat: snapped.geometry.coordinates[1],
  };
}

function extractLine(features: Feature[]): Feature<LineString> | undefined {
  for (const f of features) {
    if (f.geometry?.type === 'LineString') return f as Feature<LineString>;
    if (f.geometry?.type === 'MultiLineString' && f.geometry.coordinates.length === 1) {
      return turf.lineString(f.geometry.coordinates[0]);
    }
  }
  return undefined;
}

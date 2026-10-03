import fs from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { gpx, kml } from '@tmcw/togeojson';
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
  return parseCourse(text, formatFromName(filePath), units);
}

/** The format a filename suggests, used only when the content is ambiguous. */
export function formatFromName(file: string): CourseFormat | undefined {
  const f = file.toLowerCase();
  if (f.endsWith('.kml')) return 'kml';
  if (f.endsWith('.gpx')) return 'gpx';
  if (f.endsWith('.json') || f.endsWith('.geojson')) return 'geojson';
  return undefined;
}

/**
 * What a course file is, read from the file rather than from its name.
 *
 * Courses arrive from whatever drew them: Google Earth writes KML, a watch or
 * RaceResult writes GPX, our own tools write GeoJSON. An extension is a guess
 * - files get renamed, and a sync sends content with no filename at all - so
 * the content decides and the name is only the tie-breaker.
 */
export type CourseFormat = 'kml' | 'gpx' | 'geojson';

export function detectFormat(text: string, hint?: CourseFormat): CourseFormat {
  const head = text.slice(0, 2048).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'geojson';
  if (/<gpx[\s>]/i.test(head)) return 'gpx';
  if (/<kml[\s>]/i.test(head)) return 'kml';
  return hint ?? 'geojson';
}

/** Every feature a course file holds, whatever it was written by. */
function featuresOf(text: string, format: CourseFormat): Feature[] {
  if (format === 'geojson') {
    const gj = JSON.parse(text);
    return gj.type === 'FeatureCollection' ? gj.features
      : gj.type === 'Feature' ? [gj]
      : [{ type: 'Feature', properties: {}, geometry: gj }];
  }
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const fc = format === 'gpx'
    ? gpx(doc as unknown as Parameters<typeof gpx>[0])
    : kml(doc as unknown as Parameters<typeof kml>[0]);
  return fc.features as Feature[];
}

/** Parse course content directly (an upload, or a course pushed in by sync). */
export function parseCourse(text: string, hint: CourseFormat | undefined, units: 'miles' | 'kilometers'): Course {
  const line = extractLine(featuresOf(text, detectFormat(text, hint)));

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

/**
 * How many separate paths a course file contains.
 *
 * Only the first is used, and a route exported in pieces looks exactly like a
 * whole one until the distances come out short - so anything accepting a
 * course from somewhere other than a person at this console should say when
 * it finds more than one.
 */
export function countPaths(text: string, hint?: CourseFormat): number {
  let features: Feature[];
  try {
    features = featuresOf(text, detectFormat(text, hint));
  } catch {
    return 0;
  }
  let paths = 0;
  for (const f of features) {
    if (f.geometry?.type === 'LineString') paths++;
    else if (f.geometry?.type === 'MultiLineString') paths += f.geometry.coordinates.length;
  }
  return paths;
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

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

function extractLine(features: Feature[]): Feature<LineString> | undefined {
  for (const f of features) {
    if (f.geometry?.type === 'LineString') return f as Feature<LineString>;
    if (f.geometry?.type === 'MultiLineString' && f.geometry.coordinates.length === 1) {
      return turf.lineString(f.geometry.coordinates[0]);
    }
  }
  return undefined;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { saveCourseIn } from '../src/config/manager.js';

/**
 * What a course upload says it saved.
 *
 * The name it answers with is the name everything downstream uses: the row
 * recording that the course arrived is filed under it, and it is what the
 * operator is shown and may well type into a race. It said `.kml` whatever had
 * actually been written, so a GPX - which is what RaceResult and every watch
 * exports - came back as a path to a file that was not there.
 */

let dir: string;

const GPX =
  '<?xml version="1.0"?><gpx version="1.0" creator="t"><trk><trkseg>' +
  '<trkpt lat="43.0366" lon="-87.8990"/><trkpt lat="43.0346" lon="-87.8997"/>' +
  '<trkpt lat="43.0335" lon="-87.8999"/></trkseg></trk></gpx>';

const KML =
  '<?xml version="1.0"?><kml><Document><Placemark><LineString><coordinates>' +
  '-87.8990,43.0366 -87.8997,43.0346 -87.8999,43.0335' +
  '</coordinates></LineString></Placemark></Document></kml>';

const GEOJSON = JSON.stringify({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: [[-87.899, 43.0366], [-87.8997, 43.0346], [-87.8999, 43.0335]] },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-course-'));
});

describe('saveCourseIn', () => {
  it.each([
    ['a GPX', 'lakefront-5k.gpx', GPX, 'gpx'],
    ['a KML', 'lakefront-5k.kml', KML, 'kml'],
    ['a GeoJSON', 'lakefront-5k.geojson', GEOJSON, 'geojson'],
  ])('names %s by what it wrote, and writes it there', (_what, name, text, ext) => {
    const saved = saveCourseIn(dir, name, text);
    expect(saved.file).toBe(`courses/lakefront-5k.${ext}`);
    expect(fs.existsSync(path.join(dir, saved.file))).toBe(true);
    expect(fs.readFileSync(path.join(dir, saved.file), 'utf8')).toBe(text);
  });

  it('goes by the content, not by what the file was called', () => {
    // A GPX saved from a browser as .txt, or renamed on the way over.
    expect(saveCourseIn(dir, 'course.kml', GPX).file).toBe('courses/course.gpx');
  });

  it('measures the course it saved', () => {
    const saved = saveCourseIn(dir, 'lakefront-5k.gpx', GPX);
    expect(saved.points).toBe(3);
    expect(saved.lengthMi).toBeGreaterThan(0);
    expect(saved.replaced).toBe(false);
  });

  it('refuses a second course of the same name, and says the name it means', () => {
    saveCourseIn(dir, 'lakefront-5k.gpx', GPX);
    expect(() => saveCourseIn(dir, 'lakefront-5k.gpx', GPX)).toThrow(/lakefront-5k\.gpx already exists/);
  });

  it('replaces when asked, and reports it as a replacement', () => {
    saveCourseIn(dir, 'lakefront-5k.gpx', GPX);
    expect(saveCourseIn(dir, 'lakefront-5k.gpx', GPX, { replace: true }).replaced).toBe(true);
  });

  it('refuses a name with nothing left once the extension comes off', () => {
    expect(() => saveCourseIn(dir, '.gpx', GPX)).toThrow(/Invalid course name/);
  });

  it('strips a name down to what is safe in a path', () => {
    // Not a traversal guard so much as the reason one is not needed: dots and
    // separators are not in the set of characters that survive.
    expect(saveCourseIn(dir, '../../Lakefront 5K!.gpx', GPX).file).toBe('courses/-lakefront-5k-.gpx');
  });
});

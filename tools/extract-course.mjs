// Extract the lineStringCoords course from a legacy admin HTML page into KML.
//   node tools/extract-course.mjs <legacy-admin.html> <out.kml> [name]
import fs from 'node:fs';

const [, , input, output, name = 'Course'] = process.argv;
if (!input || !output) {
  console.error('Usage: node tools/extract-course.mjs <legacy-admin.html> <out.kml> [name]');
  process.exit(1);
}

const html = fs.readFileSync(input, 'utf8');
const m = html.match(/lineStringCoords\s*=\s*\[([\s\S]*?)\]\s*;/);
if (!m) {
  console.error('No lineStringCoords array found');
  process.exit(1);
}
const coords = [...m[1].matchAll(/\[\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*\]/g)].map(
  (c) => `${c[1]},${c[2]},0`,
);
if (coords.length < 2) {
  console.error('Could not parse coordinates');
  process.exit(1);
}

const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>${name}</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>
          ${coords.join('\n          ')}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
`;
fs.writeFileSync(output, kml);
console.log(`${output}: ${coords.length} points`);

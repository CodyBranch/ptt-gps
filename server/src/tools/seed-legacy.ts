import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../state/store.js';
import { parseCourse } from '../engine/course.js';

/**
 * One-off import from the legacy CouchDB into the new store.
 *
 * Pulls the two things that are genuinely worth carrying over — the tracker
 * inventory and the course library — and leaves everything else behind. Live
 * positions are not imported: they are whatever the devices report next, and
 * seeding stale ones would put ghosts on the map.
 *
 *   npm run seed-legacy -w server -- --couch http://user:pass@host:5984 [--dry-run] [--overwrite]
 *
 * Idempotent: devices upsert by IMEI, courses skip files that already exist
 * unless --overwrite, so it can be re-run as the legacy box keeps running.
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const DRY = has('dry-run');
const OVERWRITE = has('overwrite');
const couch = arg('couch');
if (!couch) {
  console.error('Usage: --couch http://user:pass@host:5984 [--dry-run] [--overwrite]');
  process.exit(1);
}

const eventsDir = path.resolve(arg('events-dir') ?? (fs.existsSync('../events') ? '../events' : 'events'));
const coursesDir = path.join(eventsDir, 'courses');

// fetch() refuses URLs carrying credentials, so split them into a header.
const src = new URL(couch!);
const auth = src.username ? `Basic ${Buffer.from(`${decodeURIComponent(src.username)}:${decodeURIComponent(src.password)}`).toString('base64')}` : undefined;
const base = `${src.protocol}//${src.host}${src.pathname.replace(/\/$/, '')}`;

interface CouchRow<T> { id: string; doc?: T }
async function allDocs<T>(db: string): Promise<T[]> {
  const res = await fetch(`${base}/${db}/_all_docs?include_docs=true`, {
    headers: auth ? { authorization: auth } : {},
  });
  if (!res.ok) throw new Error(`${db}: HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { rows: Array<CouchRow<T>> };
  return json.rows.filter((r) => !r.id.startsWith('_design') && r.doc).map((r) => r.doc!);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');

/** Vehicle-powered units report no battery percentage. */
const isPowered = (model: string) => /^GV|pepwave|peplink/i.test(model);

interface LegacyDevice {
  _id: string;
  imei?: string;
  model?: string;
  nickName?: string;
  deviceID?: string;
  hologramSIM?: string;
  hologramID?: string;
}

interface LegacyCourse {
  _id: string;
  meet_id?: string;
  course?: string;
  path?: Array<[number, number]>;
  splitPoints?: string[];
  splitIcons?: string[];
  lead_pri?: string;
  lead_bu?: string;
  trail?: string;
  trail2?: string;
  timer?: string;
  crowd?: string;
}

/**
 * Legacy split labels are "3M" / "4K" — a distance and its unit. They become
 * course markers directly; start and finish are dropped because the new engine
 * always places those itself from the course geometry.
 */
function markersFrom(doc: LegacyCourse): Array<{ at: number; label: string; kind: 'post'; units: 'miles' | 'kilometers' }> {
  const points = doc.splitPoints ?? [];
  const icons = doc.splitIcons ?? [];
  const out = new Map<string, { at: number; label: string; kind: 'post'; units: 'miles' | 'kilometers' }>();
  points.forEach((label, i) => {
    const icon = icons[i];
    if (icon === 'start' || icon === 'finish') return;
    const m = /^(\d+(?:\.\d+)?)([MK])$/i.exec(String(label).trim());
    if (!m) return;
    const at = Number(m[1]);
    if (!Number.isFinite(at) || at <= 0) return;
    const units = m[2].toUpperCase() === 'M' ? ('miles' as const) : ('kilometers' as const);
    out.set(`${at}${units}`, { at, label: `${at} ${units === 'miles' ? 'mi' : 'km'}`, kind: 'post', units });
  });
  return [...out.values()].sort((a, b) => (a.units === 'miles' ? a.at : a.at * 0.621371) - (b.units === 'miles' ? b.at : b.at * 0.621371));
}

async function main(): Promise<void> {
  const store = new Store(arg('db', 'data/ptt.db')!);
  console.log(`[seed] source ${base}${auth ? ' (authenticated)' : ''}`);
  console.log(`[seed] courses → ${coursesDir}${DRY ? '   (DRY RUN — nothing is written)' : ''}\n`);

  // ---- trackers ----------------------------------------------------------
  const allDevices = await allDocs<LegacyDevice>('devices');
  // The fleet is keyed by IMEI and the ingest pipeline identifies devices by
  // it; the in-vehicle Peplink routers are recorded with 4-character serials,
  // so they are reported rather than imported under an invented key.
  const notTrackers = allDevices.filter((d) => d.imei && !/^\d{15}$/.test(d.imei));
  const devices = allDevices.filter((d) => /^\d{15}$/.test(d.imei ?? ''));
  const owners = new Map<string, number>();
  let added = 0;
  for (const d of devices) {
    const label = (d.nickName || d.imei)!.trim();
    // "PTT-3" / "Krush-5" — the prefix is the owning organisation
    const ownerName = /^([A-Za-z]+)-/.exec(label)?.[1];
    let ownerId: number | undefined;
    if (ownerName) {
      if (!owners.has(ownerName)) owners.set(ownerName, DRY ? -1 : store.addOwner(ownerName).id);
      ownerId = owners.get(ownerName);
    }
    const sim = [d.hologramSIM && `SIM ${d.hologramSIM}`, d.hologramID && `Hologram ${d.hologramID}`]
      .filter(Boolean)
      .join(' · ');
    const notes = [sim, d.deviceID ? `legacy id ${d.deviceID}` : ''].filter(Boolean).join(' · ') || undefined;
    if (!DRY) {
      store.upsertFleet({
        imei: d.imei!,
        label,
        model: d.model || undefined,
        hasBattery: !isPowered(d.model ?? ''),
        notes,
        ownerId: ownerId && ownerId > 0 ? ownerId : null,
        retired: false,
      });
    }
    added++;
  }
  console.log(`[seed] trackers: ${added} devices, owners: ${[...owners.keys()].join(', ') || 'none'}`);
  for (const d of notTrackers) {
    console.warn(`  ! not a tracker, skipped: "${d.nickName ?? d._id}" (${d.model ?? '?'}, id "${d.imei}")`);
  }

  // ---- courses -----------------------------------------------------------
  if (!DRY) fs.mkdirSync(coursesDir, { recursive: true });
  const courses = await allDocs<LegacyCourse>('courses');
  const roleRefs: Record<string, Record<string, string>> = {};
  let written = 0, skipped = 0, empty = 0, markerTotal = 0;

  // CouchDB auto-generated ids: strays saved without a name. Both in the live
  // data are junk (one empty, one an exact duplicate of a named course), and a
  // course called "e04b30de…" helps nobody.
  const seen = new Map<string, string>();
  for (const c of courses) {
    if (/^[0-9a-f]{24,}$/.test(c._id)) {
      console.warn(`  ! ${c._id}: unnamed auto-generated document — skipped`);
      empty++;
      continue;
    }
    const fingerprint = JSON.stringify(c.path ?? []);
    const twin = seen.get(fingerprint);
    if (twin && fingerprint.length > 2) {
      console.warn(`  ! ${c._id}: identical path to "${twin}" — imported anyway (different meet)`);
    }
    seen.set(fingerprint, c._id);
    const coords = (c.path ?? []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (coords.length < 2) {
      empty++;
      console.warn(`  ! ${c._id}: no usable path (${coords.length} points) — skipped`);
      continue;
    }
    const file = `courses/${slug(c._id)}.geojson`;
    const full = path.join(eventsDir, file);
    const geo = {
      type: 'Feature',
      properties: { name: c._id, legacyMeetId: c.meet_id ?? null, distance: c.course ?? null },
      geometry: { type: 'LineString', coordinates: coords.map(([lon, lat]) => [lon, lat]) },
    };
    const text = JSON.stringify(geo);

    let lengthMi = 0;
    try {
      lengthMi = parseCourse(text, false, 'miles').length;
    } catch (err) {
      console.warn(`  ! ${c._id}: unusable geometry (${(err as Error).message}) — skipped`);
      empty++;
      continue;
    }

    if (fs.existsSync(full) && !OVERWRITE) {
      skipped++;
    } else if (!DRY) {
      fs.writeFileSync(full, text + '\n');
      written++;
    } else {
      written++;
    }

    const markers = markersFrom(c);
    markerTotal += markers.length;
    if (!DRY) {
      store.noteCourseSeen(file, 'legacy-import');
      store.updateCourseMeta(file, {
        label: c._id,
        notes: [c.course ? `Legacy ${c.course}` : '', c.meet_id ? `meet ${c.meet_id}` : '', 'imported from CouchDB']
          .filter(Boolean)
          .join(' · '),
      });
      if (markers.length > 0) {
        // the legacy splits ARE the posts — don't also auto-generate a set
        store.setCourseMarkers(file, { auto: false, units: 'miles', markers });
      }
    }
    console.log(`  ${c._id.padEnd(22)} ${coords.length.toString().padStart(5)} pts  ${lengthMi.toFixed(2).padStart(6)} mi  ${markers.length} markers`);

    const roles = { lead_pri: c.lead_pri, lead_bu: c.lead_bu, trail: c.trail, trail2: c.trail2, timer: c.timer, crowd: c.crowd };
    const set = Object.fromEntries(Object.entries(roles).filter(([, v]) => /^\d{15}$/.test(String(v ?? ''))));
    if (Object.keys(set).length > 0) roleRefs[c._id] = set as Record<string, string>;
  }

  console.log(
    `\n[seed] courses: ${written} written, ${skipped} already present (use --overwrite), ${empty} skipped, ${markerTotal} markers`,
  );

  // Role assignments belong to events, not courses, so they are kept as a
  // reference file rather than invented into event configs.
  if (Object.keys(roleRefs).length > 0) {
    const refFile = path.join(eventsDir, 'legacy-course-roles.json');
    if (!DRY) fs.writeFileSync(refFile, JSON.stringify(roleRefs, null, 2) + '\n');
    console.log(`[seed] role assignments for ${Object.keys(roleRefs).length} courses → ${refFile}`);
  }
  store.close();
}

main().catch((err) => {
  console.error('[seed] failed:', (err as Error).message);
  process.exit(1);
});

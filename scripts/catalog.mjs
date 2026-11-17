// Enumerates the coverage area from the PLATEAU data catalog (CLAUDE.md §1, §4)
// and writes public/manifest.remote.json: every tileset with its municipality,
// feature type, LOD, bounds and the official streaming URL.
// scripts/download.mjs turns this into data/manifest.json with self-hosted URLs.
import { writeFileSync, mkdirSync } from 'node:fs';

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const WEST_LIMIT = 139.36; // Tachikawa's west edge
// Explicitly out of scope (CLAUDE.md §1) even where their bounds cross the west limit.
const EXCLUDED = new Set(['13201', '13205', '13207', '13218', '13227', '13228', '13303', '13305', '13307', '13308']);
const R2D = 180 / Math.PI;

async function getJson(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error('fetch failed: ' + url);
}

function ecefToLla(x, y, z) {
  const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F);
  const p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 6; i++) { const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2); lat = Math.atan2(z + E2 * n * Math.sin(lat), p); }
  return [lat * R2D, Math.atan2(y, x) * R2D];
}
function regionOf(bv) {
  if (!bv) return null;
  if (bv.region) { const r = bv.region; return { west: r[0] * R2D, south: r[1] * R2D, east: r[2] * R2D, north: r[3] * R2D }; }
  if (bv.box) {
    const [cx, cy, cz, ...h] = bv.box; const o = { west: 180, south: 90, east: -180, north: -90 };
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const [la, lo] = ecefToLla(cx + sx * h[0] + sy * h[3] + sz * h[6], cy + sx * h[1] + sy * h[4] + sz * h[7], cz + sx * h[2] + sy * h[5] + sz * h[8]);
      o.west = Math.min(o.west, lo); o.east = Math.max(o.east, lo); o.south = Math.min(o.south, la); o.north = Math.max(o.north, la);
    }
    return o;
  }
  return null;
}

const cat = await getJson(CATALOG);
const all = cat.latest_datasets.filter((d) => d.format === '3D Tiles' && ['bldg', 'brid', 'veg', 'frn'].includes(d.type_en));
const code = (d) => d.ward_code || d.city_code;
const inTokyo = (c) => c.startsWith('13') && +c < 13360 && !EXCLUDED.has(c); // < 13360 drops the islands
const inYokohama = (c) => c === '14100' || (+c >= 14101 && +c <= 14118);
const inKawasaki = (c) => c === '14130' || (+c >= 14131 && +c <= 14137); // added by the owner (was out of scope)

const byCity = new Map();
for (const d of all) {
  const c = code(d);
  if (!inTokyo(c) && !inYokohama(c) && !inKawasaki(c)) continue;
  if (!byCity.has(c)) byCity.set(c, []);
  byCity.get(c).push(d);
}

// Per municipality and feature type keep one dataset: LOD2 textured if published,
// otherwise the best available (LOD is a patchwork; LOD3/4 pockets duplicate LOD2).
function pick(list, type) {
  const [t, sub] = type.split(':');
  const c = list.filter((d) => d.type_en === t && (!sub || d.id.includes(sub)));
  // buildings / bridges: LOD2 baseline. Vegetation and street furniture are separate
  // objects (no duplication with other layers), so take the most detailed LOD published.
  const rank = (d) => (t === 'veg' || t === 'frn' ? +d.lod * 10 : d.lod === '2' ? 100 : d.lod === '1' ? 50 : 10) + (d.texture ? 5 : 0);
  return c.sort((a, b) => rank(b) - rank(a))[0];
}

const tilesets = [];
for (const [c, list] of [...byCity].sort()) {
  for (const typeKey of ['bldg', 'bldg:lod1', 'brid', 'veg:SolitaryVegetationObject', 'veg:PlantCover', 'frn']) {
    // 'bldg:lod1' = white boxes for the far view from the air (a second layer next to the detailed one)
    const type = typeKey === 'bldg:lod1' ? 'bldgFar' : typeKey.split(':')[0];
    const d = pick(list, typeKey);
    if (!d) continue;
    const ts = await getJson(d.url);
    const inner0 = ts.root?.children?.[0]?.content?.uri ?? null;
    let bounds = regionOf(ts.root?.boundingVolume);
    // some wrappers carry a nation-wide placeholder region: use the real tileset's volume
    if ((!bounds || bounds.east - bounds.west > 0.6 || bounds.north - bounds.south > 0.6) && inner0) {
      bounds = regionOf((await getJson(inner0)).root?.boundingVolume);
    }
    if (!bounds) { console.warn('no usable bounds, skipping', d.id); continue; }
    if (c.startsWith('13') && +c > 13123 && bounds.east <= WEST_LIMIT) { console.log('west of limit, skipped:', c, d.city); continue; }
    // resolve the wrapper to the real asset tileset (needed for downloading)
    const inner = ts.root?.children?.[0]?.content?.uri ?? null;
    tilesets.push({
      id: type === 'bldgFar' ? d.id + '~far' : d.id, cityCode: c, city: d.ward ? `${d.city}${d.ward}` : d.city, type, lod: +d.lod, texture: !!d.texture,
      remoteUrl: d.url, assetUrl: inner, fileSize: d.file_size ?? null,
      bounds: Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, +v.toFixed(6)])),
    });
    console.log(c, d.city, d.ward ?? '', type, 'lod' + d.lod, d.texture ? 'tex' : '', ((d.file_size ?? 0) / 1e6).toFixed(0) + 'MB');
  }
}

// Tilesets whose own volume is still a placeholder: use the union of the same
// city's building tilesets (e.g. Yokohama's city-wide bridge set).
const union = (list) => list.reduce((a, t) => ({
  west: Math.min(a.west, t.bounds.west), south: Math.min(a.south, t.bounds.south),
  east: Math.max(a.east, t.bounds.east), north: Math.max(a.north, t.bounds.north),
}), { west: 180, south: 90, east: -180, north: -90 });
for (const t of tilesets) {
  if (t.bounds.east - t.bounds.west <= 0.6 && t.bounds.north - t.bounds.south <= 0.6) continue;
  const same = tilesets.filter((o) => o.type === 'bldg' && o.cityCode.slice(0, 3) === t.cityCode.slice(0, 3));
  t.bounds = Object.fromEntries(Object.entries(union(same)).map(([k, v]) => [k, +v.toFixed(6)]));
  console.log('placeholder bounds replaced for', t.id, t.bounds);
}

const b = tilesets.filter((t) => t.type === 'bldg').reduce((a, t) => ({
  west: Math.min(a.west, t.bounds.west), south: Math.min(a.south, t.bounds.south),
  east: Math.max(a.east, t.bounds.east), north: Math.max(a.north, t.bounds.north),
}), { west: 180, south: 90, east: -180, north: -90 });

const manifest = {
  generated: new Date().toISOString(),
  source: CATALOG,
  bounds: { west: +(Math.max(b.west, WEST_LIMIT - 0.03)).toFixed(4), south: +(b.south - 0.02).toFixed(4), east: +(b.east + 0.02).toFixed(4), north: +(b.north + 0.02).toFixed(4) },
  tilesets,
  terrain: {
    // GSI elevation tiles (public, no key). PLATEAU publishes terrain only inside
    // CityGML archives, not as tiles - see CLAUDE.md §9.3 note.
    dem: ['https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/{z}/{x}/{y}.png'],
    demFill: ['https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png'],
    ortho: [
      'https://api.plateauview.mlit.go.jp/tiles/plateau-ortho-2023/{z}/{x}/{y}.png',
      'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    ],
    safetyDem: ['https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png'],
    safetyPhoto: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
  },
};
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/manifest.remote.json', import.meta.url), JSON.stringify(manifest, null, 1));
// keep an existing data/manifest.json (self-hosted URLs, OSM bake) in step with the enumeration
try {
  const { existsSync, readFileSync } = await import('node:fs');
  const f = new URL('../data/manifest.json', import.meta.url);
  if (existsSync(f)) {
    const cur = JSON.parse(readFileSync(f, 'utf8'));
    const have = new Set(cur.tilesets.map((t) => t.id));
    const added = tilesets.filter((t) => !have.has(t.id));
    cur.tilesets.push(...added);
    writeFileSync(f, JSON.stringify(cur, null, 1));
    console.log('data/manifest.json: added', added.length, 'tilesets');
  }
} catch (e) { console.warn('could not merge into data/manifest.json', e.message); }
const total = tilesets.reduce((s, t) => s + (t.fileSize ?? 0), 0);
console.log(`\n${tilesets.length} tilesets, ${new Set(tilesets.map((t) => t.cityCode)).size} municipalities, ${(total / 1e9).toFixed(2)} GB`);
console.log('bounds', manifest.bounds);

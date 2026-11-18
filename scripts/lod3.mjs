// Adds PLATEAU's LOD3 building sets as high-detail stand-ins for the LOD2 ones.
//
// Where PLATEAU publishes a textured LOD3 building set for a ward, it is the whole ward
// again (the same buildings, the same tiles) with LOD3 geometry - windows, balconies,
// recessed facades - swapped in for the buildings that have it. (Checked tile by tile and
// by building ID for Minato, Taito, Sumida, Nishi, Naka, Seya and Kawasaki-ku.) So it can
// simply replace the LOD2 set: each LOD3 entry carries `replaces: <LOD2 id>`, and the game
// uses it instead of that set at the highest quality setting, on the ground.
//
// Updates every manifest that exists: public/manifest.remote.json, public/data/manifest.json
// (without local URLs) and data/manifest.json. Then `node scripts/download.mjs` fetches the
// new sets like any other. Re-running is harmless.
//   node scripts/lod3.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadManifest, saveManifest } from './lib.mjs';

const CATALOG = 'https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets';
const UA = { 'User-Agent': 'tokyodrive-catalog (one-off, low rate)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(url, { headers: UA }); if (r.ok) return await r.json(); } catch {}
    await sleep(2000 * (i + 1));
  }
  throw new Error('fetch failed: ' + url);
}

const cat = await getJson(CATALOG);
const lod3 = new Map(); // city code -> dataset
for (const d of cat.latest_datasets) {
  if (d.format !== '3D Tiles' || d.type_en !== 'bldg' || d.lod !== '3' || !d.texture) continue;
  lod3.set(d.ward_code || d.city_code, d);
}

/** LOD3 entries for a manifest's LOD2 building sets. */
async function entriesFor(m, cache) {
  const out = [];
  for (const t of m.tilesets) {
    if (t.type !== 'bldg' || t.lod !== 2 || t.replaces) continue;
    const d = lod3.get(t.cityCode);
    if (!d) continue;
    let asset = cache.get(d.id);
    if (asset === undefined) {
      const w = await getJson(d.url); await sleep(800);
      asset = w.root?.children?.[0]?.content?.uri ?? null;
      cache.set(d.id, asset);
    }
    out.push({
      id: d.id, cityCode: t.cityCode, city: t.city, type: 'bldg', lod: 3, texture: true,
      remoteUrl: d.url, assetUrl: asset, fileSize: d.file_size ?? null, bounds: t.bounds, replaces: t.id,
    });
  }
  return out;
}

const cache = new Map();
const merge = (m, add, local) => {
  let n = 0;
  for (const e of add) {
    const i = m.tilesets.findIndex((t) => t.id === e.id);
    const entry = local ? e : (({ assetUrl, fileSize, ...rest }) => rest)(e);
    if (i < 0) { m.tilesets.push(entry); n++; }
    else m.tilesets[i] = { ...entry, ...(m.tilesets[i].url ? { url: m.tilesets[i].url } : {}) }; // keep a downloaded copy
  }
  return n;
};

const remoteFile = new URL('../public/manifest.remote.json', import.meta.url).pathname;
const publicFile = new URL('../public/data/manifest.json', import.meta.url).pathname;
for (const [file, local] of [[remoteFile, true], [publicFile, false]]) {
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const n = merge(m, await entriesFor(m, cache), local);
  writeFileSync(file, JSON.stringify(m, null, file === remoteFile ? 1 : 0));
  console.log(`${file.split('/').slice(-2).join('/')}: +${n} LOD3 sets`);
}
if (existsSync(join(dataDir, 'manifest.json'))) {
  const m = loadManifest();
  const n = merge(m, await entriesFor(m, cache), true);
  saveManifest(m);
  console.log(`data/manifest.json: +${n} LOD3 sets (run scripts/download.mjs to fetch them)`);
}
for (const [id, a] of cache) console.log(' ', id, a ? '' : '(no asset URL: streams only)');

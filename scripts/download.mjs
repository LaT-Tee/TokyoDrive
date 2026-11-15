// Downloads the pre-converted PLATEAU 3D Tiles for the coverage area and
// self-hosts them under data/tiles/<id>/ (CLAUDE.md §4). Resumable; each
// finished tileset is recorded in data/manifest.json with a local `url`, so
// the game switches from the streaming endpoint to the self-hosted copy.
//
//   node scripts/download.mjs                 # everything (~5 GB)
//   node scripts/download.mjs 13104 13113     # only the given city codes
//   node scripts/download.mjs --terrain       # also mirror DEM + ortho tiles
//
// Requires `curl` and `unzip` (both ship with macOS).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadManifest, saveManifest } from './lib.mjs';

const args = process.argv.slice(2);
const wantTerrain = args.includes('--terrain');
const only = args.filter((a) => !a.startsWith('--'));
const tilesDir = join(dataDir, 'tiles');
mkdirSync(tilesDir, { recursive: true });

function findTileset(dir, depth = 0) {
  if (existsSync(join(dir, 'tileset.json'))) return dir;
  if (depth > 2) return null;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { const f = findTileset(p, depth + 1); if (f) return f; }
  }
  return null;
}

let manifest = loadManifest();
const todo = manifest.tilesets.filter((t) => (!only.length || only.includes(t.cityCode)) && !t.url);
const totalBytes = todo.reduce((s, t) => s + (t.fileSize ?? 0), 0);
console.log(`${todo.length} tilesets to download (${(totalBytes / 1e9).toFixed(2)} GB) into ${tilesDir}`);

let n = 0, failed = 0;
for (const t of todo) {
  n++;
  if (!t.assetUrl) { console.warn(`[${n}/${todo.length}] ${t.id}: no asset URL, stays on streaming`); failed++; continue; }
  const zipUrl = t.assetUrl.replace(/\/tileset\.json$/, '.zip');
  const dest = join(tilesDir, t.id), zip = join(tilesDir, t.id + '.zip'), tmp = dest + '.partial';
  try {
    console.log(`[${n}/${todo.length}] ${t.id} ${t.city} (${((t.fileSize ?? 0) / 1e6).toFixed(0)} MB)`);
    // resumable download with retries
    const dl = spawnSync('curl', ['-fL', '--retry', '5', '--retry-delay', '3', '-C', '-', '-sS', '-o', zip, zipUrl], { stdio: 'inherit' });
    if (dl.status !== 0) throw new Error('download failed (curl exit ' + dl.status + ')');
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    execFileSync('unzip', ['-q', '-o', zip, '-d', tmp], { stdio: 'inherit' });
    const root = findTileset(tmp);
    if (!root) throw new Error('no tileset.json inside archive');
    rmSync(dest, { recursive: true, force: true });
    renameSync(root, dest);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(zip, { force: true });
    // re-read: other pipeline scripts (osm.mjs) may have updated the manifest meanwhile
    manifest = loadManifest();
    const entry = manifest.tilesets.find((e) => e.id === t.id);
    entry.url = `tiles/${t.id}/tileset.json`;
    saveManifest(manifest);
  } catch (e) {
    failed++;
    console.warn(`  ${t.id}: ${e.message} - left on the streaming endpoint`);
  }
}

if (wantTerrain) {
  // Mirror elevation + ortho tiles for the coverage area so the ground is self-hosted too.
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => { const p = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * 2 ** z); };
  const sets = manifest.tilesets.filter((t) => t.type === 'bldg' && (!only.length || only.includes(t.cityCode)));
  const jobs = new Map(); // local path -> [urls]
  const add = (kind, z, x, y, urls, ext) => jobs.set(`${kind}/${z}/${x}/${y}.${ext}`, urls.map((u) => u.replace('{z}', z).replace('{x}', x).replace('{y}', y)));
  const remote = loadManifest().terrainRemote ?? manifest.terrain;
  for (const t of sets) {
    const b = t.bounds;
    for (const [kind, z, urls, ext] of [['dem', 15, remote.dem, 'png'], ['demfill', 14, remote.demFill, 'png'], ['ortho', 15, remote.ortho, 'img'], ['ortho', 16, remote.ortho, 'img'], ['ortho', 17, remote.ortho, 'img']]) {
      for (let x = lon2x(b.west, z); x <= lon2x(b.east, z); x++) for (let y = lat2y(b.north, z); y <= lat2y(b.south, z); y++) add(kind, z, x, y, urls, ext);
    }
  }
  console.log(`terrain mirror: ${jobs.size} tiles`);
  let done = 0, miss = 0;
  const list = [...jobs];
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const job = list.pop(); if (!job) return;
      const [path, urls] = job; const file = join(dataDir, path);
      if (!existsSync(file)) {
        let ok = false;
        for (const u of urls) {
          try { const r = await fetch(u); if (!r.ok) continue; mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, Buffer.from(await r.arrayBuffer())); ok = true; break; } catch {}
        }
        if (!ok) miss++;
      }
      if (++done % 500 === 0) console.log(`  ${done}/${jobs.size} (${miss} unavailable)`);
    }
  }));
  manifest = loadManifest();
  if (!manifest.terrainRemote) manifest.terrainRemote = manifest.terrain;
  const r = manifest.terrainRemote;
  manifest.terrain = { ...r, dem: ['dem/{z}/{x}/{y}.png', ...r.dem], demFill: ['demfill/{z}/{x}/{y}.png', ...r.demFill], ortho: ['ortho/{z}/{x}/{y}.img', ...r.ortho] };
  saveManifest(manifest);
  console.log(`terrain mirror done (${miss} tiles unavailable upstream)`);
}

const m = loadManifest();
const local = m.tilesets.filter((t) => t.url).length;
console.log(`\nself-hosted: ${local}/${m.tilesets.length} tilesets${failed ? `, ${failed} failed (still streaming)` : ''}`);

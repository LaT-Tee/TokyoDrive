// Copies the baked OSM road data into public/data so that it ships with the
// site (the app reads `${DATA_BASE}/manifest.json` and `${DATA_BASE}/osm/...`).
// Building tiles are NOT copied: they stream from the official PLATEAU endpoint
// unless you host them yourself and set VITE_DATA_BASE_URL.
//   node scripts/osm.mjs && node scripts/publish-data.mjs
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadManifest } from './lib.mjs';

const out = new URL('../public/data/', import.meta.url).pathname;
rmSync(join(out, 'osm'), { recursive: true, force: true });
mkdirSync(join(out, 'osm'), { recursive: true });
let files = 0, bytes = 0;
const walk = (src, dst) => {
  for (const name of readdirSync(src)) {
    if (name.startsWith('._') || name === 'done.json' || name === '.DS_Store') continue;
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); walk(s, d); }
    else { cpSync(s, d); files++; bytes += statSync(s).size; }
  }
};
walk(join(dataDir, 'osm'), join(out, 'osm'));
const m = loadManifest();
// the published manifest must not point at tiles that only exist on this machine
for (const t of m.tilesets) { delete t.url; delete t.assetUrl; delete t.fileSize; }
if (m.terrainRemote) { m.terrain = m.terrainRemote; delete m.terrainRemote; }
writeFileSync(join(out, 'manifest.json'), JSON.stringify(m));
console.log(`published ${files} road tiles (${(bytes / 1e6).toFixed(1)} MB) + manifest with ${m.tilesets.length} tilesets -> public/data`);

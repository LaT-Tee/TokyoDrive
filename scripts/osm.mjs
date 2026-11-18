// Bakes OpenStreetMap road metadata (ODbL) for the coverage area into
// data/osm/14/{x}/{y}.json via the Overpass API - fetched once, never at
// runtime (CLAUDE.md §2, §5). Used for road names, recover and the
// elevated-deck fallback. Resumable: finished query tiles are skipped.
//
// Gentle on the public Overpass server (it bans clients that hammer it): one server, one
// query at a time, it first asks the server for a free slot and waits as long as the
// server says, keeps at least PAUSE between queries, backs off exponentially (honouring
// Retry-After) on 429 / 504 / errors, and splits a query area into four smaller ones when
// the server cannot answer it. Interrupt and re-run at any time: it resumes.
//
//   node scripts/osm.mjs            # whole coverage area
//   node scripts/osm.mjs 13104      # only tiles touching the given city codes
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, loadManifest, saveManifest } from './lib.mjs';

const OVERPASS = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const STATUS = OVERPASS.replace(/interpreter$/, 'status');
const PAUSE = 15000;          // ms between queries
const MAX_BACKOFF = 15 * 60000;
const UA = 'tokyodrive-osm-bake (one-off bake, low rate)';
const QZ = 12, OZ = 14;
const CLASSES = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street'];
// default carriageway width (m) per class when lanes / width tags are missing
const WIDTH = [9, 5.5, 9, 5.5, 9, 5.5, 7.5, 5, 6.5, 5, 5, 4.5, 4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => { const p = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * 2 ** z; };
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z)) * 180) / Math.PI;

const manifest = loadManifest();
const only = process.argv.slice(2);
const sets = manifest.tilesets.filter((t) => t.type === 'bldg' && (!only.length || only.includes(t.cityCode)));
const qTiles = new Set();
for (const t of sets) {
  const b = t.bounds;
  for (let x = Math.floor(lon2x(b.west, QZ)); x <= Math.floor(lon2x(b.east, QZ)); x++)
    for (let y = Math.floor(lat2y(b.north, QZ)); y <= Math.floor(lat2y(b.south, QZ)); y++) qTiles.add(x + '/' + y);
}
const outDir = join(dataDir, 'osm');
const doneFile = join(outDir, 'done.json');
mkdirSync(outDir, { recursive: true });
const done = new Set(existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, 'utf8')) : []);
console.log(`${qTiles.size} query tiles (z${QZ}), ${done.size} already done`);

/** Wait until the server reports a free slot for us (its own rate limiter). */
async function waitForSlot() {
  for (let i = 0; i < 40; i++) {
    let text = '';
    try { text = await (await fetch(STATUS, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })).text(); } catch { return; } // no status page: just go on politely
    if (/slots? available now/i.test(text)) return;
    const waits = [...text.matchAll(/in (\d+) seconds/g)].map((m) => +m[1]);
    const s = waits.length ? Math.min(...waits) + 3 : 30;
    console.log(`  waiting ${s} s for a free Overpass slot`);
    await sleep(s * 1000);
  }
}

let lastQuery = 0;
/** One query, politely; null when the server could not answer this area (try smaller). */
async function overpass(query) {
  let backoff = 60000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const gap = lastQuery + PAUSE - Date.now();
    if (gap > 0) await sleep(gap);
    await waitForSlot();
    lastQuery = Date.now();
    let status = 0, retryAfter = 0;
    try {
      const r = await fetch(OVERPASS, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, signal: AbortSignal.timeout(200000) });
      status = r.status;
      if (r.ok) {
        const j = await r.json();
        // an answer with a runtime error (timeout / out of memory) means: area too big
        if (j.remark && /runtime error/i.test(j.remark)) { console.warn('  server:', j.remark.slice(0, 120)); return null; }
        return j;
      }
      retryAfter = parseInt(r.headers.get('retry-after') ?? '', 10) * 1000 || 0;
      if (status === 400) throw new Error('bad query');
    } catch (e) { if (e.message === 'bad query') throw e; console.warn('  overpass error', e.message); }
    if (status === 504 && attempt >= 1) return null; // repeatedly too heavy: split the area
    const wait = Math.min(MAX_BACKOFF, Math.max(retryAfter, backoff)) * (0.85 + Math.random() * 0.3);
    console.warn(`  HTTP ${status || 'error'} - waiting ${Math.round(wait / 1000)} s before retrying`);
    await sleep(wait);
    backoff = Math.min(MAX_BACKOFF, backoff * 2);
  }
  throw new Error('Overpass keeps failing - stopped (re-run later, finished areas are kept)');
}

/** Ways of one query tile; areas the server cannot answer are fetched as four quarters. */
async function fetchArea(x, y, z) {
  const bbox = [y2lat(y + 1, z), x2lon(x, z), y2lat(y, z), x2lon(x + 1, z)].map((v) => v.toFixed(6)).join(',');
  const q = `[out:json][timeout:120];way["highway"~"^(${CLASSES.join('|')})$"](${bbox});out tags geom qt;`;
  const j = await overpass(q);
  if (j) return j.elements;
  if (z >= QZ + 2) throw new Error('Overpass cannot answer even a small area - stopped');
  console.log(`  splitting z${z} ${x}/${y} into quarters`);
  const all = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) all.push(...(await fetchArea(x * 2 + dx, y * 2 + dy, z + 1)));
  return all;
}

const out = new Map(); // z14 key -> Map(id -> way)
const loadOut = (key) => {
  if (!out.has(key)) {
    const f = join(outDir, String(OZ), key + '.json');
    out.set(key, new Map(existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).ways.map((w) => [w.i, w]) : []));
  }
  return out.get(key);
};

let n = 0;
for (const qt of [...qTiles].sort()) {
  n++;
  if (done.has(qt)) continue;
  const [x, y] = qt.split('/').map(Number);
  const elements = await fetchArea(x, y, QZ);
  let ways = 0;
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tg = el.tags ?? {};
    const c = CLASSES.indexOf(tg.highway);
    if (c < 0 || tg.area === 'yes') continue;
    const lanes = parseInt(tg.lanes, 10), wtag = parseFloat(tg.width);
    const width = Number.isFinite(wtag) && wtag > 2 && wtag < 40 ? wtag : Number.isFinite(lanes) && lanes > 0 ? Math.max(WIDTH[c] * 0.6, lanes * 3.25 + 1) : WIDTH[c];
    const w = { i: el.id, c, w: +width.toFixed(1), p: [] };
    if (tg.name) w.n = tg.name;
    const isBridge = tg.bridge && tg.bridge !== 'no';
    const isTunnel = (tg.tunnel && tg.tunnel !== 'no') || tg.covered === 'yes';
    const layer = parseInt(tg.layer, 10);
    if (isBridge) w.b = 1;
    if (isTunnel) w.t = 1;
    if (Number.isFinite(layer) && layer !== 0) w.l = layer;
    if (tg.oneway === 'yes' || tg.oneway === '1' || tg.highway === 'motorway' || tg.junction === 'roundabout') w.o = 1;
    if (Number.isFinite(lanes) && lanes > 0) w.ln = lanes;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const g of el.geometry) {
      w.p.push(+g.lat.toFixed(6), +g.lon.toFixed(6));
      const tx = Math.floor(lon2x(g.lon, OZ)), ty = Math.floor(lat2y(g.lat, OZ));
      minX = Math.min(minX, tx); maxX = Math.max(maxX, tx); minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
    }
    for (let tx = minX; tx <= maxX; tx++) for (let ty = minY; ty <= maxY; ty++) loadOut(tx + '/' + ty).set(w.i, w);
    ways++;
  }
  // flush touched z14 tiles
  for (const [key, m] of out) {
    const [tx] = key.split('/');
    mkdirSync(join(outDir, String(OZ), tx), { recursive: true });
    writeFileSync(join(outDir, String(OZ), key + '.json'), JSON.stringify({ ways: [...m.values()] }));
  }
  const keys = [...out.keys()];
  out.clear();
  done.add(qt);
  writeFileSync(doneFile, JSON.stringify([...done]));
  const m = loadManifest();
  const tiles = new Set(m.osm?.tiles ?? []);
  for (const k of keys) tiles.add(k);
  m.osm = { zoom: OZ, tiles: [...tiles].sort(), attribution: '© OpenStreetMap contributors (ODbL)' };
  saveManifest(m);
  console.log(`[${n}/${qTiles.size}] ${qt}: ${ways} ways`);
}
console.log('OSM bake complete:', loadManifest().osm.tiles.length, `z${OZ} tiles`);

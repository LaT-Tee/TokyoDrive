// Bakes a coarse geoid-height grid (GSI geoid model, public API, no key) for
// the coverage area into public/geoid.json. PLATEAU 3D Tiles use ellipsoidal
// heights; DEM elevations are orthometric, so terrain needs + geoid height.
import { writeFileSync } from 'node:fs';
const lat0 = 35.2, lat1 = 35.95, lon0 = 139.2, lon1 = 140.0, step = 0.05;
const ny = Math.round((lat1 - lat0) / step) + 1, nx = Math.round((lon1 - lon0) / step) + 1;
const values = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function one(lat, lon) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(`https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl?outputType=json&latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`);
      const j = await r.json();
      const v = parseFloat(j.OutputData.geoidHeight);
      if (Number.isFinite(v)) return v;
    } catch {}
    await sleep(1500 * (a + 1));
  }
  return NaN;
}
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  values.push(await one(lat0 + j * step, lon0 + i * step));
  await sleep(1100); // API asks for <= 10 requests / 10 s
}
// fill gaps (open sea) with nearest valid neighbour
for (let k = 0; k < values.length; k++) if (!Number.isFinite(values[k])) {
  let best = 1e9, bv = 36.7;
  for (let m = 0; m < values.length; m++) if (Number.isFinite(values[m])) {
    const d = Math.hypot((m % nx) - (k % nx), Math.floor(m / nx) - Math.floor(k / nx));
    if (d < best) { best = d; bv = values[m]; }
  }
  values[k] = bv;
}
writeFileSync(new URL('../public/geoid.json', import.meta.url), JSON.stringify({ lat0, lon0, step, nx, ny, values: values.map((v) => +v.toFixed(3)) }));
console.log('geoid grid', nx, ny);

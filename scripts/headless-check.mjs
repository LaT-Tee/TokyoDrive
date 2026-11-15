// Headless verification (CLAUDE.md §7, §8, §9). Drives the real game in
// headless Chrome with synthetic key input and writes screenshots + a JSON
// report to screenshots/.
//
//   node scripts/headless-check.mjs phase1            scripted drive + wall stop
//   node scripts/headless-check.mjs spawns            360° ground check at every spawn
//   node scripts/headless-check.mjs tour              drive in every ward / city core
//   node scripts/headless-check.mjs roads             road layer: sharp markings, no flicker (Shinjuku, Fuchu)
//   node scripts/headless-check.mjs jitter            float-precision check at Tachikawa
//
// Needs the dev server running (BASE_URL, default http://localhost:5173).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = join(process.env.TOKYODRIVE_SRC ?? process.cwd(), 'screenshots');
mkdirSync(OUT, { recursive: true });
const mode = process.argv[2] ?? 'phase1';
const QUALITY = process.env.QUALITY ?? 'balanced';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL ?? 'chrome', headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--window-size=1280,720'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
if (process.env.THROTTLE) {
  // network throttling for the §9.5 check (e.g. THROTTLE=20 -> 20 Mbit/s, 40 ms latency)
  const cdp = await page.context().newCDPSession(page);
  const bps = (+process.env.THROTTLE * 1e6) / 8;
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: bps, uploadThroughput: bps });
}

const shot = async (name) => { await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 80 }); return name + '.jpg'; };
const state = () => page.evaluate(() => {
  const t = window.__td, c = t.car, g = t.ground;
  const lla = t.lla();
  return {
    x: c.x, y: c.y, z: c.z, speed: c.speed, heading: c.heading, odometer: c.odometer, blocked: c.blocked, airborne: c.airborne,
    surface: g.surface(c.x, c.z, c.y), terrainReady: t.terrain.isReady(c.x, c.z, c.y),
    obstacle: t.obstacles.heightAt(c.x, c.z), pending: t.pending, tilesPending: t.tiles.pending, terrainPending: t.terrain.pendingChunks,
    fps: t.fps.value, lat: lla.lat, lon: lla.lon, samples: g.samples, fallbackSamples: g.fallbackSamples, sampleMs: g.sampleMs,
    minClearance: c.minClearance, maxClearance: c.maxClearance, loadErrors: t.tiles.loadErrors,
  };
});
async function open(query) {
  await page.goto(`${BASE}/?autostart=1&quality=${QUALITY}&${query}`);
  await page.waitForFunction(() => window.__td?.playing, null, { timeout: 120000 });
}
/** Wait until nothing critical is pending (or timeout); returns ms waited and what was left. */
async function settle(maxMs = 20000) {
  const t0 = Date.now();
  let s = await state();
  while (Date.now() - t0 < maxMs && (s.pending > 0 || !s.terrainReady)) { await sleep(250); s = await state(); }
  return { waitedMs: Date.now() - t0, pending: s.pending, terrainReady: s.terrainReady };
}
const teleport = (lat, lon, heading) => page.evaluate(([a, b, h]) => window.__td.teleport(a, b, h), [lat, lon, heading]);
const waitSettled = () => page.waitForFunction(() => window.__td.settled, null, { timeout: 60000 });

/**
 * Key-driven test driver: holds throttle and steers with A/D away from
 * obstacles (or along the nearest OSM road when road data is loaded).
 * This lives in the test harness only - the game itself has no autopilot.
 */
async function drive({ metres, maxSeconds = 120, maxKmh = 50 }) {
  const start = (await state()).odometer;
  const t0 = Date.now();
  let held = new Set();
  const set = async (key, on) => { if (on && !held.has(key)) { await page.keyboard.down(key); held.add(key); } else if (!on && held.has(key)) { await page.keyboard.up(key); held.delete(key); } };
  let reversingUntil = 0, stuck = 0;
  while (Date.now() - t0 < maxSeconds * 1000) {
    const s = await page.evaluate(() => {
      const t = window.__td, c = t.car;
      const clear = (ang, dist) => {
        // free distance along a ray, using the same wall test as the car
        const h = c.heading + ang; let y = c.y;
        t.ground.surface(c.x, c.z, y); let deck = t.ground.lastOnDeck;
        for (let d = 3; d <= dist; d += 2) {
          const x = c.x + Math.sin(h) * d, z = c.z - Math.cos(h) * d;
          if (t.ground.isWall(x, z, y, 2, deck)) return d;   // same rules as the car, incl. deck guardrails
          y = t.ground.surface(x, z, y); deck = t.ground.lastOnDeck;
        }
        return dist;
      };
      const road = t.roads.nearest(c.x + Math.sin(c.heading) * 12, c.z - Math.cos(c.heading) * 12, 25);
      let roadTurn = null;
      if (road) {
        // aim at the road point ahead; pick the road direction closest to our heading
        let d = road.heading - c.heading; d = Math.atan2(Math.sin(d), Math.cos(d));
        if (Math.abs(d) > Math.PI / 2) d = Math.atan2(Math.sin(d + Math.PI), Math.cos(d + Math.PI));
        const side = (road.x - c.x) * Math.cos(c.heading) + (road.z - c.z) * Math.sin(c.heading);
        roadTurn = d + Math.max(-0.5, Math.min(0.5, side * 0.08));
      }
      return { odometer: c.odometer, speed: c.speed, blocked: c.blocked, f: clear(0, 40), l: clear(-0.45, 30), r: clear(0.45, 30), roadTurn };
    });
    if (s.odometer - start >= metres) break;
    const now = Date.now();
    if (s.blocked && now > reversingUntil) { stuck++; reversingUntil = now + 1400; }
    if (now < reversingUntil) {
      await set('KeyW', false); await set('KeyS', true);
      await set('KeyA', stuck % 2 === 0); await set('KeyD', stuck % 2 === 1);
    } else {
      await set('KeyS', false);
      await set('KeyW', s.speed * 3.6 < maxKmh);
      let turn = 0;
      if (s.f < 28) turn = s.r > s.l ? 1 : -1;            // obstacle ahead: go to the clearer side
      else if (s.roadTurn !== null && Math.abs(s.roadTurn) > 0.05) turn = Math.sign(s.roadTurn);
      else if (s.l < 12 && s.r >= s.l) turn = 1; else if (s.r < 12 && s.l > s.r) turn = -1;
      await set('KeyD', turn > 0); await set('KeyA', turn < 0);
    }
    await sleep(60);
  }
  for (const k of [...held]) await page.keyboard.up(k);
  const e = await state();
  return { metres: e.odometer - start, seconds: (Date.now() - t0) / 1000 };
}

/** Drive straight at the nearest building until the wall probe stops the car. */
async function wallTest() {
  const target = await page.evaluate(() => {
    const t = window.__td, c = t.car;
    let best = null;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      let y = c.y;
      t.ground.surface(c.x, c.z, y); let deck = t.ground.lastOnDeck;
      for (let d = 4; d <= 80; d += 2) {
        const x = c.x + Math.sin(a) * d, z = c.z - Math.cos(a) * d;
        if (t.ground.isWall(x, z, y, 2, deck)) {
          // only a building counts as the test wall (not a guardrail, kerb or mapped road override)
          const s = t.ground.surface(x, z, y);
          if (t.obstacles.heightAt(x, z) > s + 3 && d > 14 && (!best || d < best.d)) best = { a, d, x, z };
          break;
        }
        y = t.ground.surface(x, z, y); deck = t.ground.lastOnDeck;
      }
    }
    if (best) { c.heading = best.a; c.speed = 0; }
    return best;
  });
  if (!target) return { ok: false, reason: 'no building within 80 m in a clear line' };
  await sleep(300);
  await page.keyboard.down('KeyW');
  let s = await state(), t0 = Date.now(), moved = false;
  while (Date.now() - t0 < 20000) {
    await sleep(80); s = await state();
    if (s.speed > 1) moved = true;
    if (moved && s.blocked && Math.abs(s.speed) < 0.01) break;
  }
  await sleep(500);
  s = await state(); // read while the throttle is still held against the wall
  await page.keyboard.up('KeyW');
  const gap = Math.hypot(target.x - s.x, target.z - s.z);
  const inside = s.obstacle > s.y + 1.2;
  return { ok: moved && s.blocked && !inside && gap < 12, moved, blocked: s.blocked, speed: s.speed, gapToWall: +gap.toFixed(2), insideBuilding: inside, approach: target.d };
}

const report = { mode, base: BASE, quality: QUALITY, date: new Date().toISOString(), results: {} };
const R = report.results;
let ok = true;
const check = (name, cond, detail) => { R[name] = { pass: !!cond, ...detail }; if (!cond) ok = false; console.log(cond ? 'PASS' : 'FAIL', name, JSON.stringify(detail ?? {})); };

if (mode === 'phase0') {
  await open('spawn=shinjuku');
  const st = await settle(40000);
  await page.evaluate(() => { window.__td.car.heading = 1.7; window.__td.setCam(1); });
  await sleep(4000);
  const s = await state();
  check('city-renders', s.terrainReady && s.loadErrors === 0, { settle: st, shot: await shot('phase0-shinjuku'), fps: +s.fps.toFixed(1) });
}

if (mode === 'phase1') {
  await open('spawn=shinjuku');
  await settle(40000);
  await sleep(4500); // spawn clearance check runs 4 s after placement
  R.start = await state();
  await shot('phase1-start');
  const d = await drive({ metres: Number(process.env.METRES ?? 550), maxSeconds: 240 });
  // a drop off a kerb or ramp edge is allowed; what matters is that the car lands on a surface
  let s = await state();
  for (let i = 0; i < 12 && s.airborne; i++) { await sleep(250); s = await state(); }
  await shot('phase1-after-drive');
  const frames = await page.evaluate(() => window.__td.renderer.info.render.frame);
  check('drive>=500m', d.metres >= 500, { metres: +d.metres.toFixed(1), seconds: +d.seconds.toFixed(1) });
  check('stays-on-ground', s.minClearance > -0.1 && s.maxClearance < 0.3 && !s.airborne, { minClearance: +s.minClearance.toFixed(3), maxClearance: +s.maxClearance.toFixed(3) });
  check('ground-samples', s.fallbackSamples === 0, { samples: s.samples, fallback: s.fallbackSamples, msPerFrame: +(s.sampleMs / Math.max(1, frames)).toFixed(4) });
  const w = await wallTest();
  await shot('phase1-wall-stop');
  check('stops-at-wall', w.ok, w);
  await page.evaluate(() => window.__td.setCam(4)); await sleep(800); await shot('phase1-wall-top');
  check('fps', s.fps > 30, { fps: +s.fps.toFixed(1) });
}

if (mode === 'spawns') {
  const spawns = ['shinjuku', 'tokyo', 'fuchu', 'tachikawa', 'minatomirai', 'rainbow'];
  for (const id of spawns) {
    await open('spawn=' + id);
    const st = await settle(30000);
    await sleep(4500);
    const shots = [];
    let holes = 0;
    for (let k = 0; k < 4; k++) {
      await page.evaluate((h) => { window.__td.car.heading = h; window.__td.setCam(0); }, (k * Math.PI) / 2);
      await sleep(1500);
      shots.push(await shot(`spawn-${id}-${k * 90}`));
      // continuous ground: every sample out to 1.5 km in this direction has terrain (detail or safety) and finite height
      holes += await page.evaluate((h) => {
        const t = window.__td, c = t.car; let bad = 0;
        for (let d = 10; d <= 1500; d += 30) { const y = t.terrain.heightAt(c.x + Math.sin(h) * d, c.z - Math.cos(h) * d, c.y); if (!Number.isFinite(y) || Math.abs(y - c.y) > 400) bad++; }
        return bad;
      }, (k * Math.PI) / 2);
    }
    const s = await state();
    check('spawn-' + id, s.terrainReady && holes === 0 && Math.abs(s.y - s.surface) < 0.3, { settle: st, holes, y: +s.y.toFixed(1), lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), shots });
  }
}

if (mode === 'tour') {
  // one stop per municipality core, from the manifest the game is using
  const stops = JSON.parse(readFileSync(new URL('./tour-stops.json', import.meta.url), 'utf8'));
  await open('spawn=shinjuku');
  await settle(30000);
  for (const p of stops) {
    await teleport(p.lat, p.lon, p.heading ?? 0);
    await waitSettled();
    const t0 = Date.now();
    await sleep(5000);
    const after5 = await state();           // §9.5: critical tiles pending after 5 s
    const st = await settle(25000);
    await page.evaluate(() => window.__td.recover());
    await sleep(300);
    const before = await state();
    const d = await drive({ metres: 120, maxSeconds: 45, maxKmh: 40 });
    const s = await state();
    const good = s.terrainReady && d.metres >= 100 && !s.airborne && Math.abs(s.y - s.surface) < 0.3 && s.loadErrors === before.loadErrors;
    check('tour-' + p.id, good, { name: p.name, metres: +d.metres.toFixed(0), pendingAfter5s: after5.tilesPending + after5.terrainPending, terrainReadyAfter5s: after5.terrainReady, settleMs: st.waitedMs + (Date.now() - t0 - st.waitedMs > 0 ? 5000 : 0), fps: +s.fps.toFixed(0), shot: await shot('tour-' + p.id) });
  }
}

if (mode === 'roads') {
  // Acceptance for the vector road layer: driver's-view shot at Shinjuku and Fuchu,
  // continuous imagery on the road, markings sharp 10-30 m ahead, and a 30 s
  // static frame-difference test (two layers too close together would shimmer).
  for (const id of ['shinjuku', 'fuchu']) {
    await open('spawn=' + id);
    await settle(30000);
    await sleep(4500);
    await page.evaluate(() => { const t = window.__td; t.toRoad(7); t.setCam(3); });
    await page.waitForFunction(() => window.__td.roadSurface.builtCells >= 9, null, { timeout: 60000 });
    const st = await settle(40000);
    await sleep(3000);
    const file = await shot(`roads-${id}-driver`);
    const res = await page.evaluate(async (secs) => {
      const t = window.__td, c = t.car, cam = t.camera;
      // image rows that show the road 10 m and 30 m ahead
      const row = (d) => {
        const x = c.x + Math.sin(c.heading) * d, z = c.z - Math.cos(c.heading) * d;
        const y = t.ground.surface(x, z, c.y) + 0.1;
        const e = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
        const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
        const cy = p[5] * vy + p[9] * vz, cw = -vz;
        return { ndcY: cy / cw, ndcX: (p[0] * vx + p[8] * vz) / cw };
      };
      const first = await t.grab();
      const { w, h } = first;
      const lum = (px, i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      const yOf = (ndc) => Math.round(((ndc + 1) / 2) * (h - 1)); // readPixels rows are bottom-up
      const y10 = yOf(row(10).ndcY), y30 = yOf(row(30).ndcY);
      // sharpness: strongest luminance step between neighbouring pixels on each row of the 10-30 m band
      let sharpRows = 0, rows = 0, maxStep = 0;
      for (let y = Math.min(y10, y30); y <= Math.max(y10, y30); y++) {
        let best = 0;
        for (let x = Math.round(w * 0.2); x < Math.round(w * 0.8); x++) best = Math.max(best, Math.abs(lum(first.px, (y * w + x) * 4) - lum(first.px, (y * w + x + 1) * 4)));
        rows++; if (best >= 45) sharpRows++; maxStep = Math.max(maxStep, best);
      }
      // continuous imagery: road band below the 30 m row has no void (black) pixels
      let dark = 0, total = 0;
      for (let y = 0; y <= Math.max(y10, y30); y++) for (let x = 0; x < w; x += 2) { total++; if (lum(first.px, (y * w + x) * 4) < 4) dark++; }
      // flicker: compare one frame per second against the first, on the ground part of the image
      let worst = 0, frames = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < secs * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        const f = await t.grab(); frames++;
        let diff = 0, n = 0;
        for (let y = 0; y <= Math.max(y10, y30) + 20; y++) for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4; n++;
          if (Math.abs(f.px[i] - first.px[i]) > 10 || Math.abs(f.px[i + 1] - first.px[i + 1]) > 10 || Math.abs(f.px[i + 2] - first.px[i + 2]) > 10) diff++;
        }
        worst = Math.max(worst, diff / n);
      }
      return { w, h, band: [y10, y30], sharpRowFraction: sharpRows / rows, maxStep: Math.round(maxStep), voidFraction: dark / total, flickerWorstFraction: worst, frames, road: t.roads.nameAt(c.x, c.z), cells: t.roadSurface.builtCells };
    }, Number(process.env.SECONDS ?? 30));
    check(`roads-${id}-continuous`, res.voidFraction === 0, { voidFraction: res.voidFraction, shot: file, road: res.road });
    check(`roads-${id}-markings-sharp-10-30m`, res.sharpRowFraction >= 0.6 && res.maxStep >= 80, { sharpRowFraction: +res.sharpRowFraction.toFixed(2), maxStep: res.maxStep, rows: res.band });
    check(`roads-${id}-no-flicker-30s`, res.flickerWorstFraction < 0.002, { worstChangedFraction: +res.flickerWorstFraction.toFixed(5), frames: res.frames, settle: st });
  }
}

if (mode === 'jitter') {
  await open('spawn=tachikawa');
  await settle(30000);
  await sleep(4500);
  // park: sample the car's rendered (float32, camera-relative) position for 60 s
  const v = await page.evaluate(async (secs) => {
    const t = window.__td, xs = [], ys = [], zs = [];
    const f32 = new Float32Array(3);
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      await new Promise((r) => requestAnimationFrame(r));
      f32[0] = t.car.x; f32[1] = t.car.y; f32[2] = t.car.z; // what the GPU receives
      xs.push(f32[0]); ys.push(f32[1]); zs.push(f32[2]);
    }
    const range = (a) => Math.max(...a) - Math.min(...a);
    return { frames: xs.length, rangeX: range(xs), rangeY: range(ys), rangeZ: range(zs), x: t.car.x, z: t.car.z, f32step: Math.abs(Math.fround(t.car.x) - Math.fround(t.car.x + 0.004)) };
  }, Number(process.env.SECONDS ?? 60));
  check('no-jitter-at-tachikawa', Math.max(v.rangeX, v.rangeY, v.rangeZ) < 0.01, v);
  await shot('jitter-tachikawa');
}

check('no-console-errors', consoleErrors.length === 0, { errors: consoleErrors.slice(0, 8) });
report.pass = ok;
writeFileSync(join(OUT, `report-${mode}.json`), JSON.stringify(report, null, 1));
console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED', '-> screenshots/report-' + mode + '.json');
await browser.close();
process.exit(ok ? 0 : 1);

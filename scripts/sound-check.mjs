// Offline analysis of the synthesised car engine (headless Chrome has no speakers,
// but an OfflineAudioContext renders the same worklet to samples we can measure).
//   node scripts/sound-check.mjs
// Reports level, how much of the energy sits in the bass, and whether lifting off
// produces distinct pops. Needs the dev server running.
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/?autostart=1`);
await page.waitForFunction(() => window.__td?.ENGINE_WORKLET_SRC, null, { timeout: 120000 });
const res = await page.evaluate(async () => {
  const src = window.__td.ENGINE_WORKLET_SRC, sr = 48000;
  const render = async (secs, script) => {
    const ctx = new OfflineAudioContext(2, sr * secs, sr);
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    const n = new AudioWorkletNode(ctx, 'td-engine', { numberOfInputs: 0, outputChannelCount: [2] });
    n.connect(ctx.destination);
    for (const [t, msg] of script) ctx.suspend(t).then(() => { n.port.postMessage(msg); ctx.resume(); });
    return (await ctx.startRendering()).getChannelData(0);
  };
  const stats = (x, from = 0.6) => {
    const a = x.subarray(Math.floor(from * sr));
    let sum = 0, peak = 0, bad = 0;
    for (const v of a) { if (!Number.isFinite(v)) bad++; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    // band energies by Goertzel-free brute force DFT on a 1 s window, 10 Hz steps
    const N = Math.min(a.length, sr), band = { sub: 0, low: 0, mid: 0, high: 0 };
    let best = 0, bestF = 0;
    for (let f = 20; f <= 6000; f += f < 400 ? 5 : 50) {
      let re = 0, im = 0; const w = (2 * Math.PI * f) / sr;
      for (let i = 0; i < N; i += 2) { re += a[i] * Math.cos(w * i); im -= a[i] * Math.sin(w * i); }
      const p = (re * re + im * im) * (f < 400 ? 5 : 50);
      if (f < 80) band.sub += p; else if (f < 300) band.low += p; else if (f < 1500) band.mid += p; else band.high += p;
      if (f < 400 && re * re + im * im > best) { best = re * re + im * im; bestF = f; }
    }
    const tot = band.sub + band.low + band.mid + band.high || 1;
    return { rms: +Math.sqrt(sum / a.length).toFixed(3), peak: +peak.toFixed(3), nan: bad, strongestBelow400Hz: bestF,
      sub: +(band.sub / tot).toFixed(2), low: +(band.low / tot).toFixed(2), mid: +(band.mid / tot).toFixed(2), high: +(band.high / tot).toFixed(2) };
  };
  const base = { cyl: 8, redline: 8600, gear: 3, on: 1 };
  const out = {};
  out.idle = stats(await render(2, [[0.01, { ...base, rpm: 950, load: 0.05 }]]));
  out.cruise3000 = stats(await render(2, [[0.01, { ...base, rpm: 3000, load: 0.35 }]]));
  out.full7000 = stats(await render(2, [[0.01, { ...base, rpm: 7000, load: 1 }]]));
  out.inline4_4000 = stats(await render(2, [[0.01, { ...base, cyl: 4, redline: 6500, rpm: 4000, load: 0.8 }]]));
  // lift-off at 7000 rpm: count distinct pops in the following 2 s
  const x = await render(4, [[0.01, { ...base, rpm: 7000, load: 1 }], [1.5, { ...base, rpm: 6500, load: 0 }], [2.5, { ...base, rpm: 5000, load: 0 }]]);
  const env = []; const win = 240; // 5 ms
  for (let i = Math.floor(1.6 * sr); i + win < 3.6 * sr; i += win) { let m = 0; for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(x[i + k])); env.push(m); }
  const sorted = [...env].sort((a, b) => a - b), floor = sorted[Math.floor(sorted.length * 0.5)];
  let pops = 0; for (let i = 1; i < env.length - 1; i++) if (env[i] > floor * 1.8 + 0.03 && env[i] >= env[i - 1] && env[i] > env[i + 1]) pops++;
  out.overrun = { pops, medianLevel: +floor.toFixed(3), maxLevel: +sorted[sorted.length - 1].toFixed(3) };
  return out;
});
for (const [k, v] of Object.entries(res)) console.log(k.padEnd(14), JSON.stringify(v));
await browser.close();

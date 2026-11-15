// Ad-hoc headless screenshot helper:
//   node scripts/shot.mjs "<query>" <name> ["<js run in the page before the shot>"] [waitMs]
// e.g. node scripts/shot.mjs "spawn=fuchu" fuchu "__td.setCam(1)" 4000
// Writes screenshots/<name>.jpg and prints whatever the JS returns.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [query = '', name = 'shot', js = '', waitMs = '3000'] = process.argv.slice(2);
const OUT = join(process.env.TOKYODRIVE_SRC ?? process.cwd(), 'screenshots');
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const msgs = [];
page.on('console', (m) => { const t = m.text(); if ((m.type() === 'error' || m.type() === 'warning') && !/404|Failed to load resource|toNonIndexed/.test(t)) msgs.push(t.slice(0, 220)); });
page.on('pageerror', (e) => msgs.push('pageerror: ' + e.message));
await page.goto(`${process.env.BASE_URL ?? 'http://localhost:5173'}/?autostart=1&${query}`);
await page.waitForFunction(() => window.__td?.playing, null, { timeout: 120000 });
const t0 = Date.now();
while (Date.now() - t0 < 30000) { if (await page.evaluate(() => window.__td.pending === 0 && window.__td.terrain.isReady(window.__td.car.x, window.__td.car.z))) break; await new Promise((r) => setTimeout(r, 300)); }
await new Promise((r) => setTimeout(r, 4500)); // spawn snaps to the road 4 s after placement
let result = null;
if (js) result = await page.evaluate(`(async () => { ${js.includes('return') ? js : 'return ' + js} })()`);
await new Promise((r) => setTimeout(r, Number(waitMs)));
await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 82 });
console.log(JSON.stringify({ result, console: [...new Set(msgs)].slice(0, 6) }));
await browser.close();

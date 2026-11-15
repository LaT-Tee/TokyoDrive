import * as THREE from 'three';
import { CAMERA_FAR, CAMERA_NEAR, DATA_BASE, QUALITY, SPAWNS, type Quality, type SpawnPoint } from './config';
import { frame, setGeoid } from './geo/geodesy';
import { Terrain } from './world/Terrain';
import { HeightGrid } from './world/HeightGrid';
import { Ground } from './world/Ground';
import { Roads } from './world/Roads';
import { Decks } from './decks/Decks';
import { TilesManager, type Manifest } from './tiles/TilesManager';
import { CarController, type CarInput } from './car/CarController';
import { BODY_COLORS, CARS, CarVisual } from './car/garage';
import { Sky } from './sky/Sky';
import { Ui } from './ui/ui';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;

async function fetchJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

async function boot(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', depth: false, stencil: false });
  let quality = (params.get('quality') as Quality) || 'balanced';
  if (!QUALITY[quality]) quality = 'balanced';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[quality].pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
  scene.add(camera);

  // ---- data: geoid grid + manifest (self-hosted if present, else streaming prototype)
  const geoid = await fetchJson<any>(import.meta.env.BASE_URL + 'geoid.json');
  if (geoid) setGeoid(geoid); else console.warn('[geo] geoid grid missing, using constant offset');
  let dataBase = DATA_BASE;
  let manifest = await fetchJson<Manifest>(`${DATA_BASE}/manifest.json`);
  if (!manifest) {
    console.warn('[data] no self-hosted manifest at', DATA_BASE, '- using official streaming endpoints (prototype mode)');
    manifest = await fetchJson<Manifest>(import.meta.env.BASE_URL + 'manifest.remote.json');
    dataBase = '';
  }
  if (!manifest) throw new Error('No manifest available');
  const abs = (u: string) => (/^https?:/.test(u) || u.startsWith('/') ? u : `${dataBase}/${u}`);
  const t = manifest.terrain;

  // ---- world
  const terrain = new Terrain({ dem: t.dem.map(abs), demFill: t.demFill.map(abs), ortho: t.ortho.map(abs) }, Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  scene.add(terrain.group);
  const obstacles = new HeightGrid();
  const ground = new Ground(terrain, obstacles);
  const tiles = new TilesManager(manifest, dataBase, camera, renderer, obstacles);
  scene.add(tiles.root);
  const roads = new Roads(manifest.osm ? { zoom: manifest.osm.zoom, tiles: new Set(manifest.osm.tiles), base: `${dataBase}/osm` } : null);
  const decks = new Decks(roads, terrain, tiles);
  scene.add(decks.group);
  ground.decks.push(tiles, decks);
  const sky = new Sky(renderer, scene, camera);
  void terrain.buildSafetyGround(manifest.bounds, t.safetyDem.map(abs), t.safetyPhoto.map(abs));

  const applyQuality = (q: Quality) => {
    quality = q;
    tiles.setErrorTarget(QUALITY[q].errorTarget);
    tiles.loadDistance = QUALITY[q].loadDistance;
    tiles.maxTextureSize = QUALITY[q].textureSize;
    sky.setAerial(QUALITY[q].aerial);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[q].pixelRatio));
    onResize();
  };

  // ---- car
  let spec = CARS.find((c) => c.id === params.get('car')) ?? CARS[0];
  let color = params.get('color') ? '#' + params.get('color') : BODY_COLORS[0];
  const visual = new CarVisual();
  scene.add(visual.root);
  const car = new CarController(ground, spec);
  await visual.load(spec);
  visual.setColor(color);

  // ---- state
  let spawn = SPAWNS.find((s) => s.id === params.get('spawn')) ?? SPAWNS[0];
  let playing = false;
  let settled = false;       // car has been placed on loaded ground
  let headlights = false;
  const CAMS = ['CHASE', 'CHASE FAR', 'HOOD', 'TOP'] as const;
  let camMode = 0;
  let camHeading = 0;
  let garageOrbit = 0;

  const teleport = (lat: number, lon: number, headingDeg: number) => {
    const p = frame.llaToLocal(lat, lon, 0);
    car.x = p.x; car.z = p.z; car.heading = (headingDeg * Math.PI) / 180; car.speed = 0;
    car.y = terrain.heightAt(p.x, p.z);
    camHeading = car.heading;
    settled = false;
  };

  /** Recover (R): nearest road centreline point, else nearest free ground. */
  const recover = () => {
    const r = roads.nearest(car.x, car.z, 400);
    if (r) {
      const y = ground.surface(r.x, r.z, r.bridge ? 1e4 : terrain.heightAt(r.x, r.z, car.y) + 1);
      car.x = r.x; car.z = r.z; car.heading = r.heading; car.speed = 0; car.vy = 0; car.y = y;
      return;
    }
    // no road data nearby: spiral out to the nearest cell without an obstacle
    for (let ring = 0; ring < 60; ring++) for (let k = 0; k < Math.max(1, ring * 6); k++) {
      const a = (k / Math.max(1, ring * 6)) * Math.PI * 2, x = car.x + Math.cos(a) * ring * 3, z = car.z + Math.sin(a) * ring * 3;
      const s = terrain.heightAt(x, z, car.y);
      let free = true;
      for (const [ox, oz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) if (obstacles.heightAt(x + ox, z + oz) > s + 1) { free = false; break; }
      if (free) { car.x = x; car.z = z; car.speed = 0; car.vy = 0; car.y = s; return; }
    }
  };

  const ui = new Ui(document.getElementById('ui')!, {
    onCar: (s) => { spec = s; car.spec = s; void visual.load(s); },
    onColor: (c) => { color = c; visual.setColor(c); },
    onSpawn: (s: SpawnPoint) => { spawn = s; teleport(s.lat, s.lon, s.heading); },
    onQuality: applyQuality,
    onStart: () => { playing = true; ui.showGarage(false); canvas.focus(); },
    onOpenGarage: () => { playing = false; car.speed = 0; ui.showGarage(true); },
  }, { car: spec.id, color, spawn: spawn.id, quality });
  applyQuality(quality);
  teleport(spawn.lat, spawn.lon, spawn.heading);

  // ---- input
  const keys = new Set<string>();
  const CONTROL = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (CONTROL.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (!playing) { if (e.code === 'Enter' && settled) { playing = true; ui.showGarage(false); } return; }
    if (e.code === 'KeyC') camMode = (camMode + 1) % CAMS.length;
    if (e.code === 'KeyL') { headlights = !headlights; visual.setHeadlights(headlights); }
    if (e.code === 'KeyR') recover();
    if (e.code === 'KeyG') { playing = false; car.speed = 0; ui.showGarage(true); }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const readInput = () => {
    const k = (a: string, b: string) => (keys.has(a) || keys.has(b) ? 1 : 0);
    input.throttle = k('KeyW', 'ArrowUp'); input.brake = k('KeyS', 'ArrowDown');
    input.steer = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    input.handbrake = keys.has('Space');
  };

  function onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    sky.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  // ---- camera
  const camPos = new THREE.Vector3(), look = new THREE.Vector3(), focus = new THREE.Vector3();
  const updateCamera = (dt: number) => {
    const fx = Math.sin(car.heading), fz = -Math.cos(car.heading);
    if (!playing) {
      // garage: slow orbit around the car
      garageOrbit += dt * 0.25;
      const a = car.heading + 2.4 + Math.sin(garageOrbit) * 0.5;
      camPos.set(car.x + Math.sin(a) * 7.5, car.y + 2.3, car.z - Math.cos(a) * 7.5);
      look.set(car.x, car.y + 0.8, car.z);
      camera.up.set(0, 1, 0);
    } else if (camMode <= 1) {
      let d = car.heading - camHeading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      camHeading += d * (1 - Math.exp(-dt * 5));
      const dist = camMode === 0 ? 6.8 : 14, h = camMode === 0 ? 2.5 : 5.5;
      const cx = Math.sin(camHeading), cz = -Math.cos(camHeading);
      camPos.set(car.x - cx * dist, car.y + h, car.z - cz * dist);
      look.set(car.x + fx * 4, car.y + 1.2, car.z + fz * 4);
      camera.up.set(0, 1, 0);
    } else if (camMode === 2) {
      camPos.set(car.x + fx * 0.25, car.y + spec.eyeHeight, car.z + fz * 0.25);
      look.set(car.x + fx * 30, car.y + spec.eyeHeight - 0.6 + Math.sin(car.pitch) * 30, car.z + fz * 30);
      camera.up.set(0, 1, 0); camHeading = car.heading;
    } else {
      camPos.set(car.x, car.y + 90, car.z);
      look.set(car.x, car.y, car.z);
      camera.up.set(fx, 0, fz); camHeading = car.heading;
    }
    if (camMode !== 2 || !playing) {
      const gy = Math.max(terrain.heightAt(camPos.x, camPos.z, camPos.y), obstacles.heightAt(camPos.x, camPos.z) > camPos.y + 30 ? -Infinity : -Infinity) + 0.7;
      if (camPos.y < gy) camPos.y = gy;
    }
    camera.position.copy(camPos);
    camera.lookAt(look);
    camera.updateMatrixWorld();
  };

  // ---- loop
  const fps = { frames: 0, t: performance.now(), value: 0, worst: 0 };
  let last = performance.now(), lastTerrain = -1e9, frameNo = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    const rawDt = now - last; last = now; frameNo++;
    fps.frames++; fps.worst = Math.max(fps.worst, rawDt);
    if (now - fps.t >= 1000) { fps.value = (fps.frames * 1000) / (now - fps.t); fps.frames = 0; fps.t = now; }

    if (now - lastTerrain > 200) { lastTerrain = now; terrain.update(car.x, car.z, QUALITY[quality].terrainRadius, car.y); roads.update(car.x, car.z); decks.update(car.x, car.z); }

    if (!settled) {
      // wait for the detailed ground under the car before placing it
      if (terrain.isReady(car.x, car.z, car.y)) {
        car.place(car.x, car.z, (car.heading * 180) / Math.PI);
        settled = true;
        // once nearby data has had a moment to load, make sure we did not spawn inside a building
        const sx = car.x, sz = car.z;
        setTimeout(() => { if (Math.hypot(car.x - sx, car.z - sz) < 1 && (obstacles.heightAt(car.x, car.z) > car.y + 1 || roads.hasData(car.x, car.z))) recover(); }, 4000);
      }
    } else if (playing) {
      readInput();
      car.update(dt, input);
    }
    ui.setStartEnabled(settled, settled ? 'DRIVE' : 'LOADING…');

    visual.root.position.set(car.x, car.y, car.z);
    visual.root.rotation.set(car.pitch, -car.heading, -car.roll, 'YXZ');
    visual.animate(car.wheelSpin, car.steer);
    visual.root.visible = !(playing && camMode === 2);

    updateCamera(dt);
    tiles.update(car.x, car.z, now);
    obstacles.update(2.5);
    focus.set(car.x, car.y, car.z);
    sky.update(focus);
    sky.render(dt);

    if (playing && frameNo % 6 === 0) {
      const pending = tiles.pending + terrain.pendingChunks;
      const road = roads.nameAt(car.x, car.z);
      ui.setHud(car.speed * 3.6, tiles.placeName(car.x, car.z), road, CAMS[camMode], headlights, pending > 0 ? `LOADING ${pending}` : '');
    }
  };
  requestAnimationFrame(loop);

  // ---- debug / test hooks (used by scripts/headless-check.mjs)
  (window as any).__td = {
    car, ground, terrain, tiles, obstacles, roads, decks, sky, camera, renderer, fps, frame,
    get settled() { return settled; }, get playing() { return playing; },
    teleport, recover,
    start() { playing = true; ui.showGarage(false); },
    setCam(i: number) { camMode = i % CAMS.length; },
    setQuality: applyQuality,
    get pending() { return tiles.pending + terrain.pendingChunks + obstacles.pendingJobs; },
    lla() { return frame.localToLla(car.x, car.y, car.z); },
  };
  if (params.get('autostart')) { const iv = setInterval(() => { if (settled) { clearInterval(iv); playing = true; ui.showGarage(false); } }, 100); }
}

boot().catch((e) => {
  console.error(e);
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;inset:0;padding:24px;color:#ffb4a8;background:#0c0e12;white-space:pre-wrap;z-index:9';
  d.textContent = 'Tokyo Drive failed to start:\n' + (e?.stack ?? e);
  document.body.append(d);
});

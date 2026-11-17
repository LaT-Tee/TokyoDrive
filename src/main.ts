import * as THREE from 'three';
import { CAMERA_FAR, CAMERA_NEAR, DATA_BASE, QUALITY, SPAWNS, type Quality, type SpawnPoint } from './config';
import { frame, setGeoid } from './geo/geodesy';
import { Terrain, groundUniforms } from './world/Terrain';
import { HeightGrid } from './world/HeightGrid';
import { Ground } from './world/Ground';
import { Roads } from './world/Roads';
import { Vegetation } from './world/Vegetation';
import { Decks } from './decks/Decks';
import { TUNNEL_H, Tunnels } from './tunnels/Tunnels';
import { ROAD_LIFT, RoadSurface } from './roads/RoadSurface';
import { TilesManager, type Manifest } from './tiles/TilesManager';
import { GoogleFill } from './tiles/GoogleFill';
import { CarController, type CarInput } from './car/CarController';
import { BODY_COLORS, CARS, VEHICLES, CarVisual, initCarLoaders } from './car/garage';
import { AircraftController, AircraftVisual, AIR_SPAWN_AGL, type AirInput } from './air/Aircraft';
import { EngineSound, ENGINE_WORKLET_SRC } from './audio/EngineSound';
import { Sky } from './sky/Sky';
import { Ui } from './ui/ui';
import { MapView } from './ui/MapView';

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

  initCarLoaders(renderer);
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
  const tunnels = new Tunnels(roads, terrain);
  scene.add(tunnels.group);
  const roadSurface = new RoadSurface(roads, terrain, decks, tiles);
  scene.add(roadSurface.group);
  const vegetation = new Vegetation(terrain, obstacles, roads);
  scene.add(vegetation.group);
  ground.decks.push(tiles, decks);
  ground.tunnels = tunnels;
  ground.onRoad = (x, z) => { const r = roads.nearest(x, z, 12); return !!r && r.dist <= r.width / 2 - 0.3; };
  const googleFill = new GoogleFill(camera, renderer); // colour source only: never added to the scene
  const readToken = () => { try { return localStorage.getItem('td.googleToken') ?? ''; } catch { return ''; } };
  const googleToken = readToken() || (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) || (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || '';
  const sky = new Sky(renderer, scene, camera);
  void terrain.buildSafetyGround(manifest.bounds, t.safetyDem.map(abs), t.safetyPhoto.map(abs));

  let visual: CarVisual | null = null;
  let resScale = 1; // dynamic resolution: lowered while the frame rate is under target
  let appliedQuality: Quality | null = null;
  const applyQuality = (q: Quality) => {
    quality = q;
    tiles.setErrorTarget(QUALITY[q].errorTarget);
    tiles.loadDistance = QUALITY[q].loadDistance;
    tiles.textureNear = QUALITY[q].textureNear; tiles.textureFar = QUALITY[q].textureFar;
    tiles.setCacheLimit(QUALITY[q].cacheGB);
    sky.setShadows(QUALITY[q].shadowSize, QUALITY[q].shadowRange);
    // load the real models all around the car, not only in view, so turning never reveals gaps
    tiles.nearRange = Math.max(420, QUALITY[q].shadowRange + 60);
    sky.setAerial(QUALITY[q].aerial);
    vegetation.enabled = q !== 'performance';
    resScale = 1;
    // textures are sized when a tile is loaded: reload so the new setting is actually visible
    if (appliedQuality && appliedQuality !== q) tiles.reload();
    visual?.refreshMaterials();
    setTimeout(() => visual?.refreshMaterials(), 1200);
    appliedQuality = q;
    onResize();
  };

  // ---- car
  let spec = VEHICLES.find((c) => c.id === params.get('car')) ?? CARS[0];
  const flying = () => spec.kind !== 'car';
  const airc = new AircraftController(); airc.kind = spec.kind;
  const airVisual = new AircraftVisual(); airVisual.setKind(spec.kind);
  scene.add(airVisual.root);
  const sound = new EngineSound();
  let color = params.get('color') ? '#' + params.get('color') : BODY_COLORS[0];
  visual = new CarVisual();
  scene.add(visual.root);
  const car = new CarController(ground, spec);
  await visual.load(spec.kind === 'car' ? spec : CARS[0]);
  visual.setColor(color); airVisual.setColor(color);

  // ---- state
  let spawn = SPAWNS.find((s) => s.id === params.get('spawn')) ?? SPAWNS[0];
  let playing = false;
  let settled = false;       // car has been placed on loaded ground
  let headlights = false;    // driver's switch (L)
  let inTunnel = false;
  const CAMS = ['追尾', '远追尾', '车内', '引擎盖', '俯视'] as const;
  let camMode = 0;
  let camHeading = 0;
  let garageOrbit = 0;
  // mouse look: drag to look around, wheel to zoom; recentres while driving
  const look = { yaw: 0, pitch: 0, zoom: 1, dragging: false, lastInput: 0 };

  const teleport = (lat: number, lon: number, headingDeg: number) => {
    const p = frame.llaToLocal(lat, lon, 0);
    car.x = p.x; car.z = p.z; car.heading = (headingDeg * Math.PI) / 180; car.course = car.heading; car.speed = 0;
    car.y = terrain.heightAt(p.x, p.z);
    camHeading = car.heading; look.yaw = 0; look.pitch = 0;
    settled = false;
    if (flying()) {
      // aircraft are deployed straight into the air, already flying: no waiting for the ground
      airc.deploy(p.x, terrain.heightAt(p.x, p.z), p.z, car.heading);
      syncAir(); settled = true;
    }
  };
  /** The camera, HUD and streaming all follow `car`'s pose: mirror the aircraft into it. */
  const syncAir = () => { car.x = airc.x; car.y = airc.y; car.z = airc.z; car.heading = airc.heading; car.course = airc.heading; car.pitch = airc.pitch; car.roll = airc.roll; car.speed = airc.speed; };

  /** Recover (R): nearest road centreline point, else nearest free ground. */
  const recover = (maxCls = 99) => {
    if (flying()) { airc.deploy(car.x, terrain.heightAt(car.x, car.z), car.z, car.heading); syncAir(); return; }
    const r = roads.nearest(car.x, car.z, 400, maxCls);
    if (r) {
      const g = terrain.heightAt(r.x, r.z, car.y);
      // on a bridge, land on the deck (procedural or real PLATEAU model), not on the ground below it
      const y = r.bridge ? Math.max(g, decks.deckHeight(r.x, r.z, 1e9), tiles.castDown(r.x, g + 150, r.z, 151)) : ground.surface(r.x, r.z, g + 1);
      car.x = r.x; car.z = r.z; car.heading = r.heading; car.course = r.heading; car.speed = 0; car.vy = 0; car.y = y;
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

  const openGarage = () => { playing = false; car.speed = 0; map.show(false); ui.showGarage(true); };
  const cycleCamera = () => { camMode = (camMode + 1) % CAMS.length; look.yaw = 0; look.pitch = 0; };
  const toggleLights = () => { headlights = !headlights; };
  const toggleMap = () => {
    if (map.open) { map.show(false); return; }
    const g = frame.localToLla(car.x, car.y, car.z);
    map.show(true, { lat: g.lat, lon: g.lon, heading: car.heading });
  };

  const ui = new Ui(document.getElementById('ui')!, {
    onCar: (s) => {
      const wasCar = spec.kind === 'car';
      spec = s; car.spec = s; airc.kind = s.kind; airVisual.setKind(s.kind);
      if (s.kind === 'car') void visual!.load(s).then(() => visual!.refreshMaterials());
      // switching between ground and air (or between aircraft) re-deploys at the current place
      if (wasCar !== (s.kind === 'car') || s.kind !== 'car') { const g = frame.localToLla(car.x, car.y, car.z); teleport(g.lat, g.lon, (car.heading * 180) / Math.PI); }
    },
    onColor: (c) => { color = c; visual!.setColor(c); airVisual.setColor(c); },
    onSpawn: (s: SpawnPoint) => { spawn = s; teleport(s.lat, s.lon, s.heading); },
    onQuality: applyQuality,
    onStart: () => { playing = true; ui.showGarage(false); canvas.focus(); sound.start(); },
    onOpenGarage: openGarage,
    onCycleCamera: cycleCamera,
    onToggleLights: toggleLights,
    onMap: toggleMap,
    onRecover: () => recover(),
    onGoogleToken: (token) => {
      try { if (token.trim()) localStorage.setItem('td.googleToken', token.trim()); else localStorage.removeItem('td.googleToken'); } catch { /* private window */ }
      googleFill.setToken(token);
    },
  }, { car: spec.id, color, spawn: spawn.id, quality, googleToken });
  if (googleToken) googleFill.setToken(googleToken);
  const map = new MapView({
    bounds: manifest.bounds,
    coverage: manifest.tilesets.filter((s) => s.type === 'bldg').map((s) => s.bounds),
    spawns: SPAWNS,
    covers: (lat, lon) => tiles.covers(lat, lon),
    onPick: (lat, lon) => { map.show(false); teleport(lat, lon, (car.heading * 180) / Math.PI); },
    onClose: () => map.show(false),
  });
  document.getElementById('ui')!.append(map.el);
  applyQuality(quality);
  teleport(spawn.lat, spawn.lon, spawn.heading);

  // ---- input
  const keys = new Set<string>();
  const CONTROL = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (CONTROL.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (!playing) { if (e.code === 'Enter' && settled) { playing = true; ui.showGarage(false); sound.start(); } return; }
    sound.start(); // browsers only allow audio after a key press or click
    if (e.code === 'KeyN') sound.muted = !sound.muted;
    if (e.code === 'KeyM' || (e.code === 'Escape' && map.open)) { toggleMap(); return; }
    if (map.open) return;
    if (e.code === 'KeyC') cycleCamera();
    if (e.code === 'KeyL') toggleLights();
    if (e.code === 'KeyR') recover();
    if (e.code === 'KeyG') openGarage();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  const input: CarInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const readInput = () => {
    const k = (a: string, b: string) => (keys.has(a) || keys.has(b) ? 1 : 0);
    input.throttle = k('KeyW', 'ArrowUp'); input.brake = k('KeyS', 'ArrowDown');
    input.steer = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    input.handbrake = keys.has('Space');
    const shift = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0, space = keys.has('Space') ? 1 : 0;
    // plane: W pushes the nose down, S pulls up. helicopter: W forward, S backward.
    airIn.pitch = airc.kind === 'plane' ? input.brake - input.throttle : input.throttle - input.brake;
    airIn.roll = input.steer;
    airIn.side = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    airIn.lift = space - shift;
  };
  const airIn: AirInput = { pitch: 0, roll: 0, lift: 0, side: 0 };
  canvas.addEventListener('pointerdown', (e) => { if (!playing) return; look.dragging = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!look.dragging) return;
    look.yaw += e.movementX * 0.0055; look.pitch += e.movementY * 0.004; look.lastInput = performance.now();
    look.pitch = Math.max(-0.35, Math.min(1.1, look.pitch));
    if (camMode === 2 || camMode === 3) look.yaw = Math.max(-2.3, Math.min(2.3, look.yaw));
  });
  const endDrag = () => { look.dragging = false; look.lastInput = performance.now(); };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => { if (!playing) return; e.preventDefault(); look.zoom = Math.max(0.5, Math.min(3, look.zoom * (e.deltaY > 0 ? 1.1 : 0.9))); }, { passive: false });

  function onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[quality].pixelRatio) * resScale);
    renderer.setSize(w, h, false);
    sky.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);

  // ---- camera
  const camPos = new THREE.Vector3(), lookAt = new THREE.Vector3(), focus = new THREE.Vector3();
  const updateCamera = (dt: number, now: number) => {
    const fx = Math.sin(car.heading), fz = -Math.cos(car.heading), rx = -fz, rz = fx;
    // let the view drift back behind the car a moment after the mouse is released, while moving
    if (!look.dragging && now - look.lastInput > 2500 && Math.abs(car.speed) > 2) {
      const k = 1 - Math.exp(-dt * 2.5);
      look.yaw += -Math.atan2(Math.sin(look.yaw), Math.cos(look.yaw)) * k; look.pitch -= look.pitch * k;
    }
    camera.fov = 62;
    if (!playing) {
      // garage: slow orbit around the car
      garageOrbit += dt * 0.25;
      const a = car.heading + 2.4 + Math.sin(garageOrbit) * 0.5;
      camPos.set(car.x + Math.sin(a) * 7.5, car.y + 2.3, car.z - Math.cos(a) * 7.5);
      lookAt.set(car.x, car.y + 0.8, car.z);
      camera.up.set(0, 1, 0);
    } else if (camMode <= 1) {
      let d = car.heading - camHeading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      camHeading += d * (1 - Math.exp(-dt * 5));
      const dist = (camMode === 0 ? 6.8 : 14) * look.zoom * spec.camDist, base = camMode === 0 ? 0.36 : 0.39;
      const el = Math.max(0.04, Math.min(1.45, base + look.pitch)), a = camHeading + look.yaw;
      camPos.set(car.x - Math.sin(a) * dist * Math.cos(el), car.y + 1.0 + dist * Math.sin(el), car.z + Math.cos(a) * dist * Math.cos(el));
      // looking around aims at the car; straight behind it, aim a little ahead
      const ahead = 4 * Math.max(0, Math.cos(look.yaw));
      lookAt.set(car.x + fx * ahead, car.y + 1.2, car.z + fz * ahead);
      camera.up.set(0, 1, 0);
    } else if (camMode === 2 || camMode === 3) {
      // 2: driver's seat (right-hand drive)   3: hood
      const side = camMode === 2 && !flying() ? 0.36 : 0, back = camMode === 2 ? -0.25 : 0.25, h = camMode === 2 ? spec.eyeHeight + 0.02 : spec.eyeHeight;
      camPos.set(car.x + rx * side + fx * back, car.y + h, car.z + rz * side + fz * back);
      const a = car.heading + look.yaw, p = -0.02 - look.pitch + car.pitch;
      lookAt.set(camPos.x + Math.sin(a) * Math.cos(p) * 30, camPos.y + Math.sin(p) * 30, camPos.z - Math.cos(a) * Math.cos(p) * 30);
      camera.up.set(0, 1, 0); camHeading = car.heading;
      camera.fov = camMode === 2 ? 68 / Math.sqrt(look.zoom) : 62;
    } else {
      camPos.set(car.x, car.y + 90 * look.zoom, car.z);
      lookAt.set(car.x, car.y, car.z);
      camera.up.set(fx, 0, fz); camHeading = car.heading;
    }
    if (camMode <= 1 || !playing) {
      if (inTunnel) {
        // stay inside the tube: under its ceiling, and close enough not to cut through the walls
        const tf = tunnels.floorAt(camPos.x, camPos.z, car.y);
        const top = (tf === tf ? tf : car.y) + TUNNEL_H - 0.45;
        if (camPos.y > top) camPos.y = top;
        if (tf !== tf) camPos.lerp(focus.set(car.x, car.y + 1.6, car.z), 0.6);
      } else {
        const gy = terrain.heightAt(camPos.x, camPos.z, camPos.y) + 0.7;
        if (camPos.y < gy) camPos.y = gy;
      }
    }
    camera.position.copy(camPos);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };

  let crashes = 0;
  const grabs: ((f: { w: number; h: number; px: Uint8Array }) => void)[] = [];
  // ---- loop
  const fps = { frames: 0, t: performance.now(), value: 0, worst: 0 };
  let last = performance.now(), lastTerrain = -1e9, frameNo = 0, tilesVersion = -1, slowSeconds = 0, lightsOn = false, airMode = false, crashAt = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    const rawDt = now - last; last = now; frameNo++;
    fps.frames++; fps.worst = Math.max(fps.worst, rawDt);
    if (now - fps.t >= 1000) {
      fps.value = (fps.frames * 1000) / (now - fps.t); fps.frames = 0; fps.t = now;
      // dynamic resolution: trade pixels for frame rate, restore them when there is headroom
      // (loading hitches do not count: only sustained slowness while nothing is pending)
      const before = resScale;
      slowSeconds = fps.value < 50 && tiles.pending === 0 ? slowSeconds + 1 : 0;
      if (slowSeconds >= 3 && resScale > 0.55) { resScale = Math.max(0.55, resScale - 0.1); slowSeconds = 1; }
      else if (fps.value > 57 && resScale < 1) resScale = Math.min(1, resScale + 0.1);
      if (resScale !== before) onResize();
      // surface friction: asphalt on a road ribbon or in a tunnel, loose ground elsewhere
      if (flying()) {
        // from the air: see further, accept simplified distant buildings, keep the frame rate
        const f = Math.max(0, Math.min(4, (car.y - terrain.heightAt(car.x, car.z)) / 200));
        tiles.loadDistance = QUALITY[quality].loadDistance * (1 + f * 0.8);
        tiles.setErrorTarget(QUALITY[quality].errorTarget * (1 + f * 2.5));
        // distant white boxes so the city does not end at the edge of the detailed layer
        tiles.farEnabled = true;
        tiles.farDistance = Math.min(12000, 3500 + f * 200 * 10);
        airMode = true;
      } else if (airMode) { airMode = false; tiles.loadDistance = QUALITY[quality].loadDistance; tiles.setErrorTarget(QUALITY[quality].errorTarget); tiles.farEnabled = false; }
      if (flying()) { /* no tyres on the ground */ }
      else if (inTunnel) car.surfaceGrip = 1;
      else if (roads.enabled && roads.hasData(car.x, car.z)) { const r = roads.nearest(car.x, car.z, 14); car.surfaceGrip = r && r.dist <= r.width / 2 + 1.2 ? 1 : 0.62; } else car.surfaceGrip = 1;
    }
    if (tiles.version !== tilesVersion) { tilesVersion = tiles.version; sky.invalidateShadows(); }

    if (now - lastTerrain > 200) {
      lastTerrain = now;
      terrain.update(car.x, car.z, QUALITY[quality].terrainRadius, car.y);
      roads.update(car.x, car.z); decks.update(car.x, car.z); tunnels.update(car.x, car.z);
      roadSurface.update(car.x, car.z);
      vegetation.enabled = quality !== 'performance';
      vegetation.update(car.x, car.z);
    }

    if (!settled) {
      // wait for the detailed ground under the car before placing it
      if (terrain.isReady(car.x, car.z, car.y)) {
        car.place(car.x, car.z, (car.heading * 180) / Math.PI);
        settled = true;
        // once nearby data has had a moment to load, snap onto the nearest road (or out of a building)
        const sx = car.x, sz = car.z;
        setTimeout(() => { if (Math.hypot(car.x - sx, car.z - sz) < 1 && (obstacles.heightAt(car.x, car.z) > car.y + 1 || roads.hasData(car.x, car.z))) { recover(); camHeading = car.heading; } }, 4000);
      }
    } else if (playing && !map.open) {
      readInput();
      if (flying()) {
        const gy = terrain.heightAt(car.x, car.z, car.y);
        if (airc.crashed) { if (now - crashAt > 1200) { airc.deploy(car.x, gy, car.z, car.heading); } }
        else {
          airc.update(dt, airIn, gy);
          // hitting the ground, water or a building ends the flight; it restarts in the air
          const floor = Math.max(terrain.heightAt(airc.x, airc.z, airc.y), obstacles.heightAt(airc.x, airc.z));
          if (airc.y < floor + 1.2) { airc.y = floor + 1.2; airc.crashed = true; airc.speed = 0; crashAt = now; crashes++; }
        }
        syncAir();
      } else car.update(dt, input);
    }
    ui.setStartEnabled(settled, settled ? '出发' : '加载中…');

    // tunnels: lights come on by themselves
    if (flying()) inTunnel = false;
    else if (settled) { ground.samples--; ground.surface(car.x, car.z, car.y); inTunnel = ground.lastInTunnel; }
    const wantLights = headlights || inTunnel;
    if (wantLights !== lightsOn) { lightsOn = wantLights; visual.setHeadlights(lightsOn); }

    visual.root.position.set(car.x, car.y + (inTunnel ? 0.02 : ROAD_LIFT), car.z);
    visual.root.rotation.set(car.pitch, -car.heading, -car.roll, 'YXZ');
    visual.animate(car.wheelSpin, car.steer);
    const firstPerson = playing && (camMode === 2 || camMode === 3);
    visual.root.visible = !firstPerson && !flying();
    airVisual.root.visible = flying() && !firstPerson;
    airVisual.root.position.set(car.x, car.y, car.z);
    airVisual.root.rotation.set(car.pitch, -car.heading, -car.roll, 'YXZ');
    airVisual.animate(airc as any, dt);
    ui.setCockpit(playing && camMode === 2 && !flying(), car.steer);
    if (flying()) sound.update(spec.engine, airc.rpm, airc.load, Math.abs(airc.speed), playing && !map.open && !airc.crashed);
    else sound.update(spec.engine, car.rpm, car.throttle, Math.abs(car.speed), playing && !map.open, car.gear);

    updateCamera(dt, now);
    tiles.update(car.x, car.z, now);
    googleFill.update();
    obstacles.update(2.5);
    groundUniforms.tdTime.value = now / 1000;
    focus.set(car.x, car.y, car.z);
    sky.update(focus);
    googleFill.render();
    sky.render(dt);
    if (grabs.length) { const gl = renderer.getContext(); const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight; const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); for (const g of grabs.splice(0)) g({ w, h, px }); }

    if (frameNo % 15 === 0) {
      ui.setGoogleStatus(({ off: '未启用', loading: '连接中…', on: '已启用', error: '失败：' + googleFill.message } as const)[googleFill.status]);
      ui.setCredits(googleFill.credits);
    }
    if (playing && frameNo % 6 === 0) {
      const pending = tiles.pending + terrain.pendingChunks;
      const road = roads.nameAt(car.x, car.z);
      const info = flying()
        ? `离地 ${Math.max(0, Math.round(car.y - terrain.heightAt(car.x, car.z)))} m${airc.kind === 'plane' ? ` · 油门 ${Math.round(airc.throttle * 100)}%` : ''}${airc.crashed ? ' · 坠毁，重新部署中' : ''}`
        : `${inTunnel ? (road ? road + '（隧道）' : '隧道') : road}${road || inTunnel ? ' · ' : ''}${car.speed < -0.3 ? 'R' : car.gear} 挡 ${Math.round(car.rpm / 100) * 100} rpm`;
      ui.setHud(car.speed * 3.6, tiles.placeName(car.x, car.z), info, CAMS[camMode], lightsOn, pending > 0 ? `加载中 ${pending}` : '');
    }
  };
  requestAnimationFrame(loop);

  // ---- debug / test hooks (used by scripts/headless-check.mjs)
  (window as any).__td = {
    THREE, car, airc, sound, googleFill, ENGINE_WORKLET_SRC, get flying() { return flying(); }, get crashes() { return crashes; }, AIR_SPAWN_AGL,
    ground, terrain, tiles, obstacles, roads, decks, tunnels, roadSurface, vegetation, sky, camera, renderer, fps, frame, look, map,
    get settled() { return settled; }, get playing() { return playing; }, get inTunnel() { return inTunnel; },
    teleport, recover,
    /** Test helper: snap to the nearest road of at least the given class (0 motorway … 12 living street). */
    toRoad(maxCls: number) { recover(maxCls); camHeading = car.heading; },
    /** Pixels of the next rendered frame (bottom-up RGBA), for image checks. */
    grab() { return new Promise<{ w: number; h: number; px: Uint8Array }>((r) => grabs.push(r)); },
    hideHud(h: boolean) { document.getElementById('ui')!.style.display = h ? 'none' : ''; },
    start() { playing = true; ui.showGarage(false); },
    /** 0 chase, 1 far chase, 2 cockpit, 3 hood, 4 top-down. */
    setCam(i: number) { camMode = i % CAMS.length; look.yaw = 0; look.pitch = 0; },
    setQuality: applyQuality,
    get resScale() { return resScale; },
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

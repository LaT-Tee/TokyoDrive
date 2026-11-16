// Garage data + car visuals.
//  - Hero car: Khronos "Car Concept" (CC-BY 4.0, see public/cars/concept/LICENSE.md):
//    ~213k triangles, PBR clear-coat paint, full interior. The only detailed car.
//  - Low-poly cars: Kenney "Car Kit" (CC0, public/cars/LICENSE-kenney-car-kit.txt).
// The body colour picker recolours the paint at runtime.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

export type VehicleKind = 'car' | 'plane' | 'heli';
export interface EngineSpec { cylinders: number; idle: number; redline: number; gears: number; tone: 'piston' | 'prop' | 'heli' }

export interface CarSpec {
  id: string; name: string; note: string;
  kind: VehicleKind;
  file: string;              // GLB / glTF under public/cars (cars only)
  hero?: boolean;
  length: number; width: number; wheelbase: number; wheelRadius: number;
  topSpeed: number;          // km/h, the real-world figure for this class of car
  accel: number; brake: number; // m/s^2 at low speed / maximum braking
  traction: number;          // share of grip usable for acceleration (RWD ≈ 0.62, AWD supercar ≈ 0.95)
  eyeHeight: number;         // driver's eye above the ground
  grip: number;              // tyre grip multiplier
  camDist: number;           // chase camera distance multiplier
  engine: EngineSpec;
}

const kenney = (id: string, name: string, note: string, file: string, o: Partial<CarSpec>): CarSpec => ({
  id, name, note, kind: 'car', file, length: 4.45, width: 1.75, wheelbase: 2.6, wheelRadius: 0.33, topSpeed: 190, accel: 3.4, brake: 10.5,
  traction: 0.62, eyeHeight: 1.15, grip: 1, camDist: 1, engine: { cylinders: 4, idle: 800, redline: 6500, gears: 6, tone: 'piston' }, ...o,
});

// Top speeds / acceleration are typical real figures for each class (not limited to an arcade 120 km/h).
export const CARS: CarSpec[] = [
  {
    id: 'concept', name: '概念超跑', note: 'V8 · 330 km/h · 写实模型', kind: 'car', file: 'concept/CarConcept.gltf', hero: true,
    length: 4.56, width: 1.98, wheelbase: 2.68, wheelRadius: 0.35, topSpeed: 330, accel: 9.2, brake: 13.5, traction: 0.95,
    eyeHeight: 1.02, grip: 1.28, camDist: 1.05, engine: { cylinders: 8, idle: 950, redline: 8600, gears: 7, tone: 'piston' },
  },
  kenney('sedan-sports', '运动轿跑', '直六 · 250 km/h', 'sedan-sports.glb', { topSpeed: 250, accel: 5.6, brake: 12, grip: 1.1, eyeHeight: 1.05, traction: 0.7, engine: { cylinders: 6, idle: 850, redline: 7200, gears: 7, tone: 'piston' } }),
  kenney('hatchback-sports', '钢炮', '直四涡轮 · 235 km/h', 'hatchback-sports.glb', { length: 4.1, width: 1.72, wheelbase: 2.5, topSpeed: 235, accel: 5.0, brake: 11.5, grip: 1.06, eyeHeight: 1.1, engine: { cylinders: 4, idle: 850, redline: 6800, gears: 6, tone: 'piston' } }),
  kenney('sedan', '家用轿车', '直四 · 190 km/h', 'sedan.glb', {}),
  kenney('suv', 'SUV', 'V6 · 200 km/h', 'suv.glb', { length: 4.6, width: 1.85, wheelbase: 2.7, wheelRadius: 0.36, topSpeed: 200, accel: 3.8, brake: 10, grip: 0.93, eyeHeight: 1.4, engine: { cylinders: 6, idle: 750, redline: 6200, gears: 8, tone: 'piston' } }),
  kenney('van', '厢式车', '直四柴油 · 160 km/h', 'van.glb', { length: 4.7, width: 1.85, wheelbase: 2.8, wheelRadius: 0.35, topSpeed: 160, accel: 2.6, brake: 9.5, grip: 0.88, eyeHeight: 1.5, engine: { cylinders: 4, idle: 750, redline: 4600, gears: 6, tone: 'piston' } }),
  kenney('taxi', '出租车', '直四 · 180 km/h', 'taxi.glb', { topSpeed: 180, accel: 3.0, grip: 0.98 }),
];

const air = (id: string, kind: VehicleKind, name: string, note: string, o: Partial<CarSpec>): CarSpec => ({
  id, name, note, kind, file: '', length: 8, width: 11, wheelbase: 2.5, wheelRadius: 0.3, topSpeed: 300, accel: 4, brake: 4, traction: 1,
  eyeHeight: 1.3, grip: 1, camDist: 2.4, engine: { cylinders: 6, idle: 1200, redline: 2700, gears: 1, tone: 'prop' }, ...o,
});
export const AIRCRAFT: CarSpec[] = [
  air('plane', 'plane', '螺旋桨飞机', '巡航 220 · 最高 300 km/h', { topSpeed: 300 }),
  air('heli', 'heli', '直升机', '可悬停 · 最高 240 km/h', { topSpeed: 240, length: 11, width: 10, camDist: 2.6, engine: { cylinders: 2, idle: 380, redline: 420, gears: 1, tone: 'heli' } }),
];
export const VEHICLES: CarSpec[] = [...CARS, ...AIRCRAFT];

export const BODY_COLORS = ['#d7263d', '#f2f2f2', '#16161a', '#1f6feb', '#f5b700', '#1b998b', '#8d99ae', '#ff7f11'];

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

/** Draco + KTX2 support for the compressed hero model. Call once with the game's renderer. */
export function initCarLoaders(renderer: THREE.WebGLRenderer): void {
  const base = import.meta.env.BASE_URL;
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath(base + 'draco/'));
  loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(base + 'basis/').detectSupport(renderer));
}

const WHEEL_KENNEY = /^wheel-(front|back)-(left|right)$/; // "wheel-back" alone is the SUV's spare: it must not spin
const WHEEL_HERO = /^Wheel(Front|Rear)(L|R)$/;

export class CarVisual {
  readonly root = new THREE.Group();      // positioned / oriented by the game
  private model: THREE.Group | null = null;
  private wheels: { node: THREE.Object3D; front: boolean; steerSign: number }[] = [];
  private paintTexture: THREE.CanvasTexture | null = null;
  private source: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  private paintMask: Uint8Array | null = null;
  private paintRef = new THREE.Color();
  private heroPaint: { mat: THREE.MeshStandardMaterial; k: number }[] = [];
  private color = new THREE.Color(BODY_COLORS[0]);
  readonly headlights: THREE.SpotLight[] = [];
  private lamps: THREE.Mesh[] = [];
  private lampMat = new THREE.MeshBasicMaterial({ color: 0x050505 });
  private loadId = 0;

  constructor() {
    // blob shadow
    const g = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    const shadow = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.scale.set(1.25, 1, 2.5); shadow.position.y = 0.04; shadow.renderOrder = 2;
    this.root.add(shadow);
    for (const sx of [-0.55, 0.55]) {
      const l = new THREE.SpotLight(0xfff2d6, 0, 90, 0.5, 0.6, 1.2);
      l.position.set(sx, 0.7, -1.9); l.target.position.set(sx * 1.2, 0.1, -30);
      this.root.add(l, l.target); this.headlights.push(l);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), this.lampMat);
      lamp.position.set(sx, 0.62, -2.18); this.root.add(lamp); this.lamps.push(lamp);
    }
  }

  /** Recompile the car's materials (needed after renderer-wide changes such as enabling shadows). */
  refreshMaterials(): void { this.model?.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mm.needsUpdate = true; }); }

  setHeadlights(on: boolean): void {
    for (const l of this.headlights) l.intensity = on ? 900 : 0;
    this.lampMat.color.set(on ? 0x8a8370 : 0x050505);
  }

  async load(spec: CarSpec): Promise<void> {
    const id = ++this.loadId;
    let p = cache.get(spec.file);
    if (!p) { p = loader.loadAsync(import.meta.env.BASE_URL + 'cars/' + spec.file).then((g) => g.scene); cache.set(spec.file, p); }
    const src = await p;
    if (id !== this.loadId) return; // a newer selection won
    const model = src.clone(true);
    if (this.model) this.root.remove(this.model);
    this.model = model;
    this.wheels = []; this.heroPaint = []; this.paintTexture = null; this.paintMask = null; this.source = null;
    if (spec.hero) this.setupHero(model, spec); else this.setupKenney(model, spec);
    // the car takes building shadows like everything else in the street
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = true; });
    this.root.add(model);
    // lamps sit at the nose of whichever body is loaded
    const nose = spec.length / 2;
    this.lamps.forEach((l, i) => { l.position.set((i ? 1 : -1) * spec.width * 0.33, spec.hero ? 0.66 : 0.62, -nose + (spec.hero ? 0.12 : 0.05)); l.visible = !spec.hero; });
    this.headlights.forEach((l, i) => { l.position.set((i ? 1 : -1) * spec.width * 0.33, 0.7, -nose + 0.3); });
    this.setColor('#' + this.color.getHexString());
  }

  // ------------------------------------------------------------------ Kenney
  private setupKenney(model: THREE.Group, spec: CarSpec): void {
    // Kenney cars face +Z and are ~2.54 units long: scale to real length, face -Z (forward)
    const box = new THREE.Box3().setFromObject(model);
    const scale = spec.length / (box.max.z - box.min.z);
    model.scale.setScalar(scale);
    model.rotation.y = Math.PI;
    model.position.y = -box.min.y * scale;
    let bodyMesh: THREE.Mesh | null = null;
    model.traverse((o) => {
      if (WHEEL_KENNEY.test(o.name)) this.wheels.push({ node: o, front: o.name.includes('front'), steerSign: -1 });
      const m = o as THREE.Mesh;
      if (m.isMesh && (o.name === 'body' || o.parent?.name === 'body') && !bodyMesh) bodyMesh = m;
    });
    if (bodyMesh) this.preparePaint(model, bodyMesh);
  }

  // -------------------------------------------------------------------- hero
  private setupHero(model: THREE.Group, spec: CarSpec): void {
    model.updateMatrixWorld(true);
    // 1. find the wheels and work out which way the car faces from them
    const groups: { node: THREE.Object3D; front: boolean; c: THREE.Vector3 }[] = [];
    model.traverse((o) => { const m = WHEEL_HERO.exec(o.name); if (m) groups.push({ node: o, front: m[1] === 'Front', c: new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3()) }); });
    const mean = (f: boolean) => groups.filter((g) => g.front === f).reduce((a, g) => a.add(g.c), new THREE.Vector3()).multiplyScalar(1 / Math.max(1, groups.filter((g) => g.front === f).length));
    const fwd = mean(true).sub(mean(false)); fwd.y = 0;
    const yaw = fwd.lengthSq() > 1e-6 ? Math.atan2(-fwd.x, -fwd.z) : 0; // rotation that turns `fwd` onto -Z
    // 2. give every wheel a pivot at its own centre so it can spin and steer
    for (const g of groups) {
      const parent = g.node.parent!;
      const pivot = new THREE.Group(); pivot.name = g.node.name + 'Pivot';
      parent.add(pivot);
      pivot.position.copy(parent.worldToLocal(g.c.clone()));
      pivot.updateMatrixWorld(true);
      // brake calipers stay with the body; everything else turns with the wheel
      for (const child of [...g.node.children]) if (/BrakePad/.test(child.name)) parent.attach(child);
      pivot.attach(g.node);
      this.wheels.push({ node: pivot, front: g.front, steerSign: -1 });
    }
    // 3. orient, centre and seat on the ground (the asset is authored in metres)
    const holder = model;
    holder.rotation.y = -yaw;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder), c = box.getCenter(new THREE.Vector3());
    const k = spec.length / Math.max(0.1, box.max.z - box.min.z);
    holder.scale.multiplyScalar(k);
    holder.position.set(-c.x * k, -box.min.y * k, -c.z * k);
    // 4. paint: the asset names its body paints "Paint 1 …" (main) and "Paint 2 …" (accent)
    const seen = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      const hit = /^Paint ([12])/.exec(mat.name ?? '');
      if (!hit) return;
      let own = seen.get(mat) as THREE.MeshStandardMaterial | undefined;
      if (!own) { own = mat.clone(); seen.set(mat, own); this.heroPaint.push({ mat: own, k: hit[1] === '1' ? 1 : 0.28 }); }
      m.material = own;
    });
  }

  /** Find which palette entry is the body paint (largest saturated area on the body mesh). */
  private preparePaint(model: THREE.Object3D, body: THREE.Mesh): void {
    const mat = body.material as THREE.MeshStandardMaterial;
    const img = mat.map?.image as HTMLImageElement | ImageBitmap | undefined;
    if (!img) return;
    const w = (img as any).width, h = (img as any).height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img as any, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    this.source = { data: new Uint8ClampedArray(data), w, h };
    const geo = body.geometry, uv = geo.getAttribute('uv'), pos = geo.getAttribute('position'), idx = geo.getIndex();
    const area = new Map<number, number>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const tris = (idx ? idx.count : pos.count) / 3;
    const tf = mat.map!;
    const sample = (i: number): number => {
      let u = uv.getX(i) * tf.repeat.x + tf.offset.x, v = uv.getY(i) * tf.repeat.y + tf.offset.y;
      u -= Math.floor(u); v -= Math.floor(v);
      const px = Math.min(w - 1, Math.floor(u * w)), py = Math.min(h - 1, Math.floor((tf.flipY ? 1 - v : v) * h));
      return py * w + px;
    };
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      const ar = b.sub(a).cross(c.sub(a)).length();
      const p = sample(i0);
      const r = data[p * 4], g = data[p * 4 + 1], bl = data[p * 4 + 2];
      const mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      if (mx - mn < 40) continue; // greys: glass, tyres, trim
      const key = (r << 16) | (g << 8) | bl;
      area.set(key, (area.get(key) ?? 0) + ar);
    }
    let best = -1, bestA = 0;
    for (const [k, v] of area) if (v > bestA) { bestA = v; best = k; }
    if (best < 0) return;
    this.paintRef.setRGB(((best >> 16) & 255) / 255, ((best >> 8) & 255) / 255, (best & 255) / 255, THREE.SRGBColorSpace);
    const pr = (best >> 16) & 255, pg = (best >> 8) & 255, pb = best & 255;
    // paint = palette pixels with a hue close to the body colour (covers its shaded variants)
    const mask = new Uint8Array(w * h);
    const hueOf = (r: number, g: number, bb: number) => { const c2 = new THREE.Color(r / 255, g / 255, bb / 255); const o = { h: 0, s: 0, l: 0 }; c2.getHSL(o); return o; };
    const ref = hueOf(pr, pg, pb);
    for (let i = 0; i < w * h; i++) {
      const o = hueOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      let dh = Math.abs(o.h - ref.h); dh = Math.min(dh, 1 - dh);
      if (o.s > 0.25 && dh < 0.045) mask[i] = 1;
    }
    this.paintMask = mask;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = tf.flipY;
    tex.wrapS = tf.wrapS; tex.wrapT = tf.wrapT; tex.repeat.copy(tf.repeat); tex.offset.copy(tf.offset);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
    this.paintTexture = tex;
    const painted = mat.clone(); painted.map = tex; painted.roughness = 0.35; painted.metalness = 0.1;
    model.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = painted; });
  }

  setColor(hex: string): void {
    this.color.set(hex);
    for (const p of this.heroPaint) { p.mat.color.copy(this.color).multiplyScalar(p.k); p.mat.needsUpdate = true; }
    if (!this.paintTexture || !this.source || !this.paintMask) return;
    const { data, w, h } = this.source;
    const cv = this.paintTexture.image as HTMLCanvasElement;
    const ctx = cv.getContext('2d')!;
    const out = ctx.createImageData(w, h);
    const t = { h: 0, s: 0, l: 0 }; this.color.getHSL(t, THREE.SRGBColorSpace);
    const r0 = { h: 0, s: 0, l: 0 }; new THREE.Color().copy(this.paintRef).getHSL(r0, THREE.SRGBColorSpace);
    const tmp = new THREE.Color(), o = { h: 0, s: 0, l: 0 };
    for (let i = 0; i < w * h; i++) {
      let r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      if (this.paintMask[i]) {
        tmp.setRGB(r / 255, g / 255, b / 255).getHSL(o);
        // keep the palette's relative shading, swap hue / saturation / base lightness
        const l = Math.max(0, Math.min(1, t.l + (o.l - r0.l) * 0.8));
        tmp.setHSL(t.h, t.s, l);
        r = tmp.r * 255; g = tmp.g * 255; b = tmp.b * 255;
      }
      out.data[i * 4] = r; out.data[i * 4 + 1] = g; out.data[i * 4 + 2] = b; out.data[i * 4 + 3] = data[i * 4 + 3];
    }
    ctx.putImageData(out, 0, 0);
    this.paintTexture.needsUpdate = true;
  }

  /** Per-frame wheel animation: only the four road wheels spin; the front pair also steers. */
  animate(spin: number, steer: number): void {
    for (const w of this.wheels) {
      w.node.rotation.set(0, 0, 0);
      if (w.front) w.node.rotateY(w.steerSign * steer);
      w.node.rotateX(spin);
    }
  }
}

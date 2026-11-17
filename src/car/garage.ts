// Garage data + car visuals.
//  - The car: Khronos "Car Concept" (CC-BY 4.0, see public/cars/concept/LICENSE.md):
//    ~213k triangles, PBR clear-coat paint, full interior.
// The body colour picker recolours the paint at runtime.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

export type VehicleKind = 'car' | 'plane' | 'heli';
export interface EngineSpec { cylinders: number; idle: number; redline: number; gears: number; tone: 'piston' | 'prop' | 'jet' | 'heli' }

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

// Top speeds / acceleration are typical real figures for each class (not limited to an arcade 120 km/h).
export const CARS: CarSpec[] = [
  {
    id: 'concept', name: '概念超跑', note: 'V8 · 330 km/h · 写实模型', kind: 'car', file: 'concept/CarConcept.gltf', hero: true,
    length: 4.56, width: 1.98, wheelbase: 2.68, wheelRadius: 0.35, topSpeed: 330, accel: 9.2, brake: 13.5, traction: 0.95,
    eyeHeight: 1.02, grip: 1.28, camDist: 1.05, engine: { cylinders: 8, idle: 950, redline: 8600, gears: 7, tone: 'piston' },
  },
];

const air = (id: string, kind: VehicleKind, name: string, note: string, o: Partial<CarSpec>): CarSpec => ({
  id, name, note, kind, file: '', length: 8, width: 11, wheelbase: 2.5, wheelRadius: 0.3, topSpeed: 300, accel: 4, brake: 4, traction: 1,
  eyeHeight: 1.3, grip: 1, camDist: 2.4, engine: { cylinders: 6, idle: 1200, redline: 2700, gears: 1, tone: 'prop' }, ...o,
});
export const AIRCRAFT: CarSpec[] = [
  air('plane', 'plane', '私人飞机', '双涡扇 · 巡航 430 · 最高 830 km/h', { topSpeed: 830, length: 16, width: 16, camDist: 3.1, engine: { cylinders: 0, idle: 28, redline: 98, gears: 1, tone: 'jet' } }),
  air('heli', 'heli', '直升机', '单发 · 可悬停 · 最高 240 km/h', { topSpeed: 240, length: 12.7, width: 10.7, camDist: 2.6, engine: { cylinders: 2, idle: 380, redline: 420, gears: 1, tone: 'heli' } }),
];
export const VEHICLES: CarSpec[] = [...CARS, ...AIRCRAFT];

export const BODY_COLORS = ['#d7263d', '#f2f2f2', '#16161a', '#1f6feb', '#f5b700', '#1b998b', '#8d99ae', '#ff7f11'];

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

/** Draco + KTX2 support for the compressed hero model. Call once with the game's renderer. */
/**
 * Reflection environment for the car. Its paint is metallic (metalness 1): a metal has no
 * diffuse colour, everything it shows is reflection - without an environment the car turns
 * pitch black as soon as it is out of direct sunlight. A simple sky dome (zenith blue, bright
 * horizon, grey ground) prefiltered with PMREM is enough. Car materials only: the city keeps
 * its own lighting.
 */
let carEnv: THREE.Texture | null = null;
export const CAR_ENV_INTENSITY = 0.1;  // matches the scene's sky light at exposure 10
function buildCarEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const col = new Float32Array(geo.getAttribute('position').count * 3);
  const zenith = new THREE.Color(0.32, 0.5, 0.85), horizon = new THREE.Color(0.95, 0.95, 0.93), ground = new THREE.Color(0.22, 0.21, 0.2), c = new THREE.Color();
  for (let i = 0; i < col.length / 3; i++) {
    const y = geo.getAttribute('position').getY(i) / 10;
    if (y >= 0) c.copy(horizon).lerp(zenith, Math.pow(y, 0.6)); else c.copy(horizon).lerp(ground, Math.min(1, -y * 6));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.02).texture;
  pm.dispose(); geo.dispose();
  return tex;
}

export function initCarLoaders(renderer: THREE.WebGLRenderer): void {
  carEnv = buildCarEnvironment(renderer);
  const base = import.meta.env.BASE_URL;
  loader.setDRACOLoader(new DRACOLoader().setDecoderPath(base + 'draco/'));
  loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(base + 'basis/').detectSupport(renderer));
}

const WHEEL_HERO = /^Wheel(Front|Rear)(L|R)$/;

export class CarVisual {
  readonly root = new THREE.Group();      // positioned / oriented by the game
  private model: THREE.Group | null = null;
  // steer / spin axes are stored in each wheel pivot's own frame: the hero asset is Z-up
  // inside, so 'up' and 'axle' are not the pivot's Y and X
  private wheels: { node: THREE.Object3D; front: boolean; steerAxis: THREE.Vector3; spinAxis: THREE.Vector3 }[] = [];
  private qa = new THREE.Quaternion(); private qb = new THREE.Quaternion();
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
    this.wheels = []; this.heroPaint = [];
    this.setupHero(model, spec);
    // the car takes building shadows like everything else in the street
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.receiveShadow = true;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const sm = mat as THREE.MeshStandardMaterial;
        if (carEnv && 'envMap' in sm) { sm.envMap = carEnv; sm.envMapIntensity = CAR_ENV_INTENSITY; sm.needsUpdate = true; }
      }
    });
    this.root.add(model);
    // lamps sit at the nose of whichever body is loaded
    const nose = spec.length / 2;
    this.lamps.forEach((l, i) => { l.position.set((i ? 1 : -1) * spec.width * 0.33, spec.hero ? 0.66 : 0.62, -nose + (spec.hero ? 0.12 : 0.05)); l.visible = !spec.hero; });
    this.headlights.forEach((l, i) => { l.position.set((i ? 1 : -1) * spec.width * 0.33, 0.7, -nose + 0.3); });
    this.setColor('#' + this.color.getHexString());
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
      this.wheels.push({ node: pivot, front: g.front, steerAxis: new THREE.Vector3(), spinAxis: new THREE.Vector3() });
    }
    // 3. orient, centre and seat on the ground (the asset is authored in metres)
    const holder = model;
    holder.rotation.y = -yaw;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder), c = box.getCenter(new THREE.Vector3());
    const k = spec.length / Math.max(0.1, box.max.z - box.min.z);
    holder.scale.multiplyScalar(k);
    holder.position.set(-c.x * k, -box.min.y * k, -c.z * k);
    // express the car's up (+Y) and axle (+X) directions in every wheel pivot's local frame
    holder.updateMatrixWorld(true);
    const toPivot = new THREE.Matrix4(), rel = new THREE.Quaternion();
    for (const w of this.wheels) {
      // the model is not attached to the car root yet, so its world matrices are relative to the car
      toPivot.copy(w.node.matrixWorld);
      toPivot.decompose(new THREE.Vector3(), rel, new THREE.Vector3());
      rel.invert();
      w.steerAxis.set(0, 1, 0).applyQuaternion(rel).normalize();
      w.spinAxis.set(1, 0, 0).applyQuaternion(rel).normalize();
    }
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

  setColor(hex: string): void {
    this.color.set(hex);
    for (const p of this.heroPaint) { p.mat.color.copy(this.color).multiplyScalar(p.k); p.mat.needsUpdate = true; }
  }

  /** Per-frame wheel animation: only the four road wheels spin; the front pair also steers. */
  animate(spin: number, steer: number): void {
    // car faces -Z: steering right (steer > 0) turns the wheel about +Y by a negative angle,
    // rolling forward turns it about +X by a negative angle. Steer first, then spin about the
    // steered axle.
    for (const w of this.wheels) {
      this.qa.setFromAxisAngle(w.steerAxis, w.front ? -steer : 0);
      this.qb.setFromAxisAngle(w.spinAxis, -spin);
      w.node.quaternion.copy(this.qa).multiply(this.qb);
    }
  }
}

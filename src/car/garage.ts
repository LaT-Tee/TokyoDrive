// Garage data + car visuals. Models: Kenney "Car Kit" (CC0), see
// public/cars/LICENSE-kenney-car-kit.txt. The body colour picker recolours
// the paint entries of the model's palette texture at runtime.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CarSpec {
  id: string; name: string; file: string;
  length: number; width: number; wheelbase: number; wheelRadius: number;
  topSpeed: number; // km/h limiter
  accel: number; brake: number; // m/s^2
  eyeHeight: number; // hood camera height
  grip: number;      // tyre grip multiplier
}

export const CARS: CarSpec[] = [
  { id: 'sedan', name: 'セダン', file: 'sedan.glb', length: 4.45, width: 1.75, wheelbase: 2.6, wheelRadius: 0.33, topSpeed: 120, accel: 4.2, brake: 11, eyeHeight: 1.15, grip: 1.0 },
  { id: 'sedan-sports', name: 'スポーツセダン', file: 'sedan-sports.glb', length: 4.45, width: 1.75, wheelbase: 2.6, wheelRadius: 0.33, topSpeed: 160, accel: 6.0, brake: 13, eyeHeight: 1.05, grip: 1.1 },
  { id: 'hatchback-sports', name: 'ホットハッチ', file: 'hatchback-sports.glb', length: 4.1, width: 1.72, wheelbase: 2.5, wheelRadius: 0.33, topSpeed: 140, accel: 5.2, brake: 12, eyeHeight: 1.1, grip: 1.06 },
  { id: 'suv', name: 'SUV', file: 'suv.glb', length: 4.6, width: 1.85, wheelbase: 2.7, wheelRadius: 0.36, topSpeed: 120, accel: 3.8, brake: 10, eyeHeight: 1.4, grip: 0.93 },
  { id: 'van', name: 'バン', file: 'van.glb', length: 4.7, width: 1.85, wheelbase: 2.8, wheelRadius: 0.35, topSpeed: 110, accel: 3.2, brake: 9.5, eyeHeight: 1.5, grip: 0.88 },
  { id: 'taxi', name: 'タクシー', file: 'taxi.glb', length: 4.45, width: 1.75, wheelbase: 2.6, wheelRadius: 0.33, topSpeed: 120, accel: 4.0, brake: 11, eyeHeight: 1.15, grip: 0.98 },
];

export const BODY_COLORS = ['#d7263d', '#f2f2f2', '#16161a', '#1f6feb', '#f5b700', '#1b998b', '#8d99ae', '#ff7f11'];

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

export class CarVisual {
  readonly root = new THREE.Group();      // positioned / oriented by the game
  private model: THREE.Group | null = null;
  private wheels: { node: THREE.Object3D; front: boolean }[] = [];
  private paintTexture: THREE.CanvasTexture | null = null;
  private source: { data: Uint8ClampedArray; w: number; h: number } | null = null;
  private paintMask: Uint8Array | null = null;
  private paintRef = new THREE.Color();
  private color = new THREE.Color(BODY_COLORS[0]);
  readonly headlights: THREE.SpotLight[] = [];
  private lampMat = new THREE.MeshBasicMaterial({ color: 0x333333 });

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
      lamp.position.set(sx, 0.62, -2.18); this.root.add(lamp);
    }
  }

  setHeadlights(on: boolean): void {
    for (const l of this.headlights) l.intensity = on ? 900 : 0;
    this.lampMat.color.set(on ? 0xfff6dd : 0x333333);
  }

  async load(spec: CarSpec): Promise<void> {
    let p = cache.get(spec.file);
    if (!p) { p = loader.loadAsync(import.meta.env.BASE_URL + 'cars/' + spec.file).then((g) => g.scene); cache.set(spec.file, p); }
    const src = await p;
    const model = src.clone(true);
    if (this.model) this.root.remove(this.model);
    this.model = model;
    // Kenney cars face +Z and are ~2.54 units long: scale to real length, face -Z (forward)
    const box = new THREE.Box3().setFromObject(model);
    const scale = spec.length / (box.max.z - box.min.z);
    model.scale.setScalar(scale);
    model.rotation.y = Math.PI;
    model.position.y = -box.min.y * scale;
    this.wheels = [];
    let bodyMesh: THREE.Mesh | null = null;
    model.traverse((o) => {
      if (o.name.startsWith('wheel')) this.wheels.push({ node: o, front: o.name.includes('front') });
      const m = o as THREE.Mesh;
      if (m.isMesh && (o.name === 'body' || o.parent?.name === 'body') && !bodyMesh) bodyMesh = m;
    });
    this.root.add(model);
    if (bodyMesh) this.preparePaint(model, bodyMesh);
    this.setColor('#' + this.color.getHexString());
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

  /** Per-frame wheel animation. */
  animate(spin: number, steer: number): void {
    for (const w of this.wheels) {
      w.node.rotation.set(0, 0, 0);
      // model faces +Z before the 180 deg flip; steer about Y, spin about X
      if (w.front) w.node.rotateY(-steer);
      w.node.rotateX(spin);
    }
  }
}

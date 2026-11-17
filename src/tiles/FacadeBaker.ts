// Bakes Google's photogrammetry colours onto untextured PLATEAU buildings.
//
// Why not look it up on screen every frame: Google's scanned buildings never line up
// exactly with PLATEAU's (bulging walls, rounded edges, whole buildings shifted a few
// metres), so a per-pixel screen match depends on the viewpoint - patches appear,
// disappear and crawl while driving, and only what is visible right now gets coloured.
//
// Instead every wall (and roof) of a building is photographed once, in world space:
//  - triangles are grouped by building (_batchid) and plane;
//  - for each plane an orthographic camera faces it squarely and sees only a slab
//    from FRONT metres in front of the wall to BACK metres behind it. Whatever the
//    scan has inside that slab - the real facade, even if bulged or shifted - is
//    captured; trees and buildings outside it are cut away by the near / far planes;
//  - the shot goes into a per-building-group atlas, and every vertex gets an atlas UV.
// The result is fixed to the wall: it does not change with the view, covers whole
// walls including the parts not currently visible, and costs nothing per frame.
import * as THREE from 'three';
import type { GoogleFill } from './GoogleFill';

const ATLAS = 1024;          // px, per unit (one PLATEAU material, i.e. one tile's buildings)
const FRONT = 3.0;           // m captured in front of the wall (balconies, signs, bulging scans)
const BACK = 6.0;            // m captured behind it (recessed or shifted scans)
const PAD = 3;               // px around each rect (mip bleeding)
const BAKE_RADIUS = 260;     // m: units closer than this get baked
const MAX_UNITS = 28;        // baked atlases kept (GPU memory ~ 8 MB each)
const REBAKE_AFTER = 6000;   // ms: re-photograph once finer Google tiles have arrived

interface PlaneShot { cam: THREE.OrthographicCamera; rect: [number, number, number, number] }
interface Unit {
  mat: THREE.Material;
  meshes: Map<THREE.Mesh, THREE.Matrix4>;
  center: THREE.Vector3; radius: number;
  shots: PlaneShot[] | null;              // prepared camera + atlas rect per plane
  rt: THREE.WebGLRenderTarget | null;
  next: number;                           // next shot to render (baking in progress when < shots.length)
  bakedVersion: number; bakedAt: number; bakes: number;
  ownGeometry: THREE.BufferGeometry[];    // geometries we created (to dispose)
  failed: boolean;
}

/** Per-material uniforms read by the facade shader (TilesManager.applyFacade). */
export function facadeUniforms(mat: THREE.Material): { tdGAtlas: { value: THREE.Texture | null }; tdGBaked: { value: number } } {
  const u = mat.userData as any;
  u.tdGAtlas ??= { value: null };
  u.tdGBaked ??= { value: 0 };
  return { tdGAtlas: u.tdGAtlas, tdGBaked: u.tdGBaked };
}

export class FacadeBaker {
  private units = new Map<THREE.Material, Unit>();
  private byMesh = new Map<THREE.Mesh, Unit>();
  private lastSource: THREE.Scene | null = null;
  private preparing: Generator<void, boolean> | null = null;
  private preparingUnit: Unit | null = null;
  bakedPlanes = 0;

  constructor(private renderer: THREE.WebGLRenderer, private google: GoogleFill) {}

  /** A leaf PLATEAU building mesh without its own texture (world = its local-frame matrix). */
  add(mesh: THREE.Mesh, world: THREE.Matrix4): void {
    const mat = mesh.material as THREE.Material;
    let u = this.units.get(mat);
    if (!u) {
      u = { mat, meshes: new Map(), center: new THREE.Vector3(), radius: 0, shots: null, rt: null, next: 0, bakedVersion: -1, bakedAt: 0, bakes: 0, ownGeometry: [], failed: false };
      this.units.set(mat, u);
    }
    u.meshes.set(mesh, world.clone());
    this.byMesh.set(mesh, u);
    this.resetUnit(u); // geometry changed: start over
    const box = new THREE.Box3();
    for (const [m, w] of u.meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!.clone().applyMatrix4(w)); }
    box.getCenter(u.center); u.radius = box.getSize(new THREE.Vector3()).length() / 2;
  }

  remove(mesh: THREE.Mesh): void {
    const u = this.byMesh.get(mesh);
    if (!u) return;
    this.byMesh.delete(mesh); u.meshes.delete(mesh);
    if (!u.meshes.size) { this.resetUnit(u); this.units.delete(u.mat); }
  }

  /** Forget every bake (colour source switched off or changed). */
  reset(): void { for (const u of this.units.values()) this.resetUnit(u); }

  private resetUnit(u: Unit): void {
    if (this.preparingUnit === u) { this.preparing = null; this.preparingUnit = null; }
    facadeUniforms(u.mat).tdGBaked.value = 0;
    u.rt?.dispose(); u.rt = null; u.shots = null; u.next = 0; u.bakedVersion = -1; u.bakes = 0; u.failed = false;
    for (const g of u.ownGeometry) g.dispose();
    u.ownGeometry = [];
  }

  update(x: number, z: number, budgetMs: number): void {
    const src = this.google.source;
    if (src !== this.lastSource) { this.reset(); this.lastSource = src; }
    if (!src) return;
    const t0 = performance.now(), now = t0;
    const dist = (u: Unit) => Math.max(0, Math.hypot(u.center.x - x, u.center.z - z) - u.radius);
    // a bake in progress continues first
    let current: Unit | null = null;
    for (const u of this.units.values()) if (u.shots && u.next < u.shots.length) { current = u; break; }
    if (!current) {
      let best: Unit | null = null, bd = Infinity;
      for (const u of this.units.values()) {
        if (u.failed) continue;
        const d = dist(u);
        if (d > BAKE_RADIUS) continue;
        const fresh = u.bakedVersion < 0;
        const stale = !fresh && this.google.version !== u.bakedVersion && now - u.bakedAt > REBAKE_AFTER && u.bakes < 3 && d < BAKE_RADIUS * 0.6;
        if ((fresh || stale) && d < bd) { bd = d; best = u; }
      }
      if (!best) return;
      current = best;
      if (!current.shots) {
        // preparation is spread over frames
        if (!this.preparing || this.preparingUnit !== current) { this.preparing = this.prepare(current); this.preparingUnit = current; }
        let r: IteratorResult<void, boolean>;
        do { r = this.preparing.next(); } while (!r.done && performance.now() - t0 < budgetMs);
        if (!r.done) return;
        this.preparing = null; this.preparingUnit = null;
        if (!r.value) { current.failed = true; return; }
        this.evict(x, z, current);
      }
      current.next = 0;
    }
    this.renderShots(current, src, t0, budgetMs);
    if (current.next >= current.shots!.length) {
      const fu = facadeUniforms(current.mat);
      current.rt!.texture.needsUpdate = true;
      fu.tdGAtlas.value = current.rt!.texture; fu.tdGBaked.value = 1;
      current.bakedVersion = this.google.version; current.bakedAt = now; current.bakes++;
    }
  }

  /** Keep GPU memory bounded: drop the farthest baked atlases. */
  private evict(x: number, z: number, keep: Unit): void {
    const baked = [...this.units.values()].filter((u) => u.rt && u !== keep);
    if (baked.length < MAX_UNITS) return;
    baked.sort((a, b) => Math.hypot(b.center.x - x, b.center.z - z) - Math.hypot(a.center.x - x, a.center.z - z));
    for (const u of baked.slice(0, baked.length - MAX_UNITS + 1)) this.resetUnit(u);
  }

  /**
   * Group triangles per building and facing (8 wall directions + one roof group), set up one
   * orthographic camera per group, pack the atlas and write atlas UVs. A generator: it yields
   * regularly so the work is spread over frames instead of stalling one.
   */
  private *prepare(u: Unit): Generator<void, boolean> {
    interface Group { roof: boolean; dir: THREE.Vector3; tris: { mesh: THREE.Mesh; i: number }[] }
    const groups = new Map<string, Group>();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const worlds = new Map<THREE.Mesh, Float32Array>();
    let work = 0;
    for (const [mesh, world] of u.meshes) {
      // every vertex needs one atlas UV: split shared vertices
      if (mesh.geometry.index) { const g = mesh.geometry.toNonIndexed(); u.ownGeometry.push(g); mesh.geometry = g; yield; }
      const pos = mesh.geometry.getAttribute('position'), bid = mesh.geometry.getAttribute('_batchid');
      const wp = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) { a.fromBufferAttribute(pos, i).applyMatrix4(world); wp[i * 3] = a.x; wp[i * 3 + 1] = a.y; wp[i * 3 + 2] = a.z; if (++work % 4000 === 0) yield; }
      worlds.set(mesh, wp);
      for (let t = 0; t < pos.count / 3; t++) {
        if (++work % 3000 === 0) yield;
        a.fromArray(wp, t * 9); b.fromArray(wp, t * 9 + 3); c.fromArray(wp, t * 9 + 6);
        n.subVectors(b, a).cross(c.clone().sub(a));
        const len = n.length();
        if (len < 1e-4) continue;
        n.divideScalar(len);
        if (n.y < -0.5) continue;                                     // undersides are never seen
        const roof = n.y > 0.45;
        // walls: one group per building and 45-degree facing sector
        const sector = roof ? -1 : (Math.round(Math.atan2(n.x, n.z) / (Math.PI / 4)) + 8) % 8;
        const key = `${bid ? bid.getX(t * 3) : 0}|${sector}`;
        let g = groups.get(key);
        if (!g) {
          const dir = roof ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(Math.sin((sector * Math.PI) / 4), 0, Math.cos((sector * Math.PI) / 4));
          g = { roof, dir, tris: [] }; groups.set(key, g);
        }
        g.tris.push({ mesh, i: t });
      }
    }
    if (!groups.size) return false;
    // one orthographic camera per group, facing it squarely, framing exactly its triangles; the
    // slab runs from FRONT in front of its frontmost point to BACK behind its rearmost one
    const shots: { cam: THREE.OrthographicCamera; w: number; h: number; tris: { mesh: THREE.Mesh; i: number }[] }[] = [];
    const v = new THREE.Vector3(), centre = new THREE.Vector3();
    for (const g of groups.values()) {
      if (++work % 200 === 0) yield;
      centre.set(0, 0, 0); let k = 0, front = -Infinity, back = Infinity;
      for (const { mesh, i } of g.tris) {
        const wp = worlds.get(mesh)!;
        for (let j = 0; j < 3; j++) { v.fromArray(wp, i * 9 + j * 3); centre.add(v); k++; const d = v.dot(g.dir); front = Math.max(front, d); back = Math.min(back, d); }
      }
      centre.divideScalar(k);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1);
      cam.up.set(0, 1, 0);
      if (g.roof) cam.up.set(0, 0, -1);                              // roofs: photographed from above, north up
      cam.position.copy(centre).addScaledVector(g.dir, front - centre.dot(g.dir) + FRONT);
      cam.lookAt(cam.position.clone().sub(g.dir)); cam.updateMatrixWorld();
      cam.far = FRONT + (front - back) + BACK;
      const inv = cam.matrixWorldInverse;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const { mesh, i } of g.tris) {
        const wp = worlds.get(mesh)!;
        for (let j = 0; j < 3; j++) { v.fromArray(wp, i * 9 + j * 3).applyMatrix4(inv); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
      }
      if (x1 - x0 < 0.4 || y1 - y0 < 0.4) continue;                  // slivers: not worth a shot
      cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1;
      cam.updateProjectionMatrix();
      shots.push({ cam, w: x1 - x0, h: y1 - y0, tris: g.tris });
    }
    if (!shots.length) return false;
    // shelf-pack into the atlas, coarsening the texel size until everything fits
    shots.sort((p, q) => q.h - p.h);
    let texel = 0.1, rects: [number, number, number, number][] = [];
    for (let attempt = 0; attempt < 40; attempt++, texel *= 1.15) {
      rects = []; let x = 0, y = 0, rowH = 0, ok = true;
      for (const s of shots) {
        const w = Math.min(ATLAS - 2 * PAD, Math.max(2, Math.ceil(s.w / texel))), h = Math.min(ATLAS - 2 * PAD, Math.max(2, Math.ceil(s.h / texel)));
        if (x + w + 2 * PAD > ATLAS) { x = 0; y += rowH; rowH = 0; }
        if (y + h + 2 * PAD > ATLAS) { ok = false; break; }
        rects.push([x + PAD, y + PAD, w, h]); x += w + 2 * PAD; rowH = Math.max(rowH, h + 2 * PAD);
      }
      if (ok) break;
      if (attempt === 39) return false;
      yield;
    }
    // atlas UVs: project each vertex with its group's camera into that group's rect
    const uvs = new Map<THREE.Mesh, Float32Array>();
    for (const mesh of u.meshes.keys()) uvs.set(mesh, new Float32Array(mesh.geometry.getAttribute('position').count * 2).fill(-1));
    for (let k = 0; k < shots.length; k++) {
      const s = shots[k], [rx, ry, rw, rh] = rects[k];
      for (const { mesh, i } of s.tris) {
        if (++work % 3000 === 0) yield;
        const wp = worlds.get(mesh)!, uv = uvs.get(mesh)!;
        for (let j = 0; j < 3; j++) {
          v.fromArray(wp, i * 9 + j * 3).project(s.cam);
          uv[(i * 3 + j) * 2] = (rx + (v.x * 0.5 + 0.5) * rw) / ATLAS;
          uv[(i * 3 + j) * 2 + 1] = (ry + (v.y * 0.5 + 0.5) * rh) / ATLAS;
        }
      }
    }
    for (const [mesh, uv] of uvs) mesh.geometry.setAttribute('gUv', new THREE.BufferAttribute(uv, 2));
    u.shots = shots.map((s, k) => ({ cam: s.cam, rect: rects[k] }));
    u.rt = new THREE.WebGLRenderTarget(ATLAS, ATLAS, { depthBuffer: true, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    u.rt.texture.colorSpace = THREE.SRGBColorSpace;
    u.rt.texture.anisotropy = 4;
    return true;
  }

  private renderShots(u: Unit, src: THREE.Scene, t0: number, budgetMs: number): void {
    const r = this.renderer, rt = u.rt!;
    const prevTarget = r.getRenderTarget(), prevAuto = r.shadowMap.autoUpdate, prevAlpha = r.getClearAlpha();
    const prevColor = r.getClearColor(new THREE.Color()), prevAutoClear = r.autoClear;
    const ov = (src.userData as any).tdOverride as THREE.Material | undefined; // test hook
    if (ov) src.overrideMaterial = ov;
    r.shadowMap.autoUpdate = false; r.autoClear = false;
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    if (u.next === 0) { rt.scissorTest = false; rt.viewport.set(0, 0, ATLAS, ATLAS); r.setRenderTarget(rt); r.clear(true, true, false); }
    while (u.next < u.shots!.length && performance.now() - t0 < budgetMs) {
      const s = u.shots![u.next++];
      const [x, y, w, h] = s.rect;
      rt.viewport.set(x, y, w, h); rt.scissor.set(x, y, w, h); rt.scissorTest = true;
      r.setRenderTarget(rt);
      r.clear(false, true, false);                    // depth only: each shot starts fresh
      r.render(src, s.cam);
      this.bakedPlanes++;
    }
    rt.scissorTest = false; rt.viewport.set(0, 0, ATLAS, ATLAS);
    if (ov) src.overrideMaterial = null;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    r.shadowMap.autoUpdate = prevAuto; r.autoClear = prevAutoClear;
  }

  get stats(): { units: number; baked: number; planes: number } {
    let baked = 0; for (const u of this.units.values()) if (facadeUniforms(u.mat).tdGBaked.value) baked++;
    return { units: this.units.size, baked, planes: this.bakedPlanes };
  }
}

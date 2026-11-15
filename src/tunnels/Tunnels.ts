// Procedural tunnels (CLAUDE.md §5). PLATEAU has no tunnel interiors, so OSM
// ways tagged tunnel=yes get a tube swept under the terrain: road floor,
// walls, a ceiling wherever there is enough cover, ceiling light strips, and
// an open-cut ramp at each portal (the ground shader discards its fragments
// over the ramp, see groundUniforms.tdCuts).
import * as THREE from 'three';
import type { Roads, Way } from '../world/Roads';
import { groundUniforms, type Terrain } from '../world/Terrain';

const BUILD_RANGE = 2200;
const DROP_RANGE = 3200;
const DEPTH = 7.5;       // floor depth below the terrain per tunnel level
const MAX_GRADE = 0.08;
export const TUNNEL_H = 5.4;
const COVER = TUNNEL_H + 0.7; // deeper than this: closed tube with a ceiling
const STEP = 5;

interface Tube {
  way: Way; ys: Float64Array; hw: number; mesh: THREE.Mesh; lights: THREE.Mesh | null;
  // dense centreline for ramp cuts
  dx: Float64Array; dz: Float64Array; dy: Float64Array; depth: Float64Array;
}

export class Tunnels {
  readonly group = new THREE.Group();
  private tubes = new Map<number, Tube>();
  private nodeY = new Map<string, number>();
  private lastBuild = 0;
  private mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.5, 0.38), side: THREE.DoubleSide });

  constructor(private roads: Roads, private terrain: Terrain) { this.group.name = 'tunnels'; }

  get count(): number { return this.tubes.size; }

  update(x: number, z: number): void {
    if (!this.roads.enabled) return;
    for (const [id, t] of this.tubes) {
      const w = t.way;
      if (x < w.minX - DROP_RANGE || x > w.maxX + DROP_RANGE || z < w.minZ - DROP_RANGE || z > w.maxZ + DROP_RANGE || !this.roads.ways.has(id)) {
        this.group.remove(t.mesh); t.mesh.geometry.dispose();
        if (t.lights) { this.group.remove(t.lights); t.lights.geometry.dispose(); }
        this.tubes.delete(id);
      }
    }
    this.updateCuts(x, z);
    const now = performance.now();
    if (now - this.lastBuild < 600) return;
    this.lastBuild = now;
    const batch: Way[] = [];
    for (const w of this.roads.ways.values()) {
      if (!w.tunnel || w.bridge || w.cls > 9 || this.tubes.has(w.id)) continue;
      if (x < w.minX - BUILD_RANGE || x > w.maxX + BUILD_RANGE || z < w.minZ - BUILD_RANGE || z > w.maxZ + BUILD_RANGE) continue;
      let ready = true;
      for (let k = 0; k < w.n; k++) if (!this.terrain.isReady(w.xs[k], w.zs[k])) { ready = false; break; }
      if (ready) batch.push(w);
      if (batch.length >= 12) break;
    }
    if (!batch.length) return;
    const heights = this.solve(batch);
    for (const w of batch) this.build(w, heights.get(w.id)!);
  }

  /** Floor heights: ground level where the tunnel meets surface roads, DEPTH below ground inside. */
  private solve(batch: Way[]): Map<number, Float64Array> {
    const tun: Way[] = [], keys = new Set<string>();
    for (const w of this.roads.ways.values()) if (w.tunnel && !w.bridge && w.cls <= 9) { tun.push(w); for (const k of w.keys) keys.add(k); }
    const anchors = new Set<string>();
    for (const w of this.roads.ways.values()) {
      if (w.tunnel) continue;
      for (const k of [w.keys[0], w.keys[w.n - 1]]) if (keys.has(k)) anchors.add(k);
    }
    const lower = new Map<string, number>(), upper = new Map<string, number>(), desired = new Map<string, number>();
    for (const w of tun) for (let k = 0; k < w.n; k++) {
      const key = w.keys[k];
      if (!this.terrain.isReady(w.xs[k], w.zs[k])) continue;
      const g = this.terrain.heightAt(w.xs[k], w.zs[k]);
      const fixed = this.nodeY.get(key);
      if (fixed !== undefined) { lower.set(key, fixed); upper.set(key, fixed); desired.set(key, fixed); }
      else if (anchors.has(key)) { lower.set(key, g); upper.set(key, g); desired.set(key, g); }
      else desired.set(key, Math.min(desired.get(key) ?? Infinity, g - DEPTH * Math.max(1, Math.abs(w.layer))));
    }
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (const w of tun) for (let dir = 0; dir < 2; dir++) for (let s = 1; s < w.n; s++) {
        const a = dir ? w.n - s : s - 1, b = dir ? w.n - s - 1 : s;
        const d = Math.hypot(w.xs[a] - w.xs[b], w.zs[a] - w.zs[b]) * MAX_GRADE;
        const la = lower.get(w.keys[a]), ua = upper.get(w.keys[a]);
        if (la !== undefined && la - d > (lower.get(w.keys[b]) ?? -Infinity) + 1e-3) { lower.set(w.keys[b], la - d); changed = true; }
        if (ua !== undefined && ua + d < (upper.get(w.keys[b]) ?? Infinity) - 1e-3) { upper.set(w.keys[b], ua + d); changed = true; }
      }
      if (!changed) break;
    }
    const out = new Map<number, Float64Array>();
    for (const w of batch) {
      const ys = new Float64Array(w.n);
      for (let k = 0; k < w.n; k++) {
        const key = w.keys[k];
        const want = desired.get(key) ?? this.terrain.heightAt(w.xs[k], w.zs[k]) - DEPTH;
        ys[k] = Math.min(Math.max(want, lower.get(key) ?? -Infinity), upper.get(key) ?? Infinity);
      }
      for (let it = 0; it < 3; it++) for (let k = 1; k < w.n - 1; k++) if (!anchors.has(w.keys[k]) && !this.nodeY.has(w.keys[k])) ys[k] = (ys[k - 1] + 2 * ys[k] + ys[k + 1]) / 4;
      if (this.nodeY.size > 200000) this.nodeY.clear();
      for (let k = 0; k < w.n; k++) this.nodeY.set(w.keys[k], ys[k]);
      out.set(w.id, ys);
    }
    return out;
  }

  private build(w: Way, ys: Float64Array): void {
    const hw = w.width / 2 + 0.6;
    // dense centreline
    const X: number[] = [], Z: number[] = [], Y: number[] = [], S: number[] = [];
    let s = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const len = Math.hypot(w.xs[k + 1] - w.xs[k], w.zs[k + 1] - w.zs[k]);
      if (len < 0.05) continue;
      const parts = Math.max(1, Math.ceil(len / STEP));
      for (let i = 0; i < parts; i++) { const t = i / parts; X.push(w.xs[k] + (w.xs[k + 1] - w.xs[k]) * t); Z.push(w.zs[k] + (w.zs[k + 1] - w.zs[k]) * t); Y.push(ys[k] + (ys[k + 1] - ys[k]) * t); S.push(s + len * t); }
      s += len;
    }
    X.push(w.xs[w.n - 1]); Z.push(w.zs[w.n - 1]); Y.push(ys[w.n - 1]); S.push(s);
    const n = X.length;
    if (n < 2) return;
    const depth = new Float64Array(n);
    const ox = X[0], oz = Z[0];
    const L: number[][] = [], R: number[][] = [];
    for (let i = 0; i < n; i++) {
      const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1);
      let dx = X[q] - X[p], dz = Z[q] - Z[p]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const rx = -dz, rz = dx;
      L.push([X[i] - rx * hw - ox, Y[i], Z[i] - rz * hw - oz]); R.push([X[i] + rx * hw - ox, Y[i], Z[i] + rz * hw - oz]);
      depth[i] = this.terrain.heightAt(X[i], Z[i]) - Y[i];
    }
    const pos: number[] = [], col: number[] = [], lpos: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], r: number, g: number, bl: number) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); for (let i = 0; i < 6; i++) col.push(r, g, bl); };
    const up = (p: number[], by: number) => [p[0], p[1] + by, p[2]];
    const mid = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    let nextLight = 12;
    for (let i = 0; i < n - 1; i++) {
      const l0 = L[i], l1 = L[i + 1], r0 = R[i], r1 = R[i + 1];
      const d0 = Math.max(0, depth[i]), d1 = Math.max(0, depth[i + 1]);
      if (d0 < 0.15 && d1 < 0.15) continue; // at ground level the normal road layer takes over
      // wall height follows the cut depth on the ramp, full height once covered
      const h0 = Math.min(TUNNEL_H, d0 + 0.4), h1 = Math.min(TUNNEL_H, d1 + 0.4);
      quad(l0, r0, r1, l1, 0.006, 0.0062, 0.007);                         // road floor
      quad(up(l0, h0), l0, l1, up(l1, h1), 0.02, 0.02, 0.019);          // left wall
      quad(r0, up(r0, h0), up(r1, h1), r1, 0.02, 0.02, 0.019);          // right wall
      // painted lines (pre-shaded: the tube is unlit)
      for (const t of [0.06, 0.94]) quad(up(mid(l0, r0, t - 0.008), 0.02), up(mid(l0, r0, t + 0.008), 0.02), up(mid(l1, r1, t + 0.008), 0.02), up(mid(l1, r1, t - 0.008), 0.02), 0.07, 0.07, 0.066);
      if (!w.oneway || w.width > 7) { if (Math.floor(S[i] / 7.5) % 2 === 0) quad(up(mid(l0, r0, 0.492), 0.02), up(mid(l0, r0, 0.508), 0.02), up(mid(l1, r1, 0.508), 0.02), up(mid(l1, r1, 0.492), 0.02), 0.07, 0.07, 0.066); }
      if (d0 > COVER && d1 > COVER) {
        quad(up(l0, TUNNEL_H), up(l1, TUNNEL_H), up(r1, TUNNEL_H), up(r0, TUNNEL_H), 0.011, 0.011, 0.011); // ceiling
        if (S[i] >= nextLight) {
          nextLight = S[i] + 25;
          for (const t of [0.3, 0.7]) {
            const a = up(mid(l0, r0, t - 0.03), TUNNEL_H - 0.06), b = up(mid(l0, r0, t + 0.03), TUNNEL_H - 0.06), c = up(mid(l1, r1, t + 0.03), TUNNEL_H - 0.06), d = up(mid(l1, r1, t - 0.03), TUNNEL_H - 0.06);
            lpos.push(...a, ...b, ...c, ...a, ...c, ...d);
          }
        }
      } else if (d0 > COVER !== d1 > COVER) {
        // portal face: closes the gap between the tube mouth and the ground above it
        const a = d0 > COVER ? [l0, r0] : [l1, r1];
        quad(up(a[0], TUNNEL_H), up(a[0], TUNNEL_H + 1.4), up(a[1], TUNNEL_H + 1.4), up(a[1], TUNNEL_H), 0.024, 0.024, 0.023);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.position.set(ox, 0, oz); mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.name = 'tunnel ' + w.id;
    this.group.add(mesh);
    let lights: THREE.Mesh | null = null;
    if (lpos.length) {
      const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lpos, 3));
      lights = new THREE.Mesh(lg, this.lightMat);
      lights.position.copy(mesh.position); lights.matrixAutoUpdate = false; lights.updateMatrix();
      this.group.add(lights);
    }
    this.tubes.set(w.id, { way: w, ys, hw, mesh, lights, dx: Float64Array.from(X), dz: Float64Array.from(Z), dy: Float64Array.from(Y), depth });
  }

  /** Tunnel floor under (x, z) for a vehicle at height refY, or NaN when not in a tunnel corridor at that level. */
  floorAt(x: number, z: number, refY: number): number {
    let best = NaN;
    for (const t of this.tubes.values()) {
      const w = t.way, m = t.hw;
      if (x < w.minX - m || x > w.maxX + m || z < w.minZ - m || z > w.maxZ + m) continue;
      for (let k = 0; k < w.n - 1; k++) {
        const ax = w.xs[k], az = w.zs[k], dx = w.xs[k + 1] - ax, dz = w.zs[k + 1] - az;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        if (Math.hypot(ax + dx * u - x, az + dz * u - z) > m - 0.3) continue;
        const y = t.ys[k] + (t.ys[k + 1] - t.ys[k]) * u;
        // only for a vehicle that is at tunnel level (came in through a portal)
        if (refY < y + 3.2 && !(y < best)) best = y;
      }
    }
    return best;
  }

  /** Feeds the ground shader the open-cut ramp segments nearest to the car. */
  private updateCuts(x: number, z: number): void {
    const segs: { ax: number; az: number; bx: number; bz: number; w: number; d: number }[] = [];
    for (const t of this.tubes.values()) {
      const w = t.way;
      if (x < w.minX - 400 || x > w.maxX + 400 || z < w.minZ - 400 || z > w.maxZ + 400) continue;
      let start = -1;
      const flush = (end: number) => {
        if (start < 0) return;
        const mx = (t.dx[start] + t.dx[end]) / 2, mz = (t.dz[start] + t.dz[end]) / 2;
        segs.push({ ax: t.dx[start], az: t.dz[start], bx: t.dx[end], bz: t.dz[end], w: t.hw + 0.25, d: Math.hypot(mx - x, mz - z) });
        start = -1;
      };
      for (let i = 0; i < t.dx.length; i++) {
        // open cut: the floor is below the ground but not yet under a roof
        const open = t.depth[i] > 0.12 && t.depth[i] <= COVER + 1.5;
        if (open && start < 0) start = i;
        // keep each capsule short and straight
        if (start >= 0 && (!open || i - start >= 6 || i === t.dx.length - 1)) { flush(open ? i : i - 1); if (open && i < t.dx.length - 1) start = i; }
      }
    }
    segs.sort((a, b) => a.d - b.d);
    const n = Math.min(12, segs.length);
    for (let i = 0; i < n; i++) { groundUniforms.tdCuts.value[i].set(segs[i].ax, segs[i].az, segs[i].bx, segs[i].bz); groundUniforms.tdCutW.value[i] = segs[i].w; }
    groundUniforms.tdCutN.value = n;
  }
}

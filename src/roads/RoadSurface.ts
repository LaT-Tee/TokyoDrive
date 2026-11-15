// Vector road layer: the photo ground only provides colour; the carriageway is
// re-paved as geometry from OSM centrelines - an asphalt ribbon draped on the
// terrain (procedural dark noise material) with edge lines, centre lines, lane
// dashes, stop lines and zebra crossings as painted geometry. Geometry stays
// sharp at any distance, which is what makes a road read as a road.
//
// Layering (no z-fighting): asphalt sits ROAD_LIFT above the terrain, paint a
// further PAINT_LIFT above the asphalt, and both use polygon offset.
import * as THREE from 'three';
import type { Roads, Way } from '../world/Roads';
import type { Terrain } from '../world/Terrain';
import type { Decks } from '../decks/Decks';

const CELL = 200;         // m; geometry is batched per cell
const BUILD_RANGE = 500;  // cells within this distance of the car are paved
const DROP_RANGE = 750;
const STEP = 4;           // m between centreline samples
export const ROAD_LIFT = 0.1;
const PAINT_LIFT = 0.035;
const WHITE: [number, number, number] = [0.82, 0.82, 0.8];
const YELLOW: [number, number, number] = [0.85, 0.6, 0.08];

interface Dense {
  n: number; xs: Float64Array; zs: Float64Array; s: Float64Array;
  rx: Float64Array; rz: Float64Array;                 // unit right vector at each sample
  yL: Float64Array; yC: Float64Array; yR: Float64Array; // heights at left edge / centre / right edge
  hw: number; total: number;
  clear: [number, number][];                          // s-intervals without paint (junctions)
  junctions: { s: number; r: number }[];
  paveAsphalt: boolean;
}
interface Cell { asphalt: THREE.Mesh | null; paint: THREE.Mesh | null; missingBridge: boolean }
interface Buf { pos: number[]; uv: number[]; col: number[] }

function makeAsphaltTexture(): THREE.CanvasTexture {
  const size = 256, cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!, img = ctx.createImageData(size, size);
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < size * size; i++) {
    // fine aggregate noise with a few lighter stones and darker tar specks
    let v = 50 + (rnd() - 0.5) * 24;
    const r = rnd();
    if (r > 0.985) v += 38; else if (r < 0.02) v -= 22;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v + 3; img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class RoadSurface {
  readonly group = new THREE.Group();
  private cells = new Map<string, Cell>();
  private dense = new Map<number, Dense | null>();
  private nodes = new Map<string, { count: number; ends: number; width: number }>();
  private roadsVersion = -1;
  private decksVersion = -1; private lastDeckCheck = 0;
  private asphaltMat = new THREE.MeshLambertMaterial({ map: makeAsphaltTexture(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
  private paintMat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -10 });
  builtCells = 0;

  constructor(private roads: Roads, private terrain: Terrain, private decks: Decks) { this.group.name = 'road-surface'; }

  update(x: number, z: number): void {
    if (!this.roads.enabled) return;
    if (this.roadsVersion !== this.roads.version) { this.roadsVersion = this.roads.version; this.indexNodes(); this.dense.clear(); }
    // decks are built after the ground roads: re-pave cells that were waiting for one
    const now = performance.now();
    if (this.decksVersion !== this.decks.version && now - this.lastDeckCheck > 1500) {
      this.decksVersion = this.decks.version; this.lastDeckCheck = now;
      for (const id of [...this.dense.keys()]) if (this.roads.ways.get(id)?.bridge) this.dense.delete(id);
      for (const [key, c] of this.cells) if (c.missingBridge) { this.disposeCell(c); this.cells.delete(key); }
    }
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), R = Math.ceil(BUILD_RANGE / CELL);
    for (const [key, c] of this.cells) {
      const [kx, kz] = key.split(',').map(Number);
      if (Math.hypot((kx + 0.5) * CELL - x, (kz + 0.5) * CELL - z) > DROP_RANGE) { this.disposeCell(c); this.cells.delete(key); }
    }
    const want: [number, number, number][] = [];
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot((cx + dx + 0.5) * CELL - x, (cz + dz + 0.5) * CELL - z);
      if (d <= BUILD_RANGE && !this.cells.has(cx + dx + ',' + (cz + dz))) want.push([cx + dx, cz + dz, d]);
    }
    want.sort((a, b) => a[2] - b[2]);
    const t0 = performance.now();
    for (const [kx, kz] of want) {
      if (!this.buildCell(kx, kz)) continue;
      if (performance.now() - t0 > 8) break;
    }
  }

  private disposeCell(c: Cell): void {
    for (const m of [c.asphalt, c.paint]) if (m) { this.group.remove(m); m.geometry.dispose(); }
  }

  private indexNodes(): void {
    this.nodes.clear();
    for (const w of this.roads.ways.values()) {
      if (w.tunnel) continue;
      for (let k = 0; k < w.n; k++) {
        let e = this.nodes.get(w.keys[k]);
        if (!e) { e = { count: 0, ends: 0, width: 0 }; this.nodes.set(w.keys[k], e); }
        e.count++; if (k === 0 || k === w.n - 1) e.ends++;
        e.width = Math.max(e.width, w.width);
      }
    }
  }
  private isJunction(key: string): boolean {
    const e = this.nodes.get(key);
    return !!e && (e.count >= 3 || (e.count === 2 && e.ends < 2));
  }

  /** Dense, height-sampled description of a way; null while its ground is not loaded. */
  private denseOf(w: Way): Dense | null {
    if (this.dense.has(w.id)) return this.dense.get(w.id)!;
    let deckYs: Float64Array | null = null;
    if (w.bridge) {
      deckYs = this.decks.profile(w.id);
      if (!deckYs) return null; // covered by a real PLATEAU bridge, or deck not built yet (not cached: retry)
    }
    const xs: number[] = [], zs: number[] = [], ss: number[] = [], ys: number[] = [];
    const nodeS: number[] = [];
    let s = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const ax = w.xs[k], az = w.zs[k], bx = w.xs[k + 1], bz = w.zs[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      nodeS.push(s);
      if (len < 0.05) continue;
      const parts = Math.max(1, Math.ceil(len / STEP));
      for (let i = 0; i < parts; i++) {
        const t = i / parts;
        xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t); ss.push(s + len * t);
        if (deckYs) ys.push(deckYs[k] + (deckYs[k + 1] - deckYs[k]) * t);
      }
      s += len;
    }
    nodeS.push(s);
    xs.push(w.xs[w.n - 1]); zs.push(w.zs[w.n - 1]); ss.push(s);
    if (deckYs) ys.push(deckYs[w.n - 1]);
    const n = xs.length;
    if (n < 2) { this.dense.set(w.id, null); return null; }
    const hw = w.width / 2;
    const d: Dense = {
      n, xs: Float64Array.from(xs), zs: Float64Array.from(zs), s: Float64Array.from(ss),
      rx: new Float64Array(n), rz: new Float64Array(n), yL: new Float64Array(n), yC: new Float64Array(n), yR: new Float64Array(n),
      hw, total: s, clear: [], junctions: [], paveAsphalt: true,
    };
    for (let i = 0; i < n; i++) {
      const p = Math.max(0, i - 1), q = Math.min(n - 1, i + 1);
      let dx = xs[q] - xs[p], dz = zs[q] - zs[p];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      d.rx[i] = -dz; d.rz[i] = dx;
      if (deckYs) { d.yL[i] = d.yC[i] = d.yR[i] = ys[i] + 0.03; continue; }
      const lx = xs[i] - d.rx[i] * hw, lz = zs[i] - d.rz[i] * hw, rx2 = xs[i] + d.rx[i] * hw, rz2 = zs[i] + d.rz[i] * hw;
      if (!this.terrain.isReady(lx, lz) || !this.terrain.isReady(rx2, rz2)) return null; // not cached: retry later
      d.yL[i] = this.terrain.heightAt(lx, lz) + ROAD_LIFT;
      d.yC[i] = this.terrain.heightAt(xs[i], zs[i]) + ROAD_LIFT;
      d.yR[i] = this.terrain.heightAt(rx2, rz2) + ROAD_LIFT;
    }
    for (let k = 0; k < w.n; k++) {
      if (!this.isJunction(w.keys[k])) continue;
      const r = Math.max(3.5, (this.nodes.get(w.keys[k])?.width ?? w.width) / 2 + 1);
      d.junctions.push({ s: nodeS[k], r });
      d.clear.push([nodeS[k] - r - 5.2, nodeS[k] + r + 5.2]);
    }
    d.clear.sort((a, b) => a[0] - b[0]);
    this.dense.set(w.id, d);
    return d;
  }

  private buildCell(kx: number, kz: number): boolean {
    const x0 = kx * CELL, z0 = kz * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
    const mx = x0 + CELL / 2, mz = z0 + CELL / 2;
    if (!this.roads.hasData(mx, mz) || !this.terrain.isReady(mx, mz)) return false;
    const A: Buf = { pos: [], uv: [], col: [] }, P: Buf = { pos: [], uv: [], col: [] };
    let missingBridge = false;
    const m = 30; // margin: a way's ribbon can stick out of its centreline bbox
    for (const w of this.roads.ways.values()) {
      if (w.tunnel || w.maxX < x0 - m || w.minX > x1 + m || w.maxZ < z0 - m || w.minZ > z1 + m) continue;
      const d = this.denseOf(w);
      if (!d) { if (w.bridge) { missingBridge = true; continue; } return false; } // ground not ready: try this cell again later
      this.emitWay(w, d, x0, z0, x1, z1, mx, mz, A, P);
    }
    const mk = (b: Buf, mat: THREE.Material, colors: boolean, order: number): THREE.Mesh | null => {
      if (!b.pos.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      else g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      // roads are near-horizontal: a constant up normal avoids faceted shading between ribbons
      const nrm = new Float32Array(b.pos.length);
      for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(mx, 0, mz); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      mesh.renderOrder = order; mesh.receiveShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    this.cells.set(kx + ',' + kz, { asphalt: mk(A, this.asphaltMat, false, 1), paint: mk(P, this.paintMat, true, 2), missingBridge });
    this.builtCells++;
    return true;
  }

  private emitWay(w: Way, d: Dense, x0: number, z0: number, x1: number, z1: number, ox: number, oz: number, A: Buf, P: Buf): void {
    const inCell = (i: number) => {
      const cx = (d.xs[i] + d.xs[i + 1]) / 2, cz = (d.zs[i] + d.zs[i + 1]) / 2;
      return cx >= x0 && cx < x1 && cz >= z0 && cz < z1;
    };
    // point on the cross-section at sample i (+ fraction t toward i+1), lateral offset o
    const pt = (i: number, t: number, o: number, lift: number, out: number[]) => {
      const j = Math.min(i + 1, d.n - 1);
      const x = d.xs[i] + (d.xs[j] - d.xs[i]) * t, z = d.zs[i] + (d.zs[j] - d.zs[i]) * t;
      const rx = d.rx[i] + (d.rx[j] - d.rx[i]) * t, rz = d.rz[i] + (d.rz[j] - d.rz[i]) * t;
      const f = Math.max(-1, Math.min(1, o / d.hw));
      const yi = f < 0 ? d.yC[i] + (d.yL[i] - d.yC[i]) * -f : d.yC[i] + (d.yR[i] - d.yC[i]) * f;
      const yj = f < 0 ? d.yC[j] + (d.yL[j] - d.yC[j]) * -f : d.yC[j] + (d.yR[j] - d.yC[j]) * f;
      out.push(x + rx * o - ox, yi + (yj - yi) * t + lift, z + rz * o - oz);
    };
    const quad = (b: Buf, i: number, ta: number, tb: number, oL: number, oR: number, lift: number, c?: [number, number, number]) => {
      const q: number[] = [];
      pt(i, ta, oL, lift, q); pt(i, ta, oR, lift, q); pt(i, tb, oL, lift, q); pt(i, tb, oR, lift, q);
      const [a, r, l2, r2] = [q.slice(0, 3), q.slice(3, 6), q.slice(6, 9), q.slice(9, 12)];
      b.pos.push(...a, ...r, ...l2, ...l2, ...r, ...r2);
      if (c) for (let k = 0; k < 6; k++) b.col.push(c[0], c[1], c[2]);
      else for (const v of [a, r, l2, l2, r, r2]) b.uv.push((v[0] + ox) / 3.2, (v[2] + oz) / 3.2);
    };

    if (d.paveAsphalt) for (let i = 0; i < d.n - 1; i++) {
      if (!inCell(i)) continue;
      quad(A, i, 0, 1, -d.hw, 0, 0); quad(A, i, 0, 1, 0, d.hw, 0);
    }

    /** Painted strip between s0..s1 at lateral offsets oL..oR; optional dash pattern; skips junction clear zones. */
    const strip = (oL: number, oR: number, c: [number, number, number], s0: number, s1: number, dashOn = 0, dashOff = 0, respectClear = true) => {
      const period = dashOn + dashOff;
      for (let i = 0; i < d.n - 1; i++) {
        const a = d.s[i], b = d.s[i + 1];
        if (b <= s0 || a >= s1 || b - a < 1e-6 || !inCell(i)) continue;
        let cur = Math.max(a, s0); const end = Math.min(b, s1);
        while (cur < end - 1e-6) {
          let stop = end, on = true;
          if (respectClear) for (const [c0, c1] of d.clear) {
            if (cur >= c0 && cur < c1) { on = false; stop = Math.min(stop, c1); break; }
            if (c0 > cur) { stop = Math.min(stop, c0); break; }
          }
          if (on && period > 0) {
            const ph = cur % period;
            if (ph < dashOn) stop = Math.min(stop, cur + (dashOn - ph)); else { on = false; stop = Math.min(stop, cur + (period - ph)); }
          }
          if (on) quad(P, i, (cur - a) / (b - a), (stop - a) / (b - a), oL, oR, PAINT_LIFT, c);
          cur = Math.max(stop, cur + 1e-4);
        }
      }
    };

    const hw = d.hw, width = w.width, major = w.cls <= 9; // tertiary_link and above
    if (width < 5.4) return; // narrow residential streets: asphalt only
    const edge = hw - 0.3, lw = 0.09; // paint half-width (lines are 18 cm)
    if (major) { strip(-edge - lw, -edge + lw, WHITE, 0, d.total); strip(edge - lw, edge + lw, WHITE, 0, d.total); }
    const usable = 2 * edge;
    const lanes = w.lanes > 0 ? w.lanes : Math.max(w.oneway ? 1 : 2, Math.round(usable / 3.3));
    if (w.oneway) {
      const lane = usable / lanes;
      for (let k = 1; k < lanes; k++) strip(-edge + k * lane - lw, -edge + k * lane + lw, WHITE, 0, d.total, 6, 9);
    } else {
      const perDir = Math.max(1, Math.floor(lanes / 2));
      if (perDir >= 2) strip(-0.1, 0.1, YELLOW, 0, d.total);          // multi-lane: solid centre line
      else strip(-lw, lw, WHITE, 0, d.total, 5, 5);                   // two-lane road: dashed centre line
      const lane = edge / perDir;
      for (let k = 1; k < perDir; k++) for (const sgn of [-1, 1]) strip(sgn * k * lane - lw, sgn * k * lane + lw, WHITE, 0, d.total, 6, 9);
    }
    // junction furniture: zebra crossings and stop lines on every arm
    if (major && !w.bridge) for (const j of d.junctions) {
      for (const dir of [-1, 1]) {
        const near = j.s + dir * (j.r + 0.6), far = j.s + dir * (j.r + 3.6);
        const a = Math.min(near, far), b = Math.max(near, far);
        if (a < 1 || b > d.total - 1) continue; // arm too short on this side
        for (let o = -hw + 0.55; o <= hw - 0.55; o += 0.9) strip(o - 0.225, o + 0.225, WHITE, a, b, 0, 0, false);
        // stop line on the approach side (left-hand traffic): approaching cars keep left
        const s0 = j.s + dir * (j.r + 4.3), s1 = j.s + dir * (j.r + 4.75);
        const approachOffsetL = dir < 0 ? -edge : w.oneway ? 0 : 0.15, approachOffsetR = dir < 0 ? (w.oneway ? edge : -0.15) : edge;
        if (dir < 0 || !w.oneway) strip(approachOffsetL, approachOffsetR, WHITE, Math.min(s0, s1), Math.max(s0, s1), 0, 0, false);
      }
    }
  }
}

// Procedural elevated-deck fallback (CLAUDE.md §5): OSM ways tagged as bridges
// that are NOT covered by real PLATEAU bridge models get a road ribbon,
// guardrails and support pillars. Purpose: drivability and silhouette.
import * as THREE from 'three';
import type { Roads, Way } from '../world/Roads';
import type { Terrain } from '../world/Terrain';
import type { DeckProvider } from '../world/Ground';
import type { TilesManager } from '../tiles/TilesManager';

const BUILD_RANGE = 2200;
const DROP_RANGE = 3200;
const LAYER_HEIGHT = 6.5;  // metres of clearance per OSM layer
const MAX_GRADE = 0.07;
const THICK = 0.9;
const RAIL_H = 0.95;
const PILLAR_EVERY = 40;

interface Deck { way: Way; ys: Float64Array; mesh: THREE.Mesh | null; covered: boolean; checkedAt: number }

export class Decks implements DeckProvider {
  readonly group = new THREE.Group();
  private decks = new Map<number, Deck>();
  private roadsVersion = -1;
  private bridgeDirty = false;
  private lastBuild = 0;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });

  constructor(private roads: Roads, private terrain: Terrain, private tiles: TilesManager) {
    this.group.name = 'procedural-decks';
    tiles.onBridgeLoaded = () => { this.bridgeDirty = true; };
  }

  get count(): number { let n = 0; for (const d of this.decks.values()) if (d.mesh) n++; return n; }
  get coveredCount(): number { let n = 0; for (const d of this.decks.values()) if (d.covered) n++; return n; }

  update(x: number, z: number): void {
    if (!this.roads.enabled) return;
    const now = performance.now();
    // drop far decks
    for (const [id, d] of this.decks) {
      const w = d.way;
      if (x < w.minX - DROP_RANGE || x > w.maxX + DROP_RANGE || z < w.minZ - DROP_RANGE || z > w.maxZ + DROP_RANGE || !this.roads.ways.has(id)) {
        this.disposeMesh(d); this.decks.delete(id);
      }
    }
    if (now - this.lastBuild < 500) return;
    this.lastBuild = now;
    // (re)check PLATEAU coverage after new bridge tiles arrived
    if (this.bridgeDirty) {
      this.bridgeDirty = false;
      for (const d of this.decks.values()) {
        if (d.covered) continue;
        if (this.isCovered(d)) { d.covered = true; this.disposeMesh(d); }
      }
    }
    if (this.roadsVersion === this.roads.version && this.pendingNone) return;
    this.roadsVersion = this.roads.version;
    this.pendingNone = true;
    const t0 = performance.now();
    const batch: Way[] = [];
    for (const w of this.roads.ways.values()) {
      if (!w.bridge || w.tunnel || this.decks.has(w.id)) continue;
      if (x < w.minX - BUILD_RANGE || x > w.maxX + BUILD_RANGE || z < w.minZ - BUILD_RANGE || z > w.maxZ + BUILD_RANGE) { this.pendingNone = false; continue; }
      let ready = true;
      for (let k = 0; k < w.n; k++) if (!this.terrain.isReady(w.xs[k], w.zs[k])) { ready = false; break; }
      if (!ready) { this.pendingNone = false; continue; }
      batch.push(w);
    }
    if (!batch.length) return;
    const heights = this.solveHeights(batch);
    for (const w of batch) {
      const d: Deck = { way: w, ys: heights.get(w.id)!, mesh: null, covered: false, checkedAt: now };
      this.decks.set(w.id, d);
      if (this.isCovered(d)) d.covered = true; else this.buildMesh(d);
      if (performance.now() - t0 > 12) { this.pendingNone = false; this.roadsVersion = -1; break; } // continue next tick
    }
  }
  private pendingNone = false;

  private disposeMesh(d: Deck): void {
    if (!d.mesh) return;
    this.group.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh = null;
  }

  /** True when real PLATEAU bridge geometry exists along most of this way. */
  private isCovered(d: Deck): boolean {
    if (!this.tiles.bridgeMeshCount) return false;
    const w = d.way;
    let hit = 0, total = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const len = Math.hypot(w.xs[k + 1] - w.xs[k], w.zs[k + 1] - w.zs[k]);
      const steps = Math.max(1, Math.round(len / 15));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const x = w.xs[k] + (w.xs[k + 1] - w.xs[k]) * t, z = w.zs[k] + (w.zs[k + 1] - w.zs[k]) * t;
        total++;
        const g = this.terrain.heightAt(x, z);
        const h = this.tiles.castDown(x, g + 120, z, 121.5);
        if (h > g - 1.5) hit++;
      }
    }
    return total > 0 && hit / total >= 0.5;
  }

  /** Deck heights for a batch of bridge ways, using connectivity to ground-level roads as anchors. */
  private solveHeights(batch: Way[]): Map<number, Float64Array> {
    // which node keys touch a non-bridge road (anchors)?
    const bridgeKeys = new Set<string>();
    const allBridges: Way[] = [];
    for (const w of this.roads.ways.values()) if (w.bridge && !w.tunnel) { allBridges.push(w); for (const k of w.keys) bridgeKeys.add(k); }
    const anchors = new Set<string>();
    for (const w of this.roads.ways.values()) {
      if (w.bridge) continue;
      for (const k of [w.keys[0], w.keys[w.n - 1]]) if (bridgeKeys.has(k)) anchors.add(k);
      // mid-way junctions are rare for bridges; ends cover the normal case
    }
    const upper = new Map<string, number>(), lower = new Map<string, number>(), desired = new Map<string, number>();
    const ground = (w: Way, k: number) => this.terrain.heightAt(w.xs[k], w.zs[k]);
    for (const w of allBridges) for (let k = 0; k < w.n; k++) {
      const key = w.keys[k];
      if (!this.terrain.isReady(w.xs[k], w.zs[k])) continue;
      const g = ground(w, k);
      if (anchors.has(key)) { upper.set(key, g); lower.set(key, g); desired.set(key, g); }
      else {
        const want = g + Math.max(1, w.layer) * LAYER_HEIGHT;
        desired.set(key, Math.max(desired.get(key) ?? -Infinity, want));
      }
    }
    // relax slope limits out from the anchors
    for (let pass = 0; pass < 40; pass++) {
      let changed = false;
      for (const w of allBridges) for (let dir = 0; dir < 2; dir++) for (let s = 1; s < w.n; s++) {
        const a = dir ? w.n - s : s - 1, b = dir ? w.n - s - 1 : s;
        const ka = w.keys[a], kb = w.keys[b];
        const d = Math.hypot(w.xs[a] - w.xs[b], w.zs[a] - w.zs[b]) * MAX_GRADE;
        const ua = upper.get(ka), la = lower.get(ka);
        if (ua !== undefined && ua + d < (upper.get(kb) ?? Infinity) - 1e-3) { upper.set(kb, ua + d); changed = true; }
        if (la !== undefined && la - d > (lower.get(kb) ?? -Infinity) + 1e-3) { lower.set(kb, la - d); changed = true; }
      }
      if (!changed) break;
    }
    const out = new Map<number, Float64Array>();
    for (const w of batch) {
      const ys = new Float64Array(w.n);
      for (let k = 0; k < w.n; k++) {
        const key = w.keys[k];
        const want = desired.get(key) ?? ground(w, k) + LAYER_HEIGHT;
        ys[k] = Math.max(Math.min(want, upper.get(key) ?? Infinity), lower.get(key) ?? -Infinity);
      }
      // light smoothing of interior nodes so the deck does not mirror terrain bumps
      for (let it = 0; it < 3; it++) for (let k = 1; k < w.n - 1; k++) if (!anchors.has(w.keys[k])) ys[k] = (ys[k - 1] + 2 * ys[k] + ys[k + 1]) / 4;
      out.set(w.id, ys);
    }
    return out;
  }

  private buildMesh(d: Deck): void {
    const w = d.way, hw = w.width / 2;
    const pos: number[] = [], col: number[] = [];
    const quad = (a: number[], b: number[], c: number[], e: number[], r: number, g: number, bl: number) => {
      pos.push(...a, ...b, ...c, ...a, ...c, ...e);
      for (let i = 0; i < 6; i++) col.push(r, g, bl);
    };
    const ox = w.xs[0], oz = w.zs[0];
    // per-node left/right offsets (mitred)
    const L: number[][] = [], R: number[][] = [];
    for (let k = 0; k < w.n; k++) {
      const p = Math.max(0, k - 1), n = Math.min(w.n - 1, k + 1);
      let dx = w.xs[n] - w.xs[p], dz = w.zs[n] - w.zs[p];
      const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
      const rx = -dz, rz = dx; // right of travel direction
      L.push([w.xs[k] - rx * hw - ox, d.ys[k], w.zs[k] - rz * hw - oz]);
      R.push([w.xs[k] + rx * hw - ox, d.ys[k], w.zs[k] + rz * hw - oz]);
    }
    const dn = (p: number[], by: number) => [p[0], p[1] - by, p[2]];
    const up = (p: number[], by: number) => [p[0], p[1] + by, p[2]];
    let run = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const l0 = L[k], l1 = L[k + 1], r0 = R[k], r1 = R[k + 1];
      quad(l0, r0, r1, l1, 0.20, 0.21, 0.23);                              // asphalt top
      quad(dn(l0, THICK), dn(l1, THICK), dn(r1, THICK), dn(r0, THICK), 0.42, 0.42, 0.42); // underside
      quad(up(l0, RAIL_H), dn(l0, THICK), dn(l1, THICK), up(l1, RAIL_H), 0.62, 0.62, 0.60); // left side + rail (outer)
      quad(up(l0, RAIL_H), up(l1, RAIL_H), l1, l0, 0.70, 0.70, 0.68);      // left rail (inner)
      quad(up(r0, RAIL_H), up(r1, RAIL_H), dn(r1, THICK), dn(r0, THICK), 0.62, 0.62, 0.60);
      quad(up(r0, RAIL_H), r0, r1, up(r1, RAIL_H), 0.70, 0.70, 0.68);
      // pillars
      const sx = w.xs[k], sz = w.zs[k], ex = w.xs[k + 1], ez = w.zs[k + 1];
      const len = Math.hypot(ex - sx, ez - sz);
      let at = PILLAR_EVERY - run;
      while (at < len) {
        const t = at / len, px = sx + (ex - sx) * t, pz = sz + (ez - sz) * t, top = d.ys[k] + (d.ys[k + 1] - d.ys[k]) * t - THICK;
        const g = this.terrain.heightAt(px, pz) - 1;
        if (top - g > 3.5) {
          const s = Math.min(1.1, hw * 0.35), x = px - ox, z = pz - oz;
          const c = [[x - s, z - s], [x + s, z - s], [x + s, z + s], [x - s, z + s]];
          for (let i = 0; i < 4; i++) {
            const a = c[i], b = c[(i + 1) % 4];
            quad([a[0], top, a[1]], [a[0], g, a[1]], [b[0], g, b[1]], [b[0], top, b[1]], 0.55, 0.55, 0.54);
          }
        }
        at += PILLAR_EVERY;
      }
      run = (run + len) % PILLAR_EVERY;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.material.side = THREE.DoubleSide;
    mesh.position.set(ox, 0, oz); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.name = 'deck ' + w.id;
    d.mesh = mesh; this.group.add(mesh);
  }

  // DeckProvider: analytic surface lookup on the ribbon (no raycast needed).
  deckHeight(x: number, z: number, maxY: number): number {
    let best = -Infinity;
    for (const d of this.decks.values()) {
      if (!d.mesh) continue;
      const w = d.way, m = w.width / 2 + 0.2;
      if (x < w.minX - m || x > w.maxX + m || z < w.minZ - m || z > w.maxZ + m) continue;
      for (let k = 0; k < w.n - 1; k++) {
        const ax = w.xs[k], az = w.zs[k], dx = w.xs[k + 1] - ax, dz = w.zs[k + 1] - az;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        if (Math.hypot(ax + dx * t - x, az + dz * t - z) > m) continue;
        const y = d.ys[k] + (d.ys[k + 1] - d.ys[k]) * t;
        if (y <= maxY && y > best) best = y;
      }
    }
    return best;
  }
}

// Procedural elevated-deck fallback (CLAUDE.md §5). OSM has no heights: bridges only
// carry bridge=yes and a layer number, so deck heights are solved here:
//  - where a real PLATEAU bridge model stands, its surface is measured and those node
//    heights become fixed (a way covered almost entirely by the model is left to the model;
//    a partly covered way gets procedural deck only where the model is missing);
//  - expressway approaches that OSM does not tag as bridges (embankments, retaining walls,
//    short untagged gaps between viaducts) join the solve as "ramps", so a viaduct comes
//    down to the street along its ramp instead of being pinned to the ground at its end;
//  - everything else is a guess from road class and layer, smoothed to a maximum grade.
// Purpose: drivability and silhouette, without steps where pieces meet.
import * as THREE from 'three';
import type { Roads, Way } from '../world/Roads';
import type { Terrain } from '../world/Terrain';
import type { DeckProvider } from '../world/Ground';
import type { TilesManager } from '../tiles/TilesManager';

const BUILD_RANGE = 2200;
const DROP_RANGE = 3200;
const LAYER_HEIGHT = 6.5;   // metres of clearance per OSM layer (ordinary overpasses)
const EXPRESSWAY_H = 11;    // first-level expressway viaduct (Shuto etc.)
const MAX_GRADE = 0.07;
const THICK = 0.9;
const RAIL_H = 0.95;
const PILLAR_EVERY = 40;
const NEAR_READY = 1200;   // m: deck nodes this close to the car need detailed terrain to be solved
const COVERED = 0.85;       // model coverage above which the model alone carries the way
const RAMP_MAX_LEN = 900;   // m of untagged approach that may be lifted, per chain
const GAP_MAX_LEN = 250;    // m: untagged gap between two bridges of an ordinary road
const MODEL_LIFT = 0.15;    // procedural profiles ride this far above a measured model deck

interface Deck {
  way: Way; ys: Float64Array; mesh: THREE.Mesh | null; covered: boolean; ramp: boolean;
  /** Has a drivable profile (procedural deck or lifted ramp). */
  built: boolean;
  /** Per segment: the real model is there, draw nothing procedural. */
  skip: Uint8Array | null;
  cov: number;
  /** Solved while part of the way had no detailed terrain yet: solved again once it has. */
  approx: boolean;
  /** The nodes that had no detailed terrain then. */
  approxKeys: string[];
  /** Being replaced: still drivable until the new deck is built. */
  stale: boolean;
}

/** Bridge deck height guess above the ground for a way without any measured anchor. */
function guess(w: Way): number {
  const l = Math.max(1, w.layer);
  return w.cls <= 1 ? EXPRESSWAY_H + (l - 1) * 7 : l * LAYER_HEIGHT;
}
function wayLength(w: Way): number {
  let s = 0;
  for (let k = 0; k < w.n - 1; k++) s += Math.hypot(w.xs[k + 1] - w.xs[k], w.zs[k + 1] - w.zs[k]);
  return s;
}

export class Decks implements DeckProvider {
  readonly group = new THREE.Group();
  private decks = new Map<number, Deck>();
  private roadsVersion = -1;
  /** Bumped whenever a deck is built, removed or found to be covered by PLATEAU. */
  version = 0;
  private bridgeDirty = false;
  /** Heights already handed out to built decks, per OSM node: later batches must join them exactly. */
  private nodeY = new Map<string, number>();
  /** Node heights measured on a real PLATEAU model (never forgotten while loaded). */
  private modelKeys = new Set<string>();
  private lastBuild = 0;
  private material = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** Areas whose road surface must be re-paved (deck built, changed or removed). */
  private dirty: [number, number, number, number][] = [];
  // graph of ways whose heights are solved together (bridges + lifted approaches)
  private graphVersion = -1;
  private graph: Way[] = [];
  private rampIds = new Set<number>();
  private anchors = new Set<string>();
  private pendingNone = false;

  constructor(private roads: Roads, private terrain: Terrain, private tiles: TilesManager) {
    this.group.name = 'procedural-decks';
    tiles.onBridgeLoaded = () => { this.bridgeDirty = true; };
  }

  /** Deck heights along a way with a procedural profile (bridge deck or lifted ramp), else null. */
  profile(id: number): Float64Array | null { const d = this.decks.get(id); return d && d.built ? d.ys : null; }

  /** True when a real PLATEAU bridge model carries this bridge way. */
  isCoveredWay(id: number): boolean { return !!this.decks.get(id)?.covered; }

  /** Street height at a node (RoadProfiles), NaN if no street profile has fixed it yet. */
  streetNode: ((key: string) => number) | null = null;
  private streetAt(key: string, x: number, z: number): number {
    const v = this.streetNode ? this.streetNode(key) : NaN;
    return v === v ? v : this.terrain.heightAt(x, z);
  }
  /** Height given to a node where a street joins a deck (so the street can meet it), else NaN. */
  junctionHeight(key: string): number { return this.anchors.has(key) ? this.nodeY.get(key) ?? NaN : NaN; }

  /** An untagged approach that is solved (and maybe lifted) together with the bridges. */
  isRamp(id: number): boolean { return this.rampIds.has(id); }

  /** Height of a node measured on a real bridge model, or NaN. */
  nodeHeight(key: string): number { return this.modelKeys.has(key) ? this.nodeY.get(key)! - MODEL_LIFT : NaN; }

  /** Areas to re-pave since the last call (x0, z0, x1, z1). */
  takeDirty(): [number, number, number, number][] { const d = this.dirty; this.dirty = []; return d; }

  get count(): number { let n = 0; for (const d of this.decks.values()) if (d.mesh) n++; return n; }
  get coveredCount(): number { let n = 0; for (const d of this.decks.values()) if (d.covered) n++; return n; }

  private markDirty(w: Way): void { this.dirty.push([w.minX - 15, w.minZ - 15, w.maxX + 15, w.maxZ + 15]); }

  private drop(id: number, d: Deck): void {
    this.disposeMesh(d);
    if (d.built || d.covered) this.markDirty(d.way);
    this.decks.delete(id);
    this.version++;
  }

  update(x: number, z: number): void {
    if (!this.roads.enabled) return;
    const now = performance.now();
    for (const [id, d] of this.decks) {
      const w = d.way;
      if (x < w.minX - DROP_RANGE || x > w.maxX + DROP_RANGE || z < w.minZ - DROP_RANGE || z > w.maxZ + DROP_RANGE || !this.roads.ways.has(id)) this.drop(id, d);
    }
    if (now - this.lastBuild < 500) return;
    this.lastBuild = now;
    if (this.graphVersion !== this.roads.version) {
      this.buildGraph();
      // ramps that were left on the ground may be lifted now that more of the network is in
      for (const [id, d] of this.decks) if (d.ramp && !d.built) this.decks.delete(id);
      for (const [id, d] of this.decks) if (d.ramp && !this.rampIds.has(id)) this.forget(id, d);
      // a street that just loaded may join a deck solved before it was there: that end has
      // to come down to the street
      for (const [id, d] of this.decks) {
        if (!d.built) continue;
        const w = d.way;
        for (let k = 0; k < w.n; k++) {
          const key = w.keys[k];
          if (!this.anchors.has(key) || this.modelKeys.has(key)) continue;
          if (Math.abs(d.ys[k] - this.streetAt(key, w.xs[k], w.zs[k])) > 1) { this.forget(id, d); break; }
        }
      }
    }
    const t0 = performance.now();
    // new bridge tiles arrived: re-measure the procedural decks' coverage, a few per tick
    if (this.bridgeDirty) { this.bridgeDirty = false; this.covCache.clear(); this.recheck = [...this.decks.keys()]; this.pendingNone = false; }
    while (this.recheck.length && performance.now() - t0 < 2) {
      const id = this.recheck.pop()!, d = this.decks.get(id);
      if (!d || d.covered || d.ramp || !d.built) continue;
      if (this.cov(d.way) - d.cov > 0.08) this.forget(id, d); // more of the real model now: rebuilt around it (tiles swapping detail out are ignored)
    }
    for (const d of this.decks.values()) {
      if (!d.approx || d.stale) continue;
      const w = d.way;
      if (w.keys.every((_, k) => this.terrain.isReady(w.xs[k], w.zs[k]))) {
        // the heights guessed on rough terrain go, and every deck that was solved against
        // them is solved again too (still drivable until its replacement is built)
        const rough = new Set(d.approxKeys);
        for (const key of rough) if (!this.modelKeys.has(key)) this.nodeY.delete(key);
        for (const o of this.decks.values()) if (o.built && o.way.keys.some((k) => rough.has(k))) o.stale = true;
        d.stale = true; this.pendingNone = false;
      }
    }
    if (this.queue.length) { this.buildQueued(t0, null); return; }
    if (this.roadsVersion === this.roads.version && this.pendingNone) return;
    this.roadsVersion = this.roads.version;
    this.pendingNone = true;
    const batch: Way[] = [];
    for (const w of this.graph) {
      if (this.decks.has(w.id) && !this.decks.get(w.id)!.stale) continue;
      if (x < w.minX - BUILD_RANGE || x > w.maxX + BUILD_RANGE || z < w.minZ - BUILD_RANGE || z > w.maxZ + BUILD_RANGE) { this.pendingNone = false; continue; }
      // a long viaduct (2+ km) is built before the far end's detailed terrain is in: only the
      // part near the car has to be ready, the rest is solved again once it is (see approx)
      let ready = true;
      for (let k = 0; k < w.n; k++) if (!this.terrain.isReady(w.xs[k], w.zs[k]) && Math.hypot(w.xs[k] - x, w.zs[k] - z) < NEAR_READY) { ready = false; break; }
      if (!ready) { this.pendingNone = false; continue; }
      batch.push(w);
    }
    if (!batch.length) return;
    // model coverage of the batch: raycasts, so measured within a time budget and cached
    for (const w of batch) {
      if (this.rampIds.has(w.id) || this.covCache.has(w.id)) continue;
      if (performance.now() - t0 > 6) { this.pendingNone = false; return; } // continue next tick
      this.cov(w);
    }
    // Measure the real PLATEAU bridges first: their node heights become fixed anchors, so
    // procedural pieces next to them join the real bridge instead of ending in mid-air.
    const solve: Way[] = [];
    for (const w of batch) {
      if (this.rampIds.has(w.id)) { solve.push(w); continue; }
      const cov = this.cov(w);
      if (cov >= COVERED) {
        const old = this.decks.get(w.id);
        if (old) this.disposeMesh(old);
        this.decks.set(w.id, { way: w, ys: new Float64Array(w.n), mesh: null, covered: true, ramp: false, built: false, skip: null, cov, approx: false, approxKeys: [], stale: false });
        this.adoptModel(w); this.markDirty(w); this.version++;
      } else {
        if (cov > 0.05) this.adoptModel(w, true);
        solve.push(w);
      }
    }
    const heights = this.solveHeights(solve);
    for (const w of solve) {
      const ys = heights.get(w.id);
      if (!ys) { this.pendingNone = false; continue; }
      // claim the solved heights now, so the rest of the batch (built over the next ticks)
      // stays consistent with what is built first
      if (!this.rampIds.has(w.id)) for (let k = 0; k < w.n; k++) if (!this.nodeY.has(w.keys[k])) this.nodeY.set(w.keys[k], ys[k]);
      this.queue.push([w, ys]);
    }
    this.buildQueued(t0, solve);
  }
  private queue: [Way, Float64Array][] = [];

  /** Turn solved ways into decks, within a frame budget; the rest waits for the next tick. */
  private buildQueued(t0: number, solve: Way[] | null): void {
    let built = 0;
    while (this.queue.length) {
      if (built && performance.now() - t0 > 10) { this.pendingNone = false; break; }
      const [w, ys] = this.queue.shift()!;
      const old = this.decks.get(w.id);
      if ((old && !old.stale) || !this.roads.ways.has(w.id)) continue;
      if (old) { this.disposeMesh(old); this.decks.delete(w.id); }
      const ramp = this.rampIds.has(w.id);
      let lifted = !ramp;
      if (ramp) for (let k = 0; k < w.n; k++) if (ys[k] - this.terrain.heightAt(w.xs[k], w.zs[k]) > 0.35) { lifted = true; break; }
      const approxKeys = w.keys.filter((_, k) => !this.terrain.isReady(w.xs[k], w.zs[k]));
      const d: Deck = { way: w, ys, mesh: null, covered: false, ramp, built: lifted, skip: null, cov: ramp ? 0 : this.cov(w), approx: approxKeys.length > 0, approxKeys, stale: false };
      this.decks.set(w.id, d);
      if (!lifted) continue; // an approach that stays on the ground: ordinary road
      if (!ramp) d.skip = this.modelSegments(w, ys);
      for (let k = 0; k < w.n; k++) this.nodeY.set(w.keys[k], ys[k]);
      this.buildMesh(d);
      this.markDirty(w);
      this.version++; built++;
    }
    // approaches left on the ground earlier are solved again against the decks just built
    if (built && !this.queue.length) {
      const now2 = new Set((solve ?? []).map((w) => w.id));
      for (const [id, d] of this.decks) if (d.ramp && !d.built && !now2.has(id)) { this.decks.delete(id); this.pendingNone = false; }
    }
  }
  private covCache = new Map<number, number>();
  private recheck: number[] = [];
  /** Cached model coverage of a way. */
  private cov(w: Way): number {
    let c = this.covCache.get(w.id);
    if (c === undefined) { c = this.coverage(w); this.covCache.set(w.id, c); }
    return c;
  }

  /** Remove a deck and its own height guesses (not the model's) so it is solved again. */
  private forget(id: number, d: Deck): void {
    for (const key of d.way.keys) if (!this.modelKeys.has(key)) this.nodeY.delete(key);
    this.drop(id, d);
  }

  /** Bridges plus the untagged approaches that may have to be lifted to meet them. */
  private buildGraph(): void {
    this.graphVersion = this.roads.version;
    const atKey = new Map<string, Way[]>();
    for (const w of this.roads.ways.values()) {
      if (w.tunnel) continue;
      for (const k of w.keys) { const a = atKey.get(k); if (a) a.push(w); else atKey.set(k, [w]); }
    }
    const bridges: Way[] = [];
    const bridgeKeys = new Set<string>();
    for (const w of this.roads.ways.values()) if (w.bridge && !w.tunnel) { bridges.push(w); for (const k of w.keys) bridgeKeys.add(k); }
    const ramps = new Set<number>();
    const len = new Map<number, number>();
    const L = (w: Way) => { let v = len.get(w.id); if (v === undefined) { v = wayLength(w); len.set(w.id, v); } return v; };
    // Expressway approaches (motorway / motorway_link without a bridge tag) out from each
    // bridge end, up to RAMP_MAX_LEN of road; for other roads only short untagged gaps
    // between two bridges.
    const reach = new Map<string, number>(); // key -> road length already walked from a bridge
    let front: string[] = [];
    for (const w of bridges) if (w.cls <= 1) for (const k of [w.keys[0], w.keys[w.n - 1]]) if (!reach.has(k)) { reach.set(k, 0); front.push(k); }
    while (front.length) {
      const next: string[] = [];
      for (const key of front) for (const w of atKey.get(key) ?? []) {
        if (w.bridge || w.cls > 1 || ramps.has(w.id)) continue;
        const r = reach.get(key)! + L(w);
        if (r > RAMP_MAX_LEN) continue;
        ramps.add(w.id);
        for (const k of [w.keys[0], w.keys[w.n - 1]]) if (!reach.has(k) || reach.get(k)! > r) { reach.set(k, r); next.push(k); }
      }
      front = next;
    }
    for (const w of this.roads.ways.values()) {
      if (w.bridge || w.tunnel || ramps.has(w.id) || w.cls > 3) continue;
      if (bridgeKeys.has(w.keys[0]) && bridgeKeys.has(w.keys[w.n - 1]) && L(w) < GAP_MAX_LEN) ramps.add(w.id);
    }
    this.rampIds = ramps;
    this.graph = bridges;
    for (const id of ramps) { const w = this.roads.ways.get(id); if (w) this.graph.push(w); }
    // keys where a road outside the solve joins it: that road is on the ground (a street,
    // a tunnel portal), so the deck has come down to street level there
    const inGraph = new Set<number>(), graphKeys = new Set<string>();
    for (const w of this.graph) { inGraph.add(w.id); for (const k of w.keys) graphKeys.add(k); }
    this.anchors = new Set<string>();
    for (const w of this.roads.ways.values()) {
      if (inGraph.has(w.id)) continue;
      for (const k of w.keys) if (graphKeys.has(k)) this.anchors.add(k);
    }
  }

  /**
   * Surfaces of loaded bridge models below (x, z) that could be this way's deck, top first.
   * An ordinary road's bridge is at most a few metres above its own layer guess: a deck
   * higher than that belongs to an expressway crossing over it, and must not be taken as its own.
   */
  private hits(x: number, z: number, w: Way): number[] {
    const g = this.terrain.heightAt(x, z);
    const top = w.cls <= 1 ? 130 : guess(w) + 6;
    return this.tiles.castAll(x, g + 160, z, 161.5).filter((h) => h > g - 1.5 && h < g + top);
  }

  /** Fraction of the way (sampled every 15 m) with real bridge geometry under it. */
  private coverage(w: Way): number {
    if (!this.tiles.bridgeMeshCount) return 0;
    let hit = 0, total = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const len = Math.hypot(w.xs[k + 1] - w.xs[k], w.zs[k + 1] - w.zs[k]);
      const steps = Math.max(1, Math.round(len / 15));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const x = w.xs[k] + (w.xs[k + 1] - w.xs[k]) * t, z = w.zs[k] + (w.zs[k + 1] - w.zs[k]) * t;
        total++;
        if (this.hits(x, z, w).length) hit++;
      }
    }
    return total ? hit / total : 0;
  }

  /**
   * Fix the node heights of a way to the model's surface. Where decks are stacked (a
   * junction), the surface nearest to the way's own expected level is taken, following it
   * from node to node, not simply the topmost one.
   */
  private adoptModel(w: Way, partial = false): void {
    const changed = new Set<string>();
    let prev = NaN;
    for (let k = 0; k < w.n; k++) {
      const key = w.keys[k];
      // measured once, kept: two ways sharing a node must agree on it (and re-measuring from
      // each side in turn would make them rebuild each other forever)
      if (this.modelKeys.has(key)) { prev = this.nodeY.get(key)! - MODEL_LIFT; continue; }
      const hs = this.hits(w.xs[k], w.zs[k], w);
      if (!hs.length) { prev = NaN; continue; }
      const g = this.terrain.heightAt(w.xs[k], w.zs[k]);
      // where a street joins, the way is at street level: a deck high above is another road
      if (this.anchors.has(key)) {
        const low = hs[hs.length - 1];
        if (low > g + 3) { prev = NaN; continue; }
      }
      const expect = prev === prev ? prev : this.anchors.has(key) ? g : g + guess(w);
      let h = hs[0];
      for (const v of hs) if (Math.abs(v - expect) < Math.abs(h - expect)) h = v;
      // a partly covered way: only trust hits that look like this way's own deck
      if (partial && prev === prev && Math.abs(h - prev) > 2.5 + 0.15 * Math.hypot(w.xs[k] - w.xs[k - 1], w.zs[k] - w.zs[k - 1])) { prev = NaN; continue; }
      prev = h;
      const old = this.nodeY.get(key);
      if (old === undefined || Math.abs(old - h - MODEL_LIFT) > 0.25) changed.add(key);
      this.nodeY.set(key, h + MODEL_LIFT); this.modelKeys.add(key);
    }
    if (!changed.size) return;
    // procedural neighbours that disagree with the measured heights are solved again
    for (const [id, d] of this.decks) {
      if (d.covered || !d.built || d.way.id === w.id || !d.way.keys.some((key) => changed.has(key))) continue;
      this.forget(id, d);
    }
    this.roadsVersion = -1;
  }

  /** Segments of a partly covered way where the model already provides the deck. */
  private modelSegments(w: Way, ys: Float64Array): Uint8Array | null {
    let any = false;
    const skip = new Uint8Array(Math.max(0, w.n - 1));
    for (let k = 0; k < w.n - 1; k++) {
      if (!this.modelKeys.has(w.keys[k]) || !this.modelKeys.has(w.keys[k + 1])) continue;
      const x = (w.xs[k] + w.xs[k + 1]) / 2, z = (w.zs[k] + w.zs[k + 1]) / 2, y = (ys[k] + ys[k + 1]) / 2;
      if (this.hits(x, z, w).some((h) => Math.abs(h + MODEL_LIFT - y) < 1.5)) { skip[k] = 1; any = true; }
    }
    return any ? skip : null;
  }

  private disposeMesh(d: Deck): void {
    if (!d.mesh) return;
    this.group.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh = null;
  }

  /**
   * Node heights for a batch of bridges and approaches, solved over the whole connected
   * network: fixed nodes (model, earlier decks) and ground anchors (where a street joins)
   * bound each node to the maximum grade; bridges want their guessed height, approaches
   * want the ground; then any remaining over-steep step is spread out along the approach.
   */
  private solveHeights(batch: Way[]): Map<number, Float64Array> {
    // a fixed height only reaches a few hundred metres at MAX_GRADE: solve around the batch
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const w of batch) { x0 = Math.min(x0, w.minX); z0 = Math.min(z0, w.minZ); x1 = Math.max(x1, w.maxX); z1 = Math.max(z1, w.maxZ); }
    const M = 900;
    const graph = this.graph.filter((w) => w.maxX > x0 - M && w.minX < x1 + M && w.maxZ > z0 - M && w.minZ < z1 + M);
    const anchors = this.anchors;
    const upper = new Map<string, number>(), lower = new Map<string, number>(), desired = new Map<string, number>();
    const fixedKeys = new Set<string>();
    for (const w of graph) {
      const ramp = this.rampIds.has(w.id);
      const cov = this.decks.get(w.id)?.covered;
      for (let k = 0; k < w.n; k++) {
        const key = w.keys[k];
        const g = this.terrain.heightAt(w.xs[k], w.zs[k]);
        // a street junction is at street level, unless a real model says otherwise
        const fixed = anchors.has(key) && !this.modelKeys.has(key) ? undefined : this.nodeY.get(key);
        if (fixed !== undefined) { upper.set(key, fixed); lower.set(key, fixed); desired.set(key, fixed); fixedKeys.add(key); }
        else if (fixedKeys.has(key)) continue;
        else if (anchors.has(key)) { const sg = this.streetAt(key, w.xs[k], w.zs[k]); upper.set(key, sg); lower.set(key, sg); desired.set(key, sg); fixedKeys.add(key); }
        else if (cov) continue;
        else {
          const want = ramp ? g : g + guess(w);
          desired.set(key, Math.max(desired.get(key) ?? -Infinity, want));
        }
      }
    }
    const edges: [string, string, number][] = [];
    for (const w of graph) for (let k = 0; k < w.n - 1; k++) {
      const d = Math.hypot(w.xs[k + 1] - w.xs[k], w.zs[k + 1] - w.zs[k]);
      if (d > 0.01) edges.push([w.keys[k], w.keys[k + 1], d * MAX_GRADE]);
    }
    // grade bounds out from the fixed nodes
    for (let pass = 0; pass < 80; pass++) {
      let changed = false;
      for (const [ka, kb, d] of edges) for (const [a, b] of [[ka, kb], [kb, ka]]) {
        if (fixedKeys.has(b)) continue; // a fixed height is not moved by its neighbours
        const ua = upper.get(a), la = lower.get(a);
        if (ua !== undefined && ua + d < (upper.get(b) ?? Infinity) - 1e-3) { upper.set(b, ua + d); changed = true; }
        if (la !== undefined && la - d > (lower.get(b) ?? -Infinity) + 1e-3) { lower.set(b, la - d); changed = true; }
      }
      if (!changed) break;
    }
    // Where two fixed heights are too far apart for the grade (a measured deck right next to
    // a street junction), the nodes between them cannot satisfy both: they are interpolated
    // below, a steeper ramp instead of a step.
    const h = new Map<string, number>(), conflict = new Set<string>();
    for (const [key, want] of desired) {
      const lo = lower.get(key) ?? -Infinity, hi = upper.get(key) ?? Infinity;
      if (lo > hi) { conflict.add(key); h.set(key, (lo + hi) / 2); }
      else h.set(key, Math.max(Math.min(want, hi), lo));
    }
    // spread steps: a node may not sit lower than its neighbour minus the grade (the deck
    // comes down along the approach, not in one segment); bounded by the anchors above
    for (let pass = 0; pass < 120; pass++) {
      let changed = false;
      for (const [ka, kb, d] of edges) for (const [a, b] of [[ka, kb], [kb, ka]]) {
        if (fixedKeys.has(b) || conflict.has(b)) continue;
        const ha = h.get(a), hb = h.get(b);
        if (ha === undefined || hb === undefined) continue;
        const want = Math.min(ha - d, upper.get(b) ?? Infinity);
        if (want > hb + 1e-3) { h.set(b, want); changed = true; }
      }
      if (!changed) break;
    }
    if (conflict.size) {
      // distance-weighted averaging with the fixed ends held: converges to a straight ramp
      const nb = new Map<string, [string, number][]>();
      for (const [ka, kb, d] of edges) {
        if (conflict.has(ka)) { const a = nb.get(ka) ?? []; a.push([kb, d]); nb.set(ka, a); }
        if (conflict.has(kb)) { const a = nb.get(kb) ?? []; a.push([ka, d]); nb.set(kb, a); }
      }
      for (let it = 0; it < 150; it++) for (const key of conflict) {
        let sw = 0, sv = 0;
        for (const [o, d] of nb.get(key) ?? []) { const v = h.get(o); if (v === undefined) continue; sw += 1 / d; sv += v / d; }
        if (sw) h.set(key, sv / sw);
      }
    }
    const out = new Map<number, Float64Array>();
    for (const w of batch) {
      const ys = new Float64Array(w.n);
      let ok = true;
      for (let k = 0; k < w.n; k++) {
        const v = h.get(w.keys[k]);
        if (v === undefined) { ok = false; break; }
        ys[k] = v;
      }
      if (!ok) continue;
      // light smoothing of free interior nodes so the deck does not mirror terrain bumps
      for (let it = 0; it < 3; it++) for (let k = 1; k < w.n - 1; k++) {
        if (fixedKeys.has(w.keys[k])) continue;
        const v = (ys[k - 1] + 2 * ys[k] + ys[k + 1]) / 4;
        ys[k] = Math.max(v, this.terrain.heightAt(w.xs[k], w.zs[k]));
      }
      if (this.nodeY.size > 200000) { for (const key of this.nodeY.keys()) if (!this.modelKeys.has(key)) this.nodeY.delete(key); }
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
    const L: number[][] = [], R: number[][] = [], G: number[] = [];
    for (let k = 0; k < w.n; k++) {
      const p = Math.max(0, k - 1), n = Math.min(w.n - 1, k + 1);
      let dx = w.xs[n] - w.xs[p], dz = w.zs[n] - w.zs[p];
      const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
      const rx = -dz, rz = dx; // right of travel direction
      L.push([w.xs[k] - rx * hw - ox, d.ys[k], w.zs[k] - rz * hw - oz]);
      R.push([w.xs[k] + rx * hw - ox, d.ys[k], w.zs[k] + rz * hw - oz]);
      G.push(this.terrain.heightAt(w.xs[k], w.zs[k]) - 0.5);
    }
    const dn = (p: number[], by: number) => [p[0], p[1] - by, p[2]];
    const up = (p: number[], by: number) => [p[0], p[1] + by, p[2]];
    const at = (p: number[], y: number) => [p[0], y, p[2]];
    let run = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const l0 = L[k], l1 = L[k + 1], r0 = R[k], r1 = R[k + 1];
      const sx = w.xs[k], sz = w.zs[k], ex = w.xs[k + 1], ez = w.zs[k + 1];
      const len = Math.hypot(ex - sx, ez - sz);
      if (d.skip?.[k] || (d.ramp && d.ys[k] - G[k] < 0.85 && d.ys[k + 1] - G[k + 1] < 0.85)) { run = (run + len) % PILLAR_EVERY; continue; }
      quad(dn(l0, 0.14), dn(r0, 0.14), dn(r1, 0.14), dn(l1, 0.14), 0.075, 0.078, 0.085); // deck top, below the paved road ribbon
      if (d.ramp) {
        // an approach: retaining walls down to the ground instead of a slab on pillars
        quad(up(l0, RAIL_H), at(l0, G[k]), at(l1, G[k + 1]), up(l1, RAIL_H), 0.36, 0.35, 0.33);
        quad(up(r0, RAIL_H), up(r1, RAIL_H), at(r1, G[k + 1]), at(r0, G[k]), 0.36, 0.35, 0.33);
      } else {
        quad(dn(l0, THICK), dn(l1, THICK), dn(r1, THICK), dn(r0, THICK), 0.2, 0.2, 0.2); // underside
        quad(up(l0, RAIL_H), dn(l0, THICK), dn(l1, THICK), up(l1, RAIL_H), 0.33, 0.33, 0.32); // left side + rail (outer)
        quad(up(r0, RAIL_H), up(r1, RAIL_H), dn(r1, THICK), dn(r0, THICK), 0.33, 0.33, 0.32);
      }
      quad(up(l0, RAIL_H), up(l1, RAIL_H), l1, l0, 0.4, 0.4, 0.39);      // left rail (inner)
      quad(up(r0, RAIL_H), r0, r1, up(r1, RAIL_H), 0.4, 0.4, 0.39);
      // pillars
      let at2 = PILLAR_EVERY - run;
      while (!d.ramp && at2 < len) {
        const t = at2 / len, px = sx + (ex - sx) * t, pz = sz + (ez - sz) * t, top = d.ys[k] + (d.ys[k + 1] - d.ys[k]) * t - THICK;
        const g = this.terrain.heightAt(px, pz) - 1;
        if (top - g > 3.5) {
          const s = Math.min(1.1, hw * 0.35), x = px - ox, z = pz - oz;
          const c = [[x - s, z - s], [x + s, z - s], [x + s, z + s], [x - s, z + s]];
          for (let i = 0; i < 4; i++) {
            const a = c[i], b = c[(i + 1) % 4];
            quad([a[0], top, a[1]], [a[0], g, a[1]], [b[0], g, b[1]], [b[0], top, b[1]], 0.3, 0.3, 0.29);
          }
        }
        at2 += PILLAR_EVERY;
      }
      run = (run + len) % PILLAR_EVERY;
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.material.side = THREE.DoubleSide;
    mesh.position.set(ox, 0, oz); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.name = 'deck ' + w.id; mesh.castShadow = true; mesh.receiveShadow = true;
    d.mesh = mesh; this.group.add(mesh);
  }

  // DeckProvider: analytic surface lookup on the profiles (no raycast needed).
  deckHeight(x: number, z: number, maxY: number): number {
    let best = -Infinity;
    for (const d of this.decks.values()) {
      if (!d.built) continue;
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

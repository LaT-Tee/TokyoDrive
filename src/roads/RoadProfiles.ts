// The drivable surface of every mapped street. The rule: where OpenStreetMap has a road,
// the road is drivable - no walls, no pits, no spikes, no breaks - whatever the elevation
// model, a tunnel portal or a stray building edge say.
//
// Each ground-level way (not a bridge, tunnel or lifted approach - those have their own
// surfaces) is sampled every 2 m along its centreline. The raw height is the terrain, or a
// low real deck the street actually sits on (PLATEAU models a few street-level structures
// that the elevation model does not have). Then:
//   1. a running median removes spikes and pits narrower than ~16 m,
//   2. junctions are shared: every node keeps the height first given to it, so streets meet
//      exactly, and a street joining a deck meets the deck,
//   3. no point may sit lower than its neighbour minus MAX_GRADE: a step becomes a ramp,
//      a pit is filled; heights are bounded by the fixed nodes at the same grade,
//   4. a light smoothing pass.
// Ground uses this inside a street's carriageway; RoadSurface paves the same heights, so
// what you see is what you drive on.
import type { Roads, Way } from '../world/Roads';
import type { Terrain } from '../world/Terrain';
import type { TilesManager } from '../tiles/TilesManager';

const STEP = 2;           // m between samples
const CELL = 16;          // m, lookup grid
const MAX_GRADE = 0.15;
const MEDIAN = 4;         // samples each side
const BUILD_RANGE = 900;
const DROP_RANGE = 1400;
const MARGIN = 0.6;       // m beyond the half width that still counts as the street
const LOW_DECK = 2.5;     // m: a real deck this close above the terrain is the street itself

interface Profile {
  way: Way; n: number; hw: number;
  xs: Float64Array; zs: Float64Array; s: Float64Array; ys: Float32Array;
  nodeAt: Int32Array; // dense index of each OSM node
  cells: string[];
}

export class RoadProfiles {
  private profiles = new Map<number, Profile>();
  private grid = new Map<string, [Profile, number][]>();
  private nodeH = new Map<string, number>();
  private lastBuild = 0;
  /** Bumped when profiles are added or removed. */
  version = 0;
  /** Height the elevated-deck solver gave a node (a street meeting a deck meets it there). */
  deckNode: ((key: string) => number) | null = null;
  /** Node heights of a way that has a deck of its own (a lifted approach): that deck is its surface. */
  deckOf: ((id: number) => Float64Array | null) | null = null;

  constructor(private roads: Roads, private terrain: Terrain, private tiles: TilesManager) {}

  get count(): number { return this.profiles.size; }

  /** Street height at a node, if a street profile has fixed it. */
  nodeHeight(key: string): number { const v = this.nodeH.get(key); return v === undefined ? NaN : v; }

  update(x: number, z: number): void {
    if (!this.roads.enabled) return;
    for (const [id, p] of this.profiles) {
      const w = p.way;
      if (!this.roads.ways.has(id) || x < w.minX - DROP_RANGE || x > w.maxX + DROP_RANGE || z < w.minZ - DROP_RANGE || z > w.maxZ + DROP_RANGE) this.remove(id, p);
    }
    const now = performance.now();
    if (now - this.lastBuild < 150) return;
    this.lastBuild = now;
    // nearest first, within a few ms per tick
    const todo: [Way, number][] = [];
    for (const w of this.roads.ways.values()) {
      if (w.bridge || w.tunnel || this.profiles.has(w.id)) continue;
      const d = Math.max(0, w.minX - x, x - w.maxX) + Math.max(0, w.minZ - z, z - w.maxZ);
      if (d < BUILD_RANGE) todo.push([w, d]);
    }
    todo.sort((a, b) => a[1] - b[1]);
    for (const [w] of todo) {
      if (performance.now() - now > 4) break;
      this.build(w);
    }
  }

  private remove(id: number, p: Profile): void {
    for (const c of p.cells) {
      const a = this.grid.get(c);
      if (!a) continue;
      const b = a.filter((e) => e[0] !== p);
      if (b.length) this.grid.set(c, b); else this.grid.delete(c);
    }
    this.profiles.delete(id);
    // node heights stay while another loaded profile uses the node
    this.version++;
  }

  private build(w: Way): void {
    for (let k = 0; k < w.n; k++) if (!this.terrain.isReady(w.xs[k], w.zs[k])) return;
    // dense centreline
    const xs: number[] = [], zs: number[] = [], ss: number[] = [];
    const nodeAt = new Int32Array(w.n);
    let s = 0;
    for (let k = 0; k < w.n - 1; k++) {
      const ax = w.xs[k], az = w.zs[k], bx = w.xs[k + 1], bz = w.zs[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      nodeAt[k] = xs.length;
      const parts = Math.max(1, Math.ceil(len / STEP));
      for (let i = 0; i < parts; i++) { const t = i / parts; xs.push(ax + (bx - ax) * t); zs.push(az + (bz - az) * t); ss.push(s + len * t); }
      s += len;
    }
    nodeAt[w.n - 1] = xs.length;
    xs.push(w.xs[w.n - 1]); zs.push(w.zs[w.n - 1]); ss.push(s);
    const n = xs.length;
    // raw: terrain, or a low real deck the street sits on
    const raw = new Float64Array(n);
    const decks = this.tiles.bridgeMeshCount > 0;
    for (let i = 0; i < n; i++) {
      const g = this.terrain.heightAt(xs[i], zs[i]);
      let h = g;
      if (decks) for (const v of this.tiles.castAll(xs[i], g + LOW_DECK + 0.5, zs[i], LOW_DECK + 2)) if (v > h && v < g + LOW_DECK) h = v;
      raw[i] = h;
    }
    // 1. running median
    const ys = new Float64Array(n), win: number[] = [];
    for (let i = 0; i < n; i++) {
      win.length = 0;
      for (let j = Math.max(0, i - MEDIAN); j <= Math.min(n - 1, i + MEDIAN); j++) win.push(raw[j]);
      win.sort((a, b) => a - b);
      ys[i] = win[win.length >> 1];
    }
    // 2. fixed heights at the nodes other streets or decks already gave
    const fixed = new Float64Array(n).fill(NaN);
    for (let k = 0; k < w.n; k++) {
      const key = w.keys[k];
      let v = this.nodeH.get(key);
      if (v === undefined && this.deckNode) { const d = this.deckNode(key); if (d === d) v = d; }
      if (v !== undefined) fixed[nodeAt[k]] = v;
    }
    // 3. grade bounds from the fixed points, then no point lower than a neighbour minus the grade
    const lo = new Float64Array(n).fill(-Infinity), hi = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) if (fixed[i] === fixed[i]) { lo[i] = hi[i] = fixed[i]; }
    for (let i = 1; i < n; i++) { const d = (ss[i] - ss[i - 1]) * MAX_GRADE; if (fixed[i] !== fixed[i]) { lo[i] = Math.max(lo[i], lo[i - 1] - d); hi[i] = Math.min(hi[i], hi[i - 1] + d); } }
    for (let i = n - 2; i >= 0; i--) { const d = (ss[i + 1] - ss[i]) * MAX_GRADE; if (fixed[i] !== fixed[i]) { lo[i] = Math.max(lo[i], lo[i + 1] - d); hi[i] = Math.min(hi[i], hi[i + 1] + d); } }
    const conflict = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (lo[i] > hi[i]) { conflict[i] = 1; ys[i] = (lo[i] + hi[i]) / 2; }
      else ys[i] = Math.max(lo[i], Math.min(hi[i], ys[i]));
    }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n; i++) if (fixed[i] !== fixed[i] && !conflict[i]) ys[i] = Math.max(ys[i], Math.min(hi[i], ys[i - 1] - (ss[i] - ss[i - 1]) * MAX_GRADE));
      for (let i = n - 2; i >= 0; i--) if (fixed[i] !== fixed[i] && !conflict[i]) ys[i] = Math.max(ys[i], Math.min(hi[i], ys[i + 1] - (ss[i + 1] - ss[i]) * MAX_GRADE));
    }
    // 4. light smoothing (also straightens over-constrained stretches between fixed points)
    for (let it = 0; it < (conflict.some((c) => c) ? 60 : 3); it++) {
      for (let i = 1; i < n - 1; i++) {
        if (fixed[i] === fixed[i]) continue;
        const v = (ys[i - 1] + 2 * ys[i] + ys[i + 1]) / 4;
        ys[i] = conflict[i] ? v : Math.max(lo[i], Math.min(hi[i], v));
      }
    }
    for (let k = 0; k < w.n; k++) if (!this.nodeH.has(w.keys[k])) this.nodeH.set(w.keys[k], ys[nodeAt[k]]);
    if (this.nodeH.size > 400000) this.nodeH.clear();
    const p: Profile = {
      way: w, n, hw: w.width / 2, xs: Float64Array.from(xs), zs: Float64Array.from(zs), s: Float64Array.from(ss),
      ys: Float32Array.from(ys), nodeAt, cells: [],
    };
    // lookup grid: every segment in the cells its corridor touches
    const m = p.hw + MARGIN, cells = new Set<string>();
    for (let i = 0; i < n - 1; i++) {
      const x0 = Math.floor((Math.min(xs[i], xs[i + 1]) - m) / CELL), x1 = Math.floor((Math.max(xs[i], xs[i + 1]) + m) / CELL);
      const z0 = Math.floor((Math.min(zs[i], zs[i + 1]) - m) / CELL), z1 = Math.floor((Math.max(zs[i], zs[i + 1]) + m) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const key = cx + ',' + cz;
        let a = this.grid.get(key);
        if (!a) { a = []; this.grid.set(key, a); }
        a.push([p, i]); cells.add(key);
      }
    }
    p.cells = [...cells];
    this.profiles.set(w.id, p);
    this.version++;
  }

  /**
   * Street surface at (x, z) for a vehicle at refY: the height of the street whose
   * carriageway contains the point (the one nearest the vehicle's height where streets
   * overlap), or NaN off the streets and for a vehicle far above or below them.
   */
  heightAt(x: number, z: number, refY: number): number {
    const a = this.grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL));
    if (!a) return NaN;
    let best = NaN, bd = 4;
    for (const [p, i] of a) {
      const ax = p.xs[i], az = p.zs[i], dx = p.xs[i + 1] - ax, dz = p.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      if (Math.hypot(ax + dx * t - x, az + dz * t - z) > p.hw + MARGIN) continue;
      // a lifted approach: its deck is the street (even where it dips below the terrain)
      const deck = this.deckOf ? this.deckOf(p.way.id) : null;
      const y = deck ? this.onDeck(p, deck, p.s[i] + (p.s[i + 1] - p.s[i]) * t) : p.ys[i] + (p.ys[i + 1] - p.ys[i]) * t;
      const d = Math.abs(y - refY);
      if (d < bd) { bd = d; best = y; }
    }
    return best;
  }

  private onDeck(p: Profile, ys: Float64Array, s: number): number {
    let lo = 0, hi = p.way.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.s[p.nodeAt[m]] <= s) lo = m; else hi = m; }
    const s0 = p.s[p.nodeAt[lo]], s1 = p.s[p.nodeAt[hi]];
    return ys[lo] + (ys[hi] - ys[lo]) * Math.max(0, Math.min(1, (s - s0) / Math.max(1e-6, s1 - s0)));
  }

  /** Street height along a way at arc length s (NaN until its profile is built). */
  alongWay(id: number, s: number): number {
    const p = this.profiles.get(id);
    if (!p) return NaN;
    if (s <= 0) return p.ys[0];
    if (s >= p.s[p.n - 1]) return p.ys[p.n - 1];
    let lo = 0, hi = p.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.s[m] <= s) lo = m; else hi = m; }
    const t = (s - p.s[lo]) / Math.max(1e-6, p.s[hi] - p.s[lo]);
    return p.ys[lo] + (p.ys[hi] - p.ys[lo]) * t;
  }

  has(id: number): boolean { return this.profiles.has(id); }
}

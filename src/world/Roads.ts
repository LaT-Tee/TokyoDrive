// OSM road metadata baked by scripts/osm.mjs into data/osm/{z}/{x}/{y}.json.
// Used for road names (HUD), recover (nearest centreline) and the procedural
// elevated-deck fallback. Never used for driving logic. (CLAUDE.md §2)
import { frame, latToTileY, lonToTileX } from '../geo/geodesy';

export interface Way {
  id: number; cls: number; name: string;
  bridge: boolean; tunnel: boolean; layer: number; width: number;
  n: number; xs: Float64Array; zs: Float64Array; keys: string[]; // node coordinate keys for connectivity
  minX: number; maxX: number; minZ: number; maxZ: number;
}
interface RawWay { i: number; c: number; n?: string; b?: 1; t?: 1; l?: number; w: number; p: number[] }

export interface NearestRoad { x: number; z: number; heading: number; bridge: boolean; name: string; dist: number }

const REF_H = 60; // nominal ellipsoidal ground height used when projecting OSM nodes

export class Roads {
  private tiles = new Map<string, Way[] | null>(); // null = loading
  readonly ways = new Map<number, Way>();
  private refs = new Map<number, number>();
  version = 0; // bumped whenever the set of loaded ways changes
  private nameCache = { x: 1e9, z: 1e9, name: '' };

  constructor(private cfg: { zoom: number; tiles: Set<string>; base: string } | null) {}

  get enabled(): boolean { return !!this.cfg; }

  private tileOf(x: number, z: number): [number, number] {
    const g = frame.localToLla(x, REF_H, z);
    return [Math.floor(lonToTileX(g.lon, this.cfg!.zoom)), Math.floor(latToTileY(g.lat, this.cfg!.zoom))];
  }

  hasData(x: number, z: number): boolean {
    if (!this.cfg) return false;
    const [tx, ty] = this.tileOf(x, z);
    return !!this.tiles.get(tx + '/' + ty);
  }

  update(x: number, z: number): void {
    if (!this.cfg) return;
    const [cx, cy] = this.tileOf(x, z);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = cx + dx + '/' + (cy + dy);
      if (this.tiles.has(key) || !this.cfg.tiles.has(key)) continue;
      this.tiles.set(key, null);
      void this.load(key);
    }
    for (const [key, ways] of this.tiles) {
      if (!ways) continue;
      const [tx, ty] = key.split('/').map(Number);
      if (Math.abs(tx - cx) <= 2 && Math.abs(ty - cy) <= 2) continue;
      this.tiles.delete(key);
      for (const w of ways) {
        const r = (this.refs.get(w.id) ?? 1) - 1;
        if (r <= 0) { this.refs.delete(w.id); this.ways.delete(w.id); } else this.refs.set(w.id, r);
      }
      this.version++;
    }
  }

  private async load(key: string): Promise<void> {
    try {
      const r = await fetch(`${this.cfg!.base}/${this.cfg!.zoom}/${key}.json`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const raw = (await r.json()) as { ways: RawWay[] };
      const out: Way[] = [];
      const p = { x: 0, y: 0, z: 0 };
      for (const rw of raw.ways) {
        let w = this.ways.get(rw.i);
        if (!w) {
          const n = rw.p.length / 2;
          const xs = new Float64Array(n), zs = new Float64Array(n), keys: string[] = [];
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let k = 0; k < n; k++) {
            frame.llaToLocal(rw.p[k * 2], rw.p[k * 2 + 1], REF_H, p);
            xs[k] = p.x; zs[k] = p.z; keys.push(rw.p[k * 2] + ',' + rw.p[k * 2 + 1]);
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
          }
          w = { id: rw.i, cls: rw.c, name: rw.n ?? '', bridge: !!rw.b, tunnel: !!rw.t, layer: rw.l ?? (rw.b ? 1 : 0), width: rw.w, n, xs, zs, keys, minX, maxX, minZ, maxZ };
          this.ways.set(rw.i, w);
        }
        this.refs.set(rw.i, (this.refs.get(rw.i) ?? 0) + 1);
        out.push(w);
      }
      this.tiles.set(key, out);
      this.version++;
    } catch (e) {
      console.warn('[roads] tile failed', key, e);
      this.tiles.delete(key);
      this.cfg!.tiles.delete(key); // do not retry forever
    }
  }

  /** Nearest point on any (non-tunnel) road centreline within maxDist. */
  nearest(x: number, z: number, maxDist: number): NearestRoad | null {
    let best: NearestRoad | null = null, bd = maxDist;
    for (const w of this.ways.values()) {
      if (w.tunnel || x < w.minX - bd || x > w.maxX + bd || z < w.minZ - bd || z > w.maxZ + bd) continue;
      for (let k = 0; k < w.n - 1; k++) {
        const ax = w.xs[k], az = w.zs[k], dx = w.xs[k + 1] - ax, dz = w.zs[k + 1] - az;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(px - x, pz - z);
        if (d < bd) { bd = d; best = { x: px, z: pz, heading: Math.atan2(dx, -dz), bridge: w.bridge, name: w.name, dist: d }; }
      }
    }
    return best;
  }

  nameAt(x: number, z: number): string {
    const c = this.nameCache;
    if (Math.hypot(x - c.x, z - c.z) < 8) return c.name;
    c.x = x; c.z = z;
    c.name = this.nearest(x, z, 30)?.name ?? '';
    return c.name;
  }
}

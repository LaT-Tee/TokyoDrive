// Surveyed road edges from the Geospatial Information Authority of Japan:
// the `experimental_fgd` vector tiles (基盤地図情報, zoom 18, public, no key)
// carry the real road boundary lines (RdEdg 道路縁) and the lines that divide a
// road (RdCompt 道路構成線: sidewalk kerbs, medians). The vector road layer
// fits each carriageway between these instead of guessing a width from OSM.
import { frame, latToTileY, lonToTileX } from '../geo/geodesy';

const Z = 18;
const REF_H = 60; // same nominal height the OSM centrelines are projected with
export const GSI_ROAD_EDGE_TILES = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_fgd/{z}/{x}/{y}.geojson';

type Tile = Float32Array | null; // segments as [ax, az, bx, bz, ...]; null = unavailable

export class RoadEdges {
  private tiles = new Map<string, Tile | 'loading'>();
  private active = 0;
  private queue: string[] = [];
  loaded = 0; failed = 0;

  constructor(private templates: string[] = [GSI_ROAD_EDGE_TILES]) {}

  private range(minX: number, minZ: number, maxX: number, maxZ: number): [number, number, number, number] {
    // local +Z is south: (minX, minZ) is the north-west corner
    const nw = frame.localToLla(minX, REF_H, minZ), se = frame.localToLla(maxX, REF_H, maxZ);
    return [Math.floor(lonToTileX(nw.lon, Z)), Math.floor(latToTileY(nw.lat, Z)), Math.floor(lonToTileX(se.lon, Z)), Math.floor(latToTileY(se.lat, Z))];
  }

  /** True once every edge tile overlapping the box is loaded (or known to be missing); starts loading the rest. */
  ready(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    const [x0, y0, x1, y1] = this.range(minX, minZ, maxX, maxZ);
    let ok = true;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = x + '/' + y, t = this.tiles.get(key);
      if (t === undefined) { this.tiles.set(key, 'loading'); this.queue.push(key); ok = false; }
      else if (t === 'loading') ok = false;
    }
    this.pump();
    return ok;
  }

  /** Segment arrays of every loaded tile overlapping the box. */
  collect(minX: number, minZ: number, maxX: number, maxZ: number): Float32Array[] {
    const [x0, y0, x1, y1] = this.range(minX, minZ, maxX, maxZ), out: Float32Array[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const t = this.tiles.get(x + '/' + y);
      if (t && t !== 'loading' && t.length) out.push(t);
    }
    return out;
  }

  /** Distance from (x, z) along the unit direction (dx, dz) to the nearest edge line, or NaN within `max`. */
  static ray(sets: Float32Array[], x: number, z: number, dx: number, dz: number, max: number): number {
    let best = max;
    const ex = x + dx * max, ez = z + dz * max;
    const loX = Math.min(x, ex), hiX = Math.max(x, ex), loZ = Math.min(z, ez), hiZ = Math.max(z, ez);
    for (const s of sets) for (let i = 0; i < s.length; i += 4) {
      const ax = s[i], az = s[i + 1], bx = s[i + 2], bz = s[i + 3];
      if ((ax < loX && bx < loX) || (ax > hiX && bx > hiX) || (az < loZ && bz < loZ) || (az > hiZ && bz > hiZ)) continue;
      const sx = bx - ax, sz = bz - az, den = dx * sz - dz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - x) * sz - (az - z) * sx) / den;   // along the ray
      const u = ((ax - x) * dz - (az - z) * dx) / den;   // along the segment
      if (t > 0.05 && t < best && u >= -0.02 && u <= 1.02) best = t;
    }
    return best < max ? best : NaN;
  }

  private pump(): void {
    while (this.active < 6 && this.queue.length) {
      const key = this.queue.shift()!;
      this.active++;
      void this.load(key).finally(() => { this.active--; this.pump(); });
    }
    // bound memory: forget the oldest tiles (they reload on demand)
    if (this.tiles.size > 900) for (const k of this.tiles.keys()) { if (this.tiles.size <= 700) break; if (this.tiles.get(k) !== 'loading') this.tiles.delete(k); }
  }

  private async load(key: string): Promise<void> {
    const [x, y] = key.split('/');
    for (const tpl of this.templates) {
      try {
        const r = await fetch(tpl.replace('{z}', String(Z)).replace('{x}', x).replace('{y}', y));
        if (r.status === 404) continue;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = (await r.json()) as { features: { geometry: { type: string; coordinates: any }; properties: { class?: string } }[] };
        const seg: number[] = [], p = { x: 0, y: 0, z: 0 };
        for (const f of j.features) {
          const c = f.properties.class;
          if (c !== 'RdEdg' && c !== 'RdCompt') continue;
          const lines: number[][][] = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
          for (const line of lines) {
            let px = 0, pz = 0;
            for (let k = 0; k < line.length; k++) {
              frame.llaToLocal(line[k][1], line[k][0], REF_H, p);
              if (k > 0) seg.push(px, pz, p.x, p.z);
              px = p.x; pz = p.z;
            }
          }
        }
        this.tiles.set(key, Float32Array.from(seg)); this.loaded++;
        return;
      } catch { /* try the next source */ }
    }
    this.tiles.set(key, null); this.failed++; // no survey data here: the road keeps its estimated width
  }
}

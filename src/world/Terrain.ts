// Ground = DEM heightfield chunks (one per z15 web-mercator tile, ~1 km)
// textured with ortho imagery, plus a low-resolution "safety ground" that
// spans the whole coverage area so a missing tile never shows void (§9.3).
import * as THREE from 'three';
import { frame, geoidHeight, latToTileY, lonToTileX, tileXToLon, tileYToLat } from '../geo/geodesy';

export interface TerrainSources {
  /** URL templates with {z}/{x}/{y}; tried in order. z15 5 m DEM (GSI PNG encoding). */
  dem: string[];
  /** z14 10 m DEM used to fill gaps in the 5 m DEM. */
  demFill: string[];
  /** Ortho imagery templates, tried in order (PLATEAU ortho first, GSI photo fallback). */
  ortho: string[];
}

const Z = 15;
const N = 128; // quads per chunk side -> 129 vertices
const V = N + 1;
const NA = -9999;

function fill(t: string, z: number, x: number, y: number): string {
  return t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

async function loadBitmap(urls: string[], z: number, x: number, y: number): Promise<ImageBitmap | null> {
  for (const t of urls) {
    try {
      const r = await fetch(fill(t, z, x, y));
      if (!r.ok) continue;
      const b = await r.blob();
      return await createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch { /* try next */ }
  }
  return null;
}

const scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : null;
function decodeDem(bmp: ImageBitmap): Float32Array {
  const ctx = scratch!.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 256, 256);
  ctx.drawImage(bmp, 0, 0, 256, 256);
  const d = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < 65536; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3];
    if (a === 0 || (r === 128 && g === 0 && b === 0)) { out[i] = NA; continue; }
    let v = r * 65536 + g * 256 + b;
    if (v >= 8388608) v -= 16777216;
    out[i] = v * 0.01;
  }
  return out;
}

/** Shared by every ground material: time (water animation) and the open-cut
 *  segments of tunnel ramps, where the ground must not be drawn. */
export const groundUniforms = {
  tdTime: { value: 0 },
  tdCutN: { value: 0 },
  tdCuts: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, // ax, az, bx, bz
  tdCutW: { value: new Float32Array(12) },                                    // half width
};
const noWater = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
noWater.needsUpdate = true;

/** Ground material: photo colour + close-up detail noise, animated water where the
 *  elevation model marks water, and discarded fragments over tunnel ramps. */
function groundMaterial(water: THREE.Texture | null): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0x8a8f86 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, groundUniforms, { tdWater: { value: water ?? noWater } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 tdWP; varying vec2 tdUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n tdWP = (modelMatrix * vec4(position, 1.0)).xyz; tdUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 tdWP; varying vec2 tdUv;
        uniform sampler2D tdWater; uniform float tdTime; uniform int tdCutN; uniform vec4 tdCuts[12]; uniform float tdCutW[12];
        float tdHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tdNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tdHash(i), tdHash(i + vec2(1, 0)), f.x), mix(tdHash(i + vec2(0, 1)), tdHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `
        for (int i = 0; i < 12; i++) {
          if (i >= tdCutN) break;
          vec2 a = tdCuts[i].xy, b = tdCuts[i].zw, ab = b - a;
          float t = clamp(dot(tdWP.xz - a, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
          if (distance(tdWP.xz, a + ab * t) < tdCutW[i]) discard;
        }
        #include <map_fragment>
        {
          float dist = distance(tdWP, cameraPosition);
          float near = 1.0 - smoothstep(25.0, 120.0, dist);
          // the photo is ~0.3-1 m per pixel: break up the blur close to the camera
          float fine = tdNoise(tdWP.xz * 9.0) * 0.6 + tdNoise(tdWP.xz * 31.0) * 0.4;
          float coarse = tdNoise(tdWP.xz * 0.9);
          float green = smoothstep(0.02, 0.10, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
          diffuseColor.rgb *= 1.0 + near * ((fine - 0.5) * (0.22 + 0.25 * green) + (coarse - 0.5) * 0.12);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.78, 1.0, 0.62), green * near * 0.35);
          float w = smoothstep(0.35, 0.65, texture2D(tdWater, tdUv).r);
          if (w > 0.0) {
            vec2 q = tdWP.xz * 0.12;
            float r1 = tdNoise(q + vec2(tdTime * 0.35, tdTime * 0.21)), r2 = tdNoise(q * 2.7 - vec2(tdTime * 0.27, tdTime * 0.4));
            float ripple = r1 * 0.6 + r2 * 0.4;
            vec3 deep = vec3(0.020, 0.060, 0.085), shallow = vec3(0.05, 0.13, 0.15);
            vec3 wc = mix(deep, shallow, ripple) + vec3(0.35, 0.38, 0.4) * pow(ripple, 7.0) * (0.4 + 0.6 * near);
            diffuseColor.rgb = mix(diffuseColor.rgb, wc, w);
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'td-ground';
  return mat;
}

interface Chunk {
  tx: number; ty: number; key: string;
  heights: Float32Array | null; // local Y at V x V vertices
  mesh: THREE.Mesh | null;
  water: THREE.DataTexture | null;   // 256x256 mask, 255 = water
  waterMask: Uint8Array | null;
  veg: Uint8Array | null;            // 256x256 classes from the photo: 0 none, 1 grass, 2 tree canopy
  texLevel: number; // zoom of the ortho currently applied (0 = none)
  texLoading: boolean;
  texWant: number; // level of the last attempt (avoids retry storms on partial coverage)
  disposed: boolean;
}

export class Terrain {
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private fillCache = new Map<string, Promise<Float32Array | null>>();
  private safety: { x0: number; y0: number; k: number; nx: number; ny: number; y: Float32Array } | null = null;
  private loading = 0;
  pendingChunks = 0;

  constructor(private sources: TerrainSources, private maxAniso = 4) {
    this.group.name = 'terrain';
  }

  // ---------------------------------------------------------------- queries
  private chunkAt(x: number, z: number, refY: number): { c: Chunk | undefined; u: number; v: number; lat: number; lon: number } {
    const g = frame.localToLla(x, refY, z);
    const fx = lonToTileX(g.lon, Z), fy = latToTileY(g.lat, Z);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    return { c: this.chunks.get(tx + '/' + ty), u: fx - tx, v: fy - ty, lat: g.lat, lon: g.lon };
  }

  /** Terrain height (local Y) at local (x, z). Falls back to the safety ground. */
  heightAt(x: number, z: number, refY = 40): number {
    const q = this.chunkAt(x, z, refY);
    const h = q.c?.heights;
    if (h) {
      const fu = q.u * N, fv = q.v * N;
      const iu = Math.min(Math.floor(fu), N - 1), iv = Math.min(Math.floor(fv), N - 1);
      const tu = fu - iu, tv = fv - iv, i = iv * V + iu;
      // same diagonal split as the render mesh (see buildMesh)
      if (tu + tv <= 1) return h[i] + (h[i + 1] - h[i]) * tu + (h[i + V] - h[i]) * tv;
      return h[i + V + 1] + (h[i + V] - h[i + V + 1]) * (1 - tu) + (h[i + 1] - h[i + V + 1]) * (1 - tv);
    }
    return this.safetyHeight(q.lat, q.lon) + 3;
  }

  /** True when the detailed chunk under (x, z) is loaded. */
  isReady(x: number, z: number, refY = 40): boolean { return !!this.chunkAt(x, z, refY).c?.heights; }

  private safetyHeight(lat: number, lon: number): number {
    const s = this.safety; if (!s) return 37;
    let fx = (lonToTileX(lon, 10) - s.x0) * s.k, fy = (latToTileY(lat, 10) - s.y0) * s.k;
    fx = Math.min(Math.max(fx, 0), s.nx - 1.001); fy = Math.min(Math.max(fy, 0), s.ny - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, i = iy * s.nx + ix;
    return (s.y[i] * (1 - tx) + s.y[i + 1] * tx) * (1 - ty) + (s.y[i + s.nx] * (1 - tx) + s.y[i + s.nx + 1] * tx) * ty;
  }

  // ----------------------------------------------------------------- update
  /** Ensure chunks within `radius` tiles of the given local position exist. */
  update(x: number, z: number, radius: number, refY = 40): void {
    const g = frame.localToLla(x, refY, z);
    const cx = Math.floor(lonToTileX(g.lon, Z)), cy = Math.floor(latToTileY(g.lat, Z));
    const want: [number, number, number][] = [];
    const fx = lonToTileX(g.lon, Z), fy = latToTileY(g.lat, Z);
    const tileM = 40075016.686 * Math.cos((g.lat * Math.PI) / 180) / 2 ** Z; // metres per tile here
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      // distance (m) from the car to this chunk's rectangle
      const ex = Math.max(cx + dx - fx, 0, fx - (cx + dx + 1)), ey = Math.max(cy + dy - fy, 0, fy - (cy + dy + 1));
      want.push([cx + dx, cy + dy, Math.hypot(ex, ey) * tileM]);
    }
    want.sort((a, b) => a[2] - b[2]);
    let pending = 0;
    for (const [tx, ty, d] of want) {
      const key = tx + '/' + ty;
      let c = this.chunks.get(key);
      if (!c) {
        if (this.loading >= 3) { pending++; continue; }
        c = { tx, ty, key, heights: null, mesh: null, water: null, waterMask: null, veg: null, texLevel: 0, texLoading: false, texWant: 0, disposed: false };
        this.chunks.set(key, c);
        void this.loadChunk(c);
      }
      if (!c.heights) { pending++; continue; }
      // photo base: full resolution (z18) within 300 m of the car, coarser further out
      const level = d < 300 ? 18 : d < 1100 ? 17 : d < 2200 ? 16 : 15;
      // upgrade when closer; downgrade (to free memory) once two levels too detailed
      if ((c.texLevel < level || c.texLevel > level + 1) && !c.texLoading && c.texWant !== level) void this.loadTexture(c, level);
    }
    this.pendingChunks = pending;
    for (const c of this.chunks.values()) {
      if (Math.max(Math.abs(c.tx - cx), Math.abs(c.ty - cy)) > radius + 2) this.disposeChunk(c);
    }
  }

  private disposeChunk(c: Chunk): void {
    c.disposed = true;
    this.chunks.delete(c.key);
    if (c.mesh) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      const m = c.mesh.material as THREE.MeshLambertMaterial;
      m.map?.dispose(); m.dispose(); c.water?.dispose();
    }
  }

  private demFill(tx14: number, ty14: number): Promise<Float32Array | null> {
    const key = tx14 + '/' + ty14;
    let p = this.fillCache.get(key);
    if (!p) {
      p = loadBitmap(this.sources.demFill, 14, tx14, ty14).then((b) => (b ? decodeDem(b) : null));
      this.fillCache.set(key, p);
      if (this.fillCache.size > 64) this.fillCache.delete(this.fillCache.keys().next().value!);
    }
    return p;
  }

  private async loadChunk(c: Chunk): Promise<void> {
    this.loading++;
    try {
      const bmp = await loadBitmap(this.sources.dem, Z, c.tx, c.ty);
      let dem = bmp ? decodeDem(bmp) : new Float32Array(65536).fill(NA);
      bmp?.close();
      let naCount = 0;
      for (let i = 0; i < 65536; i++) if (dem[i] === NA) naCount++;
      if (naCount) {
        const f = await this.demFill(c.tx >> 1, c.ty >> 1);
        const ox = (c.tx & 1) * 128, oy = (c.ty & 1) * 128;
        // The 5 m model leaves water bodies empty. If the whole tile is empty the 5 m
        // survey simply does not cover it, so only the 10 m model's gaps (sea) count.
        const surveyed = naCount < 65536 * 0.98;
        const mask = new Uint8Array(65536);
        let wet = 0;
        for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
          const k = j * 256 + i;
          if (dem[k] !== NA) continue;
          const v = f ? f[(oy + (j >> 1)) * 256 + ox + (i >> 1)] : NA;
          if (surveyed || v === NA) { mask[(255 - j) * 256 + i] = 255; wet++; } // texture rows are bottom-up
          dem[k] = v === NA ? 0 : v; // open water -> sea level
        }
        if (wet > 12) {
          c.waterMask = mask;
          c.water = new THREE.DataTexture(mask, 256, 256, THREE.RedFormat);
          c.water.magFilter = THREE.LinearFilter; c.water.minFilter = THREE.LinearFilter; c.water.needsUpdate = true;
        }
      }
      if (c.disposed) return;
      this.buildMesh(c, dem);
    } catch (e) {
      console.warn('[terrain] chunk failed, safety ground remains', c.key, e);
      this.chunks.delete(c.key); // allow retry later
    } finally { this.loading--; }
  }

  private buildMesh(c: Chunk, dem: Float32Array): void {
    const heights = new Float32Array(V * V);
    const pos = new Float32Array((V * V + 4 * V) * 3);
    const uv = new Float32Array((V * V + 4 * V) * 2);
    const cLat = tileYToLat(c.ty + 0.5, Z), cLon = tileXToLon(c.tx + 0.5, Z);
    const center = frame.llaToLocal(cLat, cLon, 0);
    const p = { x: 0, y: 0, z: 0 };
    for (let j = 0; j < V; j++) {
      const lat = tileYToLat(c.ty + j / N, Z);
      // pixel-centre sampling: vertex j sits between pixels 2j-1 and 2j
      const j0 = Math.max(2 * j - 1, 0), j1 = Math.min(2 * j, 255);
      for (let i = 0; i < V; i++) {
        const lon = tileXToLon(c.tx + i / N, Z);
        const i0 = Math.max(2 * i - 1, 0), i1 = Math.min(2 * i, 255);
        const e = (dem[j0 * 256 + i0] + dem[j0 * 256 + i1] + dem[j1 * 256 + i0] + dem[j1 * 256 + i1]) * 0.25;
        frame.llaToLocal(lat, lon, e + geoidHeight(lat, lon), p);
        const k = j * V + i;
        heights[k] = p.y;
        pos[k * 3] = p.x - center.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z - center.z;
        uv[k * 2] = i / N; uv[k * 2 + 1] = 1 - j / N;
      }
    }
    // skirts hide the small seams between neighbouring chunks
    const idx: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = j * V + i, b = a + 1, d = a + V, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    let s = V * V;
    const skirt = (at: (t: number) => number, flip: boolean) => {
      const base = s;
      for (let t = 0; t < V; t++, s++) {
        const k = at(t);
        pos[s * 3] = pos[k * 3]; pos[s * 3 + 1] = pos[k * 3 + 1] - 8; pos[s * 3 + 2] = pos[k * 3 + 2];
        uv[s * 2] = uv[k * 2]; uv[s * 2 + 1] = uv[k * 2 + 1];
      }
      for (let t = 0; t < N; t++) {
        const a = at(t), b = at(t + 1), d = base + t, e = base + t + 1;
        if (flip) idx.push(a, b, d, b, e, d); else idx.push(a, d, b, b, d, e);
      }
    };
    skirt((t) => t, true); skirt((t) => N * V + t, false);
    skirt((t) => t * V, false); skirt((t) => t * V + N, true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = groundMaterial(c.water);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(center.x, 0, center.z);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    mesh.name = 'terrain ' + c.key; mesh.receiveShadow = true;
    c.heights = heights; c.mesh = mesh;
    this.group.add(mesh);
  }

  private async loadTexture(c: Chunk, level: number): Promise<void> {
    c.texLoading = true; c.texWant = level;
    try {
      const n = 2 ** (level - Z), size = 256 * n;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!;
      const jobs: Promise<void>[] = [];
      let ok = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        jobs.push(loadBitmap(this.sources.ortho, level, c.tx * n + i, c.ty * n + j).then((b) => {
          if (!b) return;
          ctx.drawImage(b, i * 256, j * 256, 256, 256); b.close(); ok++;
        }));
      }
      await Promise.all(jobs);
      if (c.disposed || !c.mesh || ok === 0) return;
      if (level >= 16 && !c.veg) c.veg = this.classifyVegetation(canvas, c.waterMask);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.maxAniso;
      tex.generateMipmaps = true;
      const m = c.mesh.material as THREE.MeshLambertMaterial;
      m.map?.dispose();
      m.map = tex; m.color.set(0xb8b8b8); m.needsUpdate = true;
      c.texLevel = level;
    } finally { c.texLoading = false; }
  }

  /** Reads vegetation from the photo itself: green, dark pixels are tree canopy, lighter green is grass. */
  private classifyVegetation(canvas: HTMLCanvasElement, water: Uint8Array | null): Uint8Array {
    const ctx = scratch!.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 256, 256);
    ctx.drawImage(canvas, 0, 0, 256, 256);
    const d = ctx.getImageData(0, 0, 256, 256).data, out = new Uint8Array(65536);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const k = j * 256 + i, r = d[k * 4], g = d[k * 4 + 1], b = d[k * 4 + 2];
      if (water && water[(255 - j) * 256 + i]) continue;
      if (g > r + 8 && g > b + 14) out[k] = 0.3 * r + 0.59 * g + 0.11 * b < 105 ? 2 : 1;
    }
    return out;
  }

  /** Vegetation class read from the photo at local (x, z): 0 none, 1 grass, 2 trees, -1 unknown yet. */
  vegAt(x: number, z: number, refY = 40): number {
    const q = this.chunkAt(x, z, refY);
    if (!q.c?.veg) return -1;
    return q.c.veg[Math.min(255, Math.floor(q.v * 256)) * 256 + Math.min(255, Math.floor(q.u * 256))];
  }

  /** True where the elevation model marks open water. */
  isWater(x: number, z: number, refY = 40): boolean {
    const q = this.chunkAt(x, z, refY);
    const m = q.c?.waterMask;
    return !!m && m[(255 - Math.min(255, Math.floor(q.v * 256))) * 256 + Math.min(255, Math.floor(q.u * 256))] > 0;
  }

  // ---------------------------------------------------------- safety ground
  /** Builds the region-wide low-res ground. Resolves once geometry exists. */
  async buildSafetyGround(bounds: { west: number; south: number; east: number; north: number }, demUrls: string[], photoUrls: string[]): Promise<void> {
    const zd = 10;
    const x0 = Math.floor(lonToTileX(bounds.west, zd)), x1 = Math.floor(lonToTileX(bounds.east, zd));
    const y0 = Math.floor(latToTileY(bounds.north, zd)), y1 = Math.floor(latToTileY(bounds.south, zd));
    const w = (x1 - x0 + 1) * 256, h = (y1 - y0 + 1) * 256;
    const dem = new Float32Array(w * h).fill(0);
    await Promise.all(Array.from({ length: (x1 - x0 + 1) * (y1 - y0 + 1) }, async (_, k) => {
      const i = k % (x1 - x0 + 1), j = Math.floor(k / (x1 - x0 + 1));
      const b = await loadBitmap(demUrls, zd, x0 + i, y0 + j);
      if (!b) return;
      const d = decodeDem(b); b.close();
      for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 256; xx++) {
        const v = d[yy * 256 + xx];
        dem[(j * 256 + yy) * w + i * 256 + xx] = v === NA ? 0 : v;
      }
    }));
    // coarse grid: every 4 px (~490 m), min-filtered so it never pokes above detail terrain
    const step = 4, nx = Math.floor(w / step) + 1, ny = Math.floor(h / step) + 1;
    const ys = new Float32Array(nx * ny);
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    const p = { x: 0, y: 0, z: 0 };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let yy = Math.max(j * step - 5, 0); yy <= Math.min(j * step + 5, h - 1); yy++)
        for (let xx = Math.max(i * step - 5, 0); xx <= Math.min(i * step + 5, w - 1); xx++) m = Math.min(m, dem[yy * w + xx]);
      const lon = tileXToLon(x0 + (i * step) / 256, zd), lat = tileYToLat(y0 + (j * step) / 256, zd);
      frame.llaToLocal(lat, lon, m + geoidHeight(lat, lon) - 3, p);
      const k = j * nx + i;
      ys[k] = p.y; pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      uv[k * 2] = (i * step) / w; uv[k * 2 + 1] = 1 - (j * step) / h;
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const mat = groundMaterial(null);
    mat.color.set(0x6f7a6c);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'safety-ground'; mesh.frustumCulled = false; mesh.renderOrder = -1;
    this.group.add(mesh);
    this.safety = { x0, y0, k: 256 / step, nx, ny, y: ys };
    // texture (async, non-blocking): z12 photo mosaic
    void (async () => {
      const zp = 12, s = 2 ** (zp - zd);
      const canvas = document.createElement('canvas');
      canvas.width = (x1 - x0 + 1) * s * 128; canvas.height = (y1 - y0 + 1) * s * 128; // half-res tiles
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#5d6f7a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const jobs: Promise<void>[] = [];
      for (let j = 0; j < (y1 - y0 + 1) * s; j++) for (let i = 0; i < (x1 - x0 + 1) * s; i++) {
        jobs.push(loadBitmap(photoUrls, zp, x0 * s + i, y0 * s + j).then((b) => { if (b) { ctx.drawImage(b, i * 128, j * 128, 128, 128); b.close(); } }));
      }
      await Promise.all(jobs);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex; mat.color.set(0xb8b8b8); mat.needsUpdate = true;
    })();
  }
}

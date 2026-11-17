// Optional fill layer: Google Photorealistic 3D Tiles (through Cesium ion or a Google
// Maps API key the player supplies - nothing is shipped in the code or the repository).
//
// PLATEAU always wins. Google's tiles are one photogrammetry mesh that includes the
// ground, so every fragment is filtered against a mask built around the car:
//   - below "ground + clearance"            -> dropped (our photo ground and vector roads stay)
//   - where a PLATEAU building stands        -> dropped (the modelled building stays)
//   - on an elevated road / bridge corridor  -> dropped (our decks / PLATEAU bridges stay)
// What remains is what PLATEAU has no model for: temples, park buildings, missing houses,
// real trees. Nothing from this layer is used for collision.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GoogleCloudAuthPlugin, GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { frame } from '../geo/geodesy';
import type { Terrain } from '../world/Terrain';
import type { HeightGrid } from '../world/HeightGrid';
import type { Roads } from '../world/Roads';

const GOOGLE_ION_ASSET = 2275207;      // "Google Photorealistic 3D Tiles" on Cesium ion
const GOOGLE_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const N = 512, RES = 4, SIZE = N * RES; // mask: 2 km square at 4 m
const COARSE = 16;                      // terrain sampled every 16 m, interpolated
const GROUND_CLEARANCE = 2.2;           // Google geometry lower than this above our ground is dropped

export const googleUniforms = {
  tdMask: { value: null as THREE.Texture | null },
  tdMaskOrigin: { value: new THREE.Vector2() },
  tdMaskSize: { value: SIZE },
  tdGoogleGain: { value: 0.11 },        // unlit photo colours -> scene radiance (HDR pipeline, exposure 10)
  tdGoogleFade: { value: new THREE.Vector2(560, 690) },
  tdGroundClear: { value: GROUND_CLEARANCE },
};

function patchMaterial(mat: THREE.Material): void {
  if ((mat as any).userData?.tdGoogle) return;
  (mat as any).userData = { ...(mat as any).userData, tdGoogle: true };
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    Object.assign(shader.uniforms, googleUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 tdGWP; varying float tdGDepth;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n tdGWP = (modelMatrix * vec4(transformed, 1.0)).xyz; tdGDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 tdGWP; varying float tdGDepth;
        uniform sampler2D tdMask; uniform vec2 tdMaskOrigin; uniform float tdMaskSize;
        uniform float tdGoogleGain; uniform vec2 tdGoogleFade; uniform float tdGroundClear;
        float tdGIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        {
          vec2 uv = (tdGWP.xz - tdMaskOrigin) / tdMaskSize;
          if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) discard;
          vec4 m = texture2D(tdMask, uv);          // r: ground, g: PLATEAU roof, b: elevated road corridor
          if (tdGWP.y < m.r + tdGroundClear) discard;
          if (m.g > m.r + 1.0 || m.b > 0.5) discard;
          if (tdGIGN(gl_FragCoord.xy) >= 1.0 - smoothstep(tdGoogleFade.x, tdGoogleFade.y, tdGDepth)) discard;
        }`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.rgb *= tdGoogleGain;');
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => key() + '|td-google';
}

export type GoogleStatus = 'off' | 'loading' | 'on' | 'error';

export class GoogleFill {
  readonly group = new THREE.Group();
  private tiles: TilesRenderer | null = null;
  private cam = new THREE.PerspectiveCamera();
  private draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/').setWorkerLimit(1);
  status: GoogleStatus = 'off';
  message = '';
  range = 700;
  // mask: built into `work`, swapped into the texture when a pass completes
  private tex: THREE.DataTexture;
  private work = new Float32Array(N * N * 4);
  private origin = new THREE.Vector2(1e9, 1e9);     // of the texture currently shown
  private next = new THREE.Vector2(1e9, 1e9);       // of the mask being built
  private coarse = new Float32Array(((SIZE / COARSE) + 1) ** 2);
  private phase: 'idle' | 'terrain' | 'fill' = 'idle';
  private row = 0; private roofRow = 0; private roadsVersion = -1; private lastUpload = 0; private roofDirty = false;
  private attributions: { type: string; value: string }[] = [];

  constructor(private camera: THREE.PerspectiveCamera, private renderer: THREE.WebGLRenderer,
    private terrain: Terrain, private obstacles: HeightGrid, private roads: Roads) {
    this.group.name = 'google-fill';
    this.group.matrixAutoUpdate = false;
    this.group.matrix.fromArray(frame.ecefToLocalMatrix());
    this.group.updateMatrixWorld(true);
    this.tex = new THREE.DataTexture(new Float32Array(N * N * 4), N, N, THREE.RGBAFormat, THREE.FloatType);
    this.tex.magFilter = THREE.NearestFilter; this.tex.minFilter = THREE.NearestFilter;
    googleUniforms.tdMask.value = this.tex;
  }

  /** "AIza…" = Google Maps API key; anything else = Cesium ion access token; '' = off. */
  setToken(token: string): void {
    this.disable();
    token = token.trim();
    if (!token) return;
    const google = token.startsWith('AIza');
    const tiles = new TilesRenderer(google ? GOOGLE_ROOT : undefined);
    if (google) tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: token, autoRefreshToken: true }) as any);
    else tiles.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: String(GOOGLE_ION_ASSET), autoRefreshToken: true }) as any);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco, autoDispose: false } as any));
    tiles.registerPlugin({
      name: 'TD_GOOGLE_MASK',
      processTileModel: (scene: THREE.Object3D) => scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = false; m.receiveShadow = false;
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) patchMaterial(mat);
      }),
    } as any);
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300 }) as any);
    tiles.errorTarget = 16;
    tiles.autoDisableRendererCulling = false;
    // own cache, well below the PLATEAU one: this is a supplement
    tiles.lruCache.minBytesSize = 0.25 * 2 ** 30; tiles.lruCache.maxBytesSize = 0.4 * 2 ** 30;
    tiles.setCamera(this.cam);
    tiles.setResolutionFromRenderer(this.cam, this.renderer);
    // only real geometry arriving proves the key works (ion fires 'load-root-tileset' before it authenticates)
    tiles.addEventListener('load-model', () => { if (this.status === 'loading') { this.status = 'on'; this.message = ''; } });
    tiles.addEventListener('load-error', (ev: any) => {
      const msg = String(ev.error?.message ?? ev.error ?? '');
      // a single tile failing is not fatal; an authorisation failure or a missing root is
      if (tiles.root && this.status === 'on' && !/\b(400|401|403)\b/.test(msg)) return;
      this.status = 'error';
      this.message = String(ev.error?.message ?? ev.error ?? 'load error').slice(0, 160);
      console.warn('[google] tileset unavailable:', this.message);
      this.disable(true);
    });
    this.group.add(tiles.group);
    this.tiles = tiles;
    this.status = 'loading';
  }

  private disable(keepStatus = false): void {
    if (this.tiles) {
      this.group.remove(this.tiles.group);
      try { this.tiles.dispose(); } catch { /* ignore */ }
      this.tiles = null;
    }
    if (!keepStatus) { this.status = 'off'; this.message = ''; }
    this.attributions = [];
  }

  get enabled(): boolean { return !!this.tiles; }

  /** Attribution lines the provider requires on screen ("Google" + data providers). */
  get credits(): string {
    if (!this.tiles || this.status !== 'on') return '';
    this.attributions.length = 0;
    this.tiles.getAttributions(this.attributions as any);
    const text = this.attributions.filter((a) => a.type === 'string').map((a) => a.value).join(' ');
    return 'Google' + (text ? ' · ' + text : '');
  }

  update(x: number, z: number): void {
    if (!this.tiles) return;
    this.buildMask(x, z, 4);
    // culling camera: the game camera with a short far plane
    const c = this.cam, g = this.camera;
    c.fov = Math.min(110, g.fov + 10); c.aspect = g.aspect; c.near = g.near; c.far = this.range;
    c.updateProjectionMatrix();
    c.matrixWorld.copy(g.matrixWorld); c.matrixWorldInverse.copy(g.matrixWorldInverse);
    googleUniforms.tdGoogleFade.value.set(this.range * 0.8, this.range * 0.98);
    // until the first mask exists for this area, show nothing from Google
    this.tiles.group.visible = Math.abs(x - (this.origin.x + SIZE / 2)) < SIZE / 2 - this.range * 0.5 && Math.abs(z - (this.origin.y + SIZE / 2)) < SIZE / 2 - this.range * 0.5;
    try { this.tiles.setResolutionFromRenderer(c, this.renderer); this.tiles.update(); }
    catch (e) { this.status = 'error'; this.message = String(e); this.disable(true); }
  }

  /** Rolling mask build, time-sliced. */
  private buildMask(x: number, z: number, budgetMs: number): void {
    const t0 = performance.now();
    const cx = this.origin.x + SIZE / 2, cz = this.origin.y + SIZE / 2;
    if (this.phase === 'idle' && (Math.abs(x - cx) > SIZE * 0.18 || Math.abs(z - cz) > SIZE * 0.18)) {
      this.next.set(Math.round(x / 256) * 256 - SIZE / 2, Math.round(z / 256) * 256 - SIZE / 2);
      this.phase = 'terrain'; this.row = 0;
    }
    const cn = SIZE / COARSE + 1;
    while (this.phase !== 'idle' && performance.now() - t0 < budgetMs) {
      if (this.phase === 'terrain') {
        // coarse ground grid (Terrain.heightAt is not cheap)
        const zz = this.next.y + this.row * COARSE;
        for (let i = 0; i < cn; i++) this.coarse[this.row * cn + i] = this.terrain.heightAt(this.next.x + i * COARSE, zz);
        if (++this.row >= cn) { this.phase = 'fill'; this.row = 0; }
      } else {
        // full-resolution rows: interpolated ground + PLATEAU roofs
        for (let r = 0; r < 16 && this.row < N; r++, this.row++) {
          const j = this.row, fz = ((j + 0.5) * RES) / COARSE, jz = Math.min(cn - 2, Math.floor(fz)), tz = fz - jz;
          for (let i = 0; i < N; i++) {
            const fx = ((i + 0.5) * RES) / COARSE, ix = Math.min(cn - 2, Math.floor(fx)), tx = fx - ix, k = jz * cn + ix;
            const c = this.coarse;
            const h = (c[k] * (1 - tx) + c[k + 1] * tx) * (1 - tz) + (c[k + cn] * (1 - tx) + c[k + cn + 1] * tx) * tz;
            const o = (j * N + i) * 4;
            this.work[o] = h; this.work[o + 1] = this.roof(this.next.x + (i + 0.5) * RES, this.next.y + (j + 0.5) * RES); this.work[o + 2] = 0;
          }
        }
        if (this.row >= N) {
          this.stampRoads(this.next, this.work);
          (this.tex.image.data as Float32Array).set(this.work);
          this.tex.needsUpdate = true;
          this.origin.copy(this.next); googleUniforms.tdMaskOrigin.value.copy(this.origin);
          this.phase = 'idle'; this.roofRow = 0; this.roadsVersion = this.roads.version;
        }
      }
    }
    if (this.phase !== 'idle' || this.origin.x > 1e8) return;
    // keep PLATEAU roofs current as more buildings stream in (rolling, cheap lookups)
    const d = this.tex.image.data as Float32Array;
    for (let r = 0; r < 24 && performance.now() - t0 < budgetMs; r++) {
      const j = this.roofRow;
      for (let i = 0; i < N; i++) {
        const o = (j * N + i) * 4, v = this.roof(this.origin.x + (i + 0.5) * RES, this.origin.y + (j + 0.5) * RES);
        if (v !== d[o + 1]) { d[o + 1] = v; this.roofDirty = true; }
      }
      this.roofRow = (this.roofRow + 1) % N;
    }
    if (this.roads.version !== this.roadsVersion) { this.roadsVersion = this.roads.version; this.stampRoads(this.origin, d); this.roofDirty = true; }
    const now = performance.now();
    if (this.roofDirty && now - this.lastUpload > 500) { this.tex.needsUpdate = true; this.roofDirty = false; this.lastUpload = now; }
  }

  /** Highest PLATEAU roof in a 4 m cell, grown by one cell so Google's own copy of the edge is hidden too. */
  private roof(x: number, z: number): number {
    let h = -1e4;
    for (const [dx, dz] of [[-3, -3], [1, -3], [-3, 1], [1, 1], [-1, -1], [3, 3], [-5, -1], [5, -1], [-1, 5], [-1, -5]]) {
      const v = this.obstacles.heightAt(x + dx, z + dz);
      if (v > h) h = v;
    }
    return h;
  }

  /** Mark corridors of elevated roads (our decks and PLATEAU bridges are drawn there). */
  private stampRoads(origin: THREE.Vector2, data: Float32Array): void {
    for (let k = 2; k < data.length; k += 4) data[k] = 0;
    for (const w of this.roads.ways.values()) {
      if (!w.bridge && w.layer < 1) continue;
      if (w.maxX < origin.x || w.minX > origin.x + SIZE || w.maxZ < origin.y || w.minZ > origin.y + SIZE) continue;
      const r = w.width / 2 + 3;
      for (let s = 0; s < w.n - 1; s++) {
        const ax = w.xs[s], az = w.zs[s], bx = w.xs[s + 1], bz = w.zs[s + 1];
        const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.ceil(len / 2));
        for (let q = 0; q <= steps; q++) {
          const px = ax + ((bx - ax) * q) / steps, pz = az + ((bz - az) * q) / steps;
          const i0 = Math.floor((px - r - origin.x) / RES), i1 = Math.floor((px + r - origin.x) / RES);
          const j0 = Math.floor((pz - r - origin.y) / RES), j1 = Math.floor((pz + r - origin.y) / RES);
          for (let j = Math.max(0, j0); j <= Math.min(N - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(N - 1, i1); i++) data[(j * N + i) * 4 + 2] = 1;
        }
      }
    }
  }
}

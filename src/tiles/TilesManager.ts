// Multi-tileset management: the region is a composite of per-municipality
// PLATEAU 3D Tiles tilesets listed in the manifest. Tilesets are activated
// when the player is near their bounds and share one LRU cache and one set of
// download / parse queues with explicit caps (CLAUDE.md §8, §9.5).
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { frame } from '../geo/geodesy';
import { facadeUniforms } from './FacadeBaker';
import { STREET_CARVE_GLSL, streetCarve } from '../roads/StreetMask';
import type { HeightGrid } from '../world/HeightGrid';
import type { DeckProvider } from '../world/Ground';

(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface ManifestTileset {
  id: string; cityCode: string; city: string;
  type: 'bldg' | 'bldgFar' | 'brid' | 'tran' | 'veg' | 'frn';
  lod: number; texture: boolean;
  /** Self-hosted URL relative to the data base, when downloaded. */
  url?: string;
  /** Official streaming URL (prototype / fallback only). */
  remoteUrl: string;
  bounds: { west: number; south: number; east: number; north: number };
}
export interface Manifest {
  generated: string;
  bounds: { west: number; south: number; east: number; north: number };
  tilesets: ManifestTileset[];
  terrain: { dem: string[]; demFill: string[]; ortho: string[]; safetyDem: string[]; safetyPhoto: string[] };
  osm?: { zoom: number; tiles: string[] };
}

/** Retries failed fetches with backoff; a tile that keeps failing is reported, not fatal. */
class RetryFetchPlugin {
  name = 'RETRY_FETCH_PLUGIN';
  async fetchData(url: string, options: RequestInit): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, options);
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res;
        last = new Error('HTTP ' + res.status);
      } catch (e) {
        if ((e as any)?.name === 'AbortError') throw e;
        last = e;
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    throw last;
  }
}

/** Texture budget follows model detail: tiles that are only shown up close (small
 *  geometric error) keep their textures at high resolution, coarse distant tiles
 *  are downscaled before upload. All tile textures get mipmaps + anisotropy so
 *  facades stay crisp at grazing angles. */
class TextureLimitPlugin {
  name = 'TEXTURE_LIMIT_PLUGIN';
  constructor(private owner: { textureNear: number; textureFar: number; anisotropy: number }) {}
  async processTileModel(scene: THREE.Object3D, tile: any): Promise<void> {
    const err = tile?.geometricError ?? 0;
    // leaf tiles (error 0) are only shown close to the camera: they get the big textures
    const max = err < 1 ? this.owner.textureNear : this.owner.textureFar;
    const seen = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const t = (mat as THREE.MeshStandardMaterial).map;
        if (t) seen.add(t);
      }
    });
    // Several textures can share one decoded image: resize each image once and never
    // close the original while another texture may still point at it.
    const resized = new Map<object, Promise<ImageBitmap | null>>();
    await Promise.all([...seen].map(async (t) => {
      t.anisotropy = this.owner.anisotropy;
      t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      const img = t.image as ImageBitmap | HTMLImageElement | undefined;
      if (!img || !(img as any).width) return;
      const w = (img as any).width as number, h = (img as any).height as number;
      const k = Math.min(1, max / Math.max(w, h));
      if (k < 1) {
        let job = resized.get(img);
        if (!job) {
          job = createImageBitmap(img as any, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' }).catch(() => null);
          resized.set(img, job);
        }
        const small = await job;
        if (small) t.image = small;
      }
      t.needsUpdate = true;
    }));
  }
}

/** Procedural facade for buildings that PLATEAU publishes without textures (most of
 *  the Tama area and outer Yokohama): a window grid in world space with a
 *  per-building wall tint, so they do not read as blank white boxes. */
function applyFacade(mat: THREE.MeshStandardMaterial): void {
  mat.color.setRGB(1, 1, 1);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, facadeUniforms(mat)); // per building group: its baked Google atlas
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _batchid;\nattribute vec2 gUv;\nvarying vec3 tdWP; varying vec3 tdWN; varying float tdSeed; varying vec2 tdGUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n tdGUv = gUv; tdWP = (modelMatrix * vec4(position, 1.0)).xyz; tdWN = normalize(mat3(modelMatrix) * normal);\n tdSeed = fract(sin(_batchid * 12.9898 + modelMatrix[3].x * 0.0137 + modelMatrix[3].z * 0.0071) * 43758.5453);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 tdWP; varying vec3 tdWN; varying float tdSeed;\nvarying vec2 tdGUv; uniform sampler2D tdGAtlas; uniform float tdGBaked;\nfloat tdHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 n = normalize(tdWN);
          // wall tint per building: concrete, beige, warm grey, light brick
          vec3 wall = mix(vec3(0.30, 0.29, 0.27), vec3(0.40, 0.36, 0.30), fract(tdSeed * 7.0));
          wall = mix(wall, vec3(0.34, 0.25, 0.20), step(0.82, tdSeed));
          wall = mix(wall, vec3(0.42, 0.42, 0.42), step(tdSeed, 0.15));
          if (abs(n.y) < 0.55) {
            float u = dot(tdWP.xz, vec2(-n.z, n.x));
            vec2 cell = vec2(u / (1.7 + 0.9 * fract(tdSeed * 3.0)), tdWP.y / 3.0);
            vec2 f = fract(cell);
            float aa = max(fwidth(cell.x), fwidth(cell.y));
            float win = smoothstep(0.16 - aa, 0.16 + aa, f.x) * smoothstep(0.84 + aa, 0.84 - aa, f.x) * smoothstep(0.30 - aa, 0.30 + aa, f.y) * smoothstep(0.80 + aa, 0.80 - aa, f.y);
            win *= 1.0 - smoothstep(0.25, 0.7, aa);           // fade the grid out in the distance (no moire)
            float g = tdHash(floor(cell) + tdSeed * 91.0);
            vec3 glass = mix(vec3(0.035, 0.05, 0.07), vec3(0.11, 0.15, 0.2), g);
            diffuseColor.rgb = mix(wall, glass, win);
          } else {
            diffuseColor.rgb = wall * 0.8;                     // roofs
          }
          // Google colours baked onto this wall (FacadeBaker); alpha = the scan had a surface there
          if (tdGBaked > 0.5 && tdGUv.x >= 0.0) {
            vec4 gc = texture2D(tdGAtlas, tdGUv);
            diffuseColor.rgb = mix(diffuseColor.rgb, gc.rgb, smoothstep(0.25, 0.75, gc.a));
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'td-facade';
}

/**
 * Distance fade at the edge of what is loaded. Building materials dither themselves away
 * over the last stretch before the load distance (by view depth, the same measure the
 * culling camera's far plane uses), so the edge dissolves instead of cutting off.
 * The far white-box layer (flight) uses the complementary threshold of the same noise:
 * inside the band every pixel belongs to exactly one layer - no overlap, no holes.
 */
export const distanceFade = {
  tdNearFade: { value: new THREE.Vector2(800, 1000) },   // detail layer: fade between x and y metres
  tdFarFade: { value: new THREE.Vector2(8000, 9500) },   // far layer: its own outer edge
};
function addDistanceFade(mat: THREE.Material, far: boolean, carve = false): void {
  if ((mat as any).userData?.tdFade) return;
  (mat as any).userData = { ...(mat as any).userData, tdFade: true };
  // buildings keep mapped streets clear (see StreetMask); the inside of a cut shows as dark wall
  if (carve) mat.side = THREE.DoubleSide;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    Object.assign(shader.uniforms, distanceFade);
    if (carve) Object.assign(shader.uniforms, streetCarve);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float tdViewDepth;' + (carve ? '\nvarying vec3 tdWorld;' : ''))
      .replace('#include <project_vertex>', '#include <project_vertex>\n tdViewDepth = -mvPosition.z;' + (carve ? '\n tdWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;' : ''));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float tdViewDepth; uniform vec2 tdNearFade; uniform vec2 tdFarFade;
        ${carve ? 'varying vec3 tdWorld; uniform sampler2D tdStreetMask; uniform vec4 tdStreetBox; uniform float tdStreetClear;' : ''}
        float tdIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        ${carve ? STREET_CARVE_GLSL : ''}
        {
          float tdT = tdIGN(gl_FragCoord.xy);
          float tdNearA = 1.0 - smoothstep(tdNearFade.x, tdNearFade.y, tdViewDepth);
          ${far
            ? 'if (tdT < tdNearA || tdT >= 1.0 - smoothstep(tdFarFade.x, tdFarFade.y, tdViewDepth)) discard;'
            : 'if (tdT >= tdNearA) discard;'}
        }`);
  };
  if (carve) {
    // the back of a wall seen through a cut: dark, unlit-looking
    const prev2 = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev2.call(mat, shader, r);
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n if (!gl_FrontFacing) gl_FragColor.rgb *= 0.35;');
    };
  }
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => key() + (far ? '|tdfade-far' : '|tdfade') + (carve ? '|tdcarve' : '');
}

/** PLATEAU materials ship with roughness 0 (mirror-like): make them matte; untextured ones get a facade. */
function prepareMaterials(scene: THREE.Object3D, type: string): void {
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const s = mat as THREE.MeshStandardMaterial;
      if ('roughness' in s) { s.roughness = 0.9; s.metalness = 0; }
      if (!s.map && 'color' in s) {
        if (type === 'bldg' || type === 'bldgFar') applyFacade(s);
        else s.color.setRGB(0.34, 0.32, 0.3); // untextured: dim to balance against photo-textured tiles
      }
      addDistanceFade(s, type === 'bldgFar', type === 'bldg');
    }
  });
}

interface Entry {
  def: ManifestTileset;
  minX: number; maxX: number; minZ: number; maxZ: number;
  tiles: TilesRenderer | null;
  failed: boolean;
  far: boolean; // LOD1 white-box layer for distant views from the air
}

export class TilesManager implements DeckProvider {
  readonly root = new THREE.Group(); // ECEF -> local frame
  private entries: Entry[] = [];
  private lru: any = null; private dq: any = null; private pq: any = null;
  private draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/').setWorkerLimit(2);
  private deckMeshes = new Map<THREE.Mesh, THREE.Object3D>();
  private raycaster = new THREE.Raycaster();
  private down = new THREE.Vector3(0, -1, 0);
  private lastSelect = -1e9;
  errorTarget = 40;
  private cacheGB = 1.6;
  textureNear = 2048; textureFar = 512; anisotropy = 8;
  /** Bumped whenever a tile model appears or disappears (shadow map refresh trigger). */
  version = 0;
  private lastCam = new Float64Array(16);
  /** Buildings are loaded / displayed only within this distance of the camera. */
  loadDistance = 1200;
  // Tiles are culled against a copy of the game camera with a short far plane, so
  // nothing beyond loadDistance (or outside the view) is ever requested.
  private cullCamera = new THREE.PerspectiveCamera();
  // A second camera looking straight down at the car keeps every tile within nearRange
  // loaded and in the scene, whatever the view direction: shadows and collision around
  // the car must not depend on where the player happens to look.
  private nearCamera = new THREE.PerspectiveCamera();
  nearRange = 280;
  // Far layer (flight only): LOD1 white boxes from the edge of the detail layer out to
  // farDistance. Its camera's near plane starts inside the fade band, so tiles close to
  // the aircraft - which the detail layer already covers - are never requested.
  farEnabled = false;
  farDistance = 8000;
  farErrorTarget = 28;
  private farCamera = new THREE.PerspectiveCamera();
  private lastUpdate = -1e9; private lastFull = -1e9; private idle = false;
  loadErrors = 0;
  /** Untextured leaf building meshes appear / disappear (Google facade baking). */
  onFacadeMesh: ((mesh: THREE.Mesh, world: THREE.Matrix4) => void) | null = null;
  onFacadeMeshGone: ((mesh: THREE.Mesh) => void) | null = null;
  /** Called for every loaded bridge mesh (for deck-coverage tests). */
  onBridgeLoaded: (() => void) | null = null;

  constructor(
    private manifest: Manifest, private dataBase: string,
    private camera: THREE.PerspectiveCamera, private renderer: THREE.WebGLRenderer,
    private obstacles: HeightGrid,
  ) {
    this.root.name = 'plateau-tiles';
    this.root.matrixAutoUpdate = false;
    this.root.matrix.fromArray(frame.ecefToLocalMatrix());
    this.root.updateMatrixWorld(true);
    (this.raycaster as any).firstHitOnly = true;
    const p = { x: 0, y: 0, z: 0 };
    for (const def of manifest.tilesets) {
      const b = def.bounds;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [la, lo] of [[b.south, b.west], [b.south, b.east], [b.north, b.west], [b.north, b.east]]) {
        frame.llaToLocal(la, lo, 0, p);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      this.entries.push({ def, minX, maxX, minZ, maxZ, tiles: null, failed: false, far: def.type === 'bldgFar' });
    }
  }

  private url(def: ManifestTileset): string {
    if (def.url) return /^https?:/.test(def.url) ? def.url : this.dataBase + '/' + def.url;
    return def.remoteUrl;
  }

  private activate(e: Entry): void {
    const tiles = new TilesRenderer(this.url(e.def));
    if (this.lru) { tiles.lruCache = this.lru; tiles.downloadQueue = this.dq; tiles.parseQueue = this.pq; }
    else {
      this.lru = tiles.lruCache; this.dq = tiles.downloadQueue; this.pq = tiles.parseQueue;
      // explicit cache caps
      this.lru.minSize = 2500; this.lru.maxSize = 4000;
      this.setCacheLimit(this.cacheGB);
      this.dq.maxJobsPerOrigin = 6; this.pq.maxJobs = 1;
    }
    tiles.registerPlugin(new RetryFetchPlugin() as any);
    tiles.registerPlugin(new TextureLimitPlugin(this) as any);
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco, autoDispose: false } as any));
    // material fixes run in processTileModel, i.e. before 'load-model', where the fade plugin wraps them
    tiles.registerPlugin({ name: 'TD_MATERIALS', processTileModel: (scene: THREE.Object3D) => prepareMaterials(scene, e.def.type) } as any);
    // cross-fade between detail levels instead of popping (dithered, so no sorting issues)
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 350, maximumFadeOutTiles: 80 }) as any);
    tiles.errorTarget = e.far ? this.farErrorTarget : this.errorTarget;
    // Tiles kept around the car by the near camera are in the scene but often behind the view:
    // let three.js frustum-cull each mesh (the renderer disables that by default).
    tiles.autoDisableRendererCulling = false;
    if (e.far) {
      tiles.setCamera(this.farCamera);
      tiles.setResolutionFromRenderer(this.farCamera, this.renderer);
    } else {
      tiles.setCamera(this.cullCamera);
      tiles.setResolutionFromRenderer(this.cullCamera, this.renderer);
      tiles.setCamera(this.nearCamera);
      tiles.setResolutionFromRenderer(this.nearCamera, this.renderer);
    }
    const isBridge = e.def.type === 'brid';
    const world = new THREE.Matrix4();
    tiles.addEventListener('load-model', (ev: any) => {
      const scene = ev.scene as THREE.Object3D;
      const coarse = e.def.type === 'bldg' && (ev.tile?.children?.length ?? 0) > 0 && (ev.tile?.geometricError ?? 0) >= 1;
      scene.updateMatrix();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (e.far) { m.castShadow = false; m.receiveShadow = false; return; } // scenery only
        m.castShadow = true; m.receiveShadow = true;
        // PLATEAU's intermediate tiles are simplified stand-ins. The renderer only shows one
        // while the real (leaf) models under it are still loading; hiding it left a hole that
        // blinked in and out, so it is shown (and fades), but it never enters the collision grid.
        if (coarse) { this.coarseMeshes.add(m); return; }
        // world matrix in the local frame (scene.matrix is the tile's ECEF transform)
        world.identity();
        let n: THREE.Object3D | null = m;
        while (n && n !== scene) { n.updateMatrix(); world.premultiply(n.matrix); n = n.parent; }
        world.premultiply(scene.matrix).premultiply(this.root.matrix);
        if (isBridge) {
          (m.geometry as any).computeBoundsTree?.();
          this.deckMeshes.set(m, scene);
        } else if (e.def.type === 'bldg') {
          this.obstacles.addMesh(m.geometry, world);
          if (!(m.material as THREE.MeshStandardMaterial).map) this.onFacadeMesh?.(m, world);
        }
      });
      if (isBridge) this.onBridgeLoaded?.();
      this.version++;
    });
    tiles.addEventListener('tile-visibility-change', () => { this.version++; });
    tiles.addEventListener('dispose-model', (ev: any) => {
      (ev.scene as THREE.Object3D).traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { this.coarseMeshes.delete(m); this.onFacadeMeshGone?.(m); }
        if (m.isMesh && this.deckMeshes.delete(m)) (m.geometry as any).disposeBoundsTree?.();
      });
    });
    tiles.addEventListener('load-error', (ev: any) => {
      this.loadErrors++;
      console.warn(`[tiles] ${e.def.id}: load error, falling back to safety ground`, ev.url ?? '', ev.error?.message ?? ev.error);
      if (!tiles.root) { e.failed = true; this.deactivate(e); }
    });
    this.root.add(tiles.group);
    e.tiles = tiles;
  }

  private deactivate(e: Entry): void {
    if (!e.tiles) return;
    this.root.remove(e.tiles.group);
    try { e.tiles.dispose(); } catch (err) { console.warn('[tiles] dispose failed', err); }
    e.tiles = null;
  }

  setCacheLimit(gb: number): void {
    this.cacheGB = gb;
    if (this.lru) { this.lru.minBytesSize = gb * 0.8 * 2 ** 30; this.lru.maxBytesSize = gb * 2 ** 30; }
  }

  private coarseMeshes = new Set<THREE.Mesh>();

  /** Drop every loaded tileset so tiles reload with the current texture / detail settings. */
  reload(): void {
    for (const e of this.entries) { this.deactivate(e); e.failed = false; }
    this.lastSelect = -1e9; this.idle = false;
  }

  /** True if (lat, lon) lies inside the prepared coverage (a building tileset's bounds). */
  covers(lat: number, lon: number): boolean {
    for (const e of this.entries) { const b = e.def.bounds; if (e.def.type === 'bldg' && lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east) return true; }
    return false;
  }

  setErrorTarget(v: number): void {
    this.errorTarget = v;
    for (const e of this.entries) if (e.tiles && !e.far) e.tiles.errorTarget = v;
  }

  /** Call once per frame (after the camera has been updated). */
  update(x: number, z: number, now: number): void {
    const range = this.loadDistance + 150;
    if (now - this.lastSelect > 1000) {
      this.lastSelect = now;
      for (const e of this.entries) {
        const dx = Math.max(e.minX - x, 0, x - e.maxX), dz = Math.max(e.minZ - z, 0, z - e.maxZ);
        const d = Math.hypot(dx, dz);
        // vegetation / street furniture are small-scale detail: only close to the car
        const r = e.far ? (this.farEnabled ? this.farDistance : -1) : e.def.type === 'veg' || e.def.type === 'frn' ? Math.min(range, 450) : range;
        if (!e.tiles && !e.failed && d < r) this.activate(e);
        else if (e.tiles && (r < 0 || d > r * 1.3 + 500)) this.deactivate(e);
      }
    }
    // tile selection is CPU work per tileset: 20 Hz is plenty at driving speeds
    if (now - this.lastUpdate < 50) return;
    this.lastUpdate = now;
    const c = this.cullCamera, g = this.camera;
    // nothing to do while the camera is still and every requested tile has arrived
    const el = g.matrixWorld.elements;
    let moved = false;
    for (let i = 0; i < 16; i++) if (Math.abs(el[i] - this.lastCam[i]) > 1e-4) { moved = true; break; }
    if (!moved && this.idle && now - this.lastFull < 2000) return;
    this.lastFull = now;
    this.lastCam.set(el);
    // slightly wider than the view so buildings just outside it are ready when the car turns
    c.fov = Math.min(110, g.fov + 14); c.aspect = g.aspect; c.near = g.near; c.far = this.loadDistance;
    c.updateProjectionMatrix();
    c.matrixWorld.copy(g.matrixWorld); c.matrixWorldInverse.copy(g.matrixWorldInverse);
    // the fade band sits just inside the culling far plane
    const L = this.loadDistance;
    distanceFade.tdNearFade.value.set(L * 0.78, L * 0.97);
    if (this.farEnabled) {
      const f = this.farCamera, F = this.farDistance;
      f.fov = c.fov; f.aspect = c.aspect; f.near = L * 0.72; f.far = F;
      f.updateProjectionMatrix();
      f.matrixWorld.copy(g.matrixWorld); f.matrixWorldInverse.copy(g.matrixWorldInverse);
      distanceFade.tdFarFade.value.set(F * 0.8, F * 0.97);
    } else distanceFade.tdNearFade.value.set(L * 0.78, L * 0.97);
    const nc = this.nearCamera, H = 420;
    nc.fov = (2 * Math.atan(this.nearRange / H) * 180) / Math.PI; nc.aspect = 1; nc.near = 10; nc.far = H + 400;
    nc.updateProjectionMatrix();
    nc.position.set(x, g.position.y + H, z); nc.up.set(0, 0, -1); nc.lookAt(x, g.position.y, z);
    nc.updateMatrixWorld(); nc.matrixWorldInverse.copy(nc.matrixWorld).invert();
    for (const e of this.entries) {
      if (!e.tiles) continue;
      try {
        if (e.far) e.tiles.setResolutionFromRenderer(this.farCamera, this.renderer);
        else { e.tiles.setResolutionFromRenderer(nc, this.renderer); e.tiles.setResolutionFromRenderer(c, this.renderer); }
        e.tiles.update();
      } catch (err) {
        // a broken tileset must never freeze the frame loop
        console.warn(`[tiles] ${e.def.id}: update failed, disabling`, err);
        e.failed = true; this.deactivate(e);
      }
    }
    this.idle = this.pending === 0;
  }

  /** Tiles still downloading / parsing across all active tilesets. */
  get pending(): number {
    let n = 0;
    for (const e of this.entries) {
      const s = (e.tiles as any)?.stats;
      if (s) n += (s.queued ?? 0) + (s.downloading ?? 0) + (s.parsing ?? 0);
      else if (e.tiles && !e.tiles.root) n += 1;
    }
    return n;
  }

  get activeCount(): number { return this.entries.reduce((n, e) => n + (e.tiles ? 1 : 0), 0); }

  /** Municipality whose bounds contain (x, z), for the HUD. */
  placeName(x: number, z: number): { code: string; name: string } {
    let best = { code: '', name: '' }, area = Infinity;
    for (const e of this.entries) {
      if (e.def.type !== 'bldg' || x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
      const a = (e.maxX - e.minX) * (e.maxZ - e.minZ);
      if (a < area) { area = a; best = { code: e.def.cityCode, name: e.def.city }; }
    }
    return best;
  }

  // DeckProvider: PLATEAU bridge models are drivable via BVH raycast.
  deckHeight(x: number, z: number, maxY: number): number {
    if (!this.deckMeshes.size) return -Infinity;
    return this.castDown(x, maxY, z, 6);
  }

  /** Downward BVH raycast against loaded bridge meshes. */
  castDown(x: number, y: number, z: number, far: number): number {
    const rc = this.raycaster;
    rc.ray.origin.set(x, y, z); rc.ray.direction.copy(this.down); rc.near = 0; rc.far = far;
    let best = -Infinity;
    const hits: THREE.Intersection[] = [];
    for (const [m, scene] of this.deckMeshes) {
      if (!scene.parent) continue; // tile not active: world matrix is stale
      const bs = m.geometry.boundingSphere;
      if (bs) {
        const e = m.matrixWorld.elements;
        const cx = e[12], cz = e[14];
        // cheap reject using the mesh origin (tiles are RTC-centred) + radius
        if (Math.abs(cx - x) > bs.radius + bs.center.length() || Math.abs(cz - z) > bs.radius + bs.center.length()) continue;
      }
      hits.length = 0;
      m.raycast(rc, hits);
      for (const h of hits) if (h.point.y > best) best = h.point.y;
    }
    return best;
  }

  /**
   * Every bridge-model surface under (x, z) within `far` below `y`, top first. Hits closer
   * than 3 m are one deck (its thickness, a parapet), so stacked decks come out once each.
   */
  castAll(x: number, y: number, z: number, far: number): number[] {
    const rc = this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean };
    rc.ray.origin.set(x, y, z); rc.ray.direction.copy(this.down); rc.near = 0; rc.far = far;
    rc.firstHitOnly = false;
    const ys: number[] = [], hits: THREE.Intersection[] = [];
    for (const [m, scene] of this.deckMeshes) {
      if (!scene.parent) continue;
      const bs = m.geometry.boundingSphere;
      if (bs) {
        const e = m.matrixWorld.elements;
        if (Math.abs(e[12] - x) > bs.radius + bs.center.length() || Math.abs(e[14] - z) > bs.radius + bs.center.length()) continue;
      }
      hits.length = 0;
      m.raycast(rc, hits);
      for (const h of hits) ys.push(h.point.y);
    }
    rc.firstHitOnly = true;
    ys.sort((a, b) => b - a);
    const out: number[] = [];
    for (const v of ys) if (!out.length || out[out.length - 1] - v > 3) out.push(v);
    return out;
  }

  get bridgeMeshCount(): number { return this.deckMeshes.size; }
}

// Multi-tileset management: the region is a composite of per-municipality
// PLATEAU 3D Tiles tilesets listed in the manifest. Tilesets are activated
// when the player is near their bounds and share one LRU cache and one set of
// download / parse queues with explicit caps (CLAUDE.md §8, §9.5).
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { frame } from '../geo/geodesy';
import type { HeightGrid } from '../world/HeightGrid';
import type { DeckProvider } from '../world/Ground';

(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export interface ManifestTileset {
  id: string; cityCode: string; city: string;
  type: 'bldg' | 'brid' | 'tran' | 'veg' | 'frn';
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
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _batchid;\nvarying vec3 tdWP; varying vec3 tdWN; varying float tdSeed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n tdWP = (modelMatrix * vec4(position, 1.0)).xyz; tdWN = normalize(mat3(modelMatrix) * normal);\n tdSeed = fract(sin(_batchid * 12.9898 + modelMatrix[3].x * 0.0137 + modelMatrix[3].z * 0.0071) * 43758.5453);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 tdWP; varying vec3 tdWN; varying float tdSeed;\nfloat tdHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
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
        }`);
  };
  mat.customProgramCacheKey = () => 'td-facade';
}

interface Entry {
  def: ManifestTileset;
  minX: number; maxX: number; minZ: number; maxZ: number;
  tiles: TilesRenderer | null;
  failed: boolean;
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
  private lastUpdate = -1e9; private lastFull = -1e9; private idle = false;
  loadErrors = 0;
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
      this.entries.push({ def, minX, maxX, minZ, maxZ, tiles: null, failed: false });
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
    tiles.errorTarget = this.errorTarget;
    tiles.setCamera(this.cullCamera);
    tiles.setResolutionFromRenderer(this.cullCamera, this.renderer);
    tiles.setCamera(this.nearCamera);
    tiles.setResolutionFromRenderer(this.nearCamera, this.renderer);
    const isBridge = e.def.type === 'brid';
    const world = new THREE.Matrix4();
    tiles.addEventListener('load-model', (ev: any) => {
      const scene = ev.scene as THREE.Object3D;
      const coarse = e.def.type === 'bldg' && (ev.tile?.children?.length ?? 0) > 0 && (ev.tile?.geometricError ?? 0) >= 1;
      scene.updateMatrix();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        // PLATEAU's intermediate tiles are heavily simplified stand-ins (blocky shapes,
        // stretched textures, footprints that spill onto roads). Never show them and never
        // let them into the collision grid: only the real leaf models count.
        if (coarse) { m.visible = false; return; }
        // PLATEAU materials ship with roughness 0 (mirror-like); make them matte
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          const s = mat as THREE.MeshStandardMaterial;
          if ('roughness' in s) { s.roughness = 0.9; s.metalness = 0; }
          if (!s.map && 'color' in s) {
            if (e.def.type === 'bldg') applyFacade(s);
            else s.color.setRGB(0.34, 0.32, 0.3); // untextured: dim to balance against photo-textured tiles
          }
        }
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
        }
      });
      if (isBridge) this.onBridgeLoaded?.();
      this.version++;
    });
    tiles.addEventListener('tile-visibility-change', () => { this.version++; });
    tiles.addEventListener('dispose-model', (ev: any) => {
      (ev.scene as THREE.Object3D).traverse((o) => {
        const m = o as THREE.Mesh;
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
    for (const e of this.entries) if (e.tiles) e.tiles.errorTarget = v;
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
        const r = e.def.type === 'veg' || e.def.type === 'frn' ? Math.min(range, 450) : range;
        if (!e.tiles && !e.failed && d < r) this.activate(e);
        else if (e.tiles && d > r * 1.5 + 300) this.deactivate(e);
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
    const nc = this.nearCamera, H = 420;
    nc.fov = (2 * Math.atan(this.nearRange / H) * 180) / Math.PI; nc.aspect = 1; nc.near = 10; nc.far = H + 400;
    nc.updateProjectionMatrix();
    nc.position.set(x, g.position.y + H, z); nc.up.set(0, 0, -1); nc.lookAt(x, g.position.y, z);
    nc.updateMatrixWorld(); nc.matrixWorldInverse.copy(nc.matrixWorld).invert();
    for (const e of this.entries) {
      if (!e.tiles) continue;
      try {
        e.tiles.setResolutionFromRenderer(nc, this.renderer);
        e.tiles.setResolutionFromRenderer(c, this.renderer);
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
  placeName(x: number, z: number): string {
    let best = '', area = Infinity;
    for (const e of this.entries) {
      if (e.def.type !== 'bldg' || x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
      const a = (e.maxX - e.minX) * (e.maxZ - e.minZ);
      if (a < area) { area = a; best = e.def.city; }
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

  get bridgeMeshCount(): number { return this.deckMeshes.size; }
}

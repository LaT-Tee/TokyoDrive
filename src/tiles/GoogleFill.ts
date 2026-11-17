// Optional: Google Photorealistic 3D Tiles used ONLY as a colour source for the
// procedural facades of PLATEAU buildings that have no texture of their own.
// (Cesium ion token or Google Maps API key supplied by the player - nothing is
// shipped in the code or the repository.)
//
// This class only streams Google's tiles around the car into an off-screen scene;
// they are never drawn on screen. FacadeBaker photographs that scene wall by wall
// and stores the result in per-building atlases (see FacadeBaker.ts).
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GoogleCloudAuthPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { frame } from '../geo/geodesy';

const GOOGLE_ION_ASSET = 2275207;      // "Google Photorealistic 3D Tiles" on Cesium ion
const GOOGLE_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

export type GoogleStatus = 'off' | 'loading' | 'on' | 'error';

export class GoogleFill {
  /** Off-screen scene: never added to the game scene. */
  readonly scene = new THREE.Scene();
  private holder = new THREE.Group();               // ECEF -> local frame
  private tiles: TilesRenderer | null = null;
  private cam = new THREE.PerspectiveCamera();      // the player's view (short far plane)
  private nearCam = new THREE.PerspectiveCamera();  // looks down at the car: loads tiles all around it
  private draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/').setWorkerLimit(1);
  status: GoogleStatus = 'off';
  message = '';
  range = 600;
  /** Radius around the car whose tiles are kept loaded for baking. */
  nearRange = 260;
  /** Bumped whenever a Google tile arrives (FacadeBaker re-photographs walls nearby). */
  version = 0;
  /** Test hook: photograph this scene instead of Google's tiles. */
  debugSource: THREE.Scene | null = null;
  private attributions: { type: string; value: string }[] = [];

  constructor(private camera: THREE.PerspectiveCamera, private renderer: THREE.WebGLRenderer) {
    this.holder.matrixAutoUpdate = false;
    this.holder.matrix.fromArray(frame.ecefToLocalMatrix());
    this.holder.updateMatrixWorld(true);
    this.scene.add(this.holder);
    this.scene.background = null;
  }

  /** Scene to photograph, or null when nothing is available. */
  get source(): THREE.Scene | null { return this.debugSource ?? (this.tiles && this.status === 'on' ? this.scene : null); }

  /** Tiles still downloading or parsing. */
  get pending(): number {
    const s = (this.tiles as any)?.stats;
    return s ? (s.queued ?? 0) + (s.downloading ?? 0) + (s.parsing ?? 0) : 0;
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
    this.attach(tiles);
  }

  /** Test hook: use any keyless 3D Tiles tileset as the colour source (exercises the same path). */
  debugUseTileset(url: string): void {
    this.disable();
    this.attach(new TilesRenderer(url));
  }

  private attach(tiles: TilesRenderer): void {
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco, autoDispose: false } as any));
    tiles.registerPlugin({
      name: 'TD_GOOGLE_SOURCE',
      processTileModel: (scene: THREE.Object3D) => scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; }
      }),
    } as any);
    tiles.errorTarget = 8;
    tiles.autoDisableRendererCulling = false;
    // own cache, below the PLATEAU one: this is only a colour source
    tiles.lruCache.minBytesSize = 0.3 * 2 ** 30; tiles.lruCache.maxBytesSize = 0.5 * 2 ** 30;
    tiles.setCamera(this.cam);
    tiles.setResolutionFromRenderer(this.cam, this.renderer);
    tiles.setCamera(this.nearCam);
    tiles.setResolutionFromRenderer(this.nearCam, this.renderer);
    // only real geometry arriving proves the key works (ion fires 'load-root-tileset' before it authenticates)
    tiles.addEventListener('load-model', () => {
      this.version++;
      if (this.status === 'loading') { this.status = 'on'; this.message = ''; }
    });
    tiles.addEventListener('load-error', (ev: any) => {
      const msg = String(ev.error?.message ?? ev.error ?? '');
      // a single tile failing is not fatal; an authorisation failure or a missing root is
      if (tiles.root && this.status === 'on' && !/\b(400|401|403)\b/.test(msg)) return;
      this.status = 'error';
      this.message = (msg || 'load error').slice(0, 160);
      console.warn('[google] tileset unavailable:', this.message);
      this.disable(true);
    });
    this.holder.add(tiles.group);
    // This scene is never part of the main render, so nothing updates its world matrices for
    // us: without this the tiles sit at raw ECEF coordinates, fail every frustum test and are
    // never requested.
    this.scene.updateMatrixWorld(true);
    this.tiles = tiles;
    this.status = 'loading';
  }

  private disable(keepStatus = false): void {
    if (this.tiles) {
      this.holder.remove(this.tiles.group);
      try { this.tiles.dispose(); } catch { /* ignore */ }
      this.tiles = null;
    }
    if (!keepStatus) { this.status = 'off'; this.message = ''; }
    this.attributions = [];
    this.version++;
  }

  get enabled(): boolean { return !!this.tiles; }

  /** Attribution lines the provider requires on screen ("Google" + data providers). */
  get credits(): string {
    if (!this.tiles || this.status !== 'on') return '';
    this.attributions.length = 0;
    this.tiles.getAttributions(this.attributions as any);
    const text = [...new Set(this.attributions.filter((a) => a.type === 'string').map((a) => a.value))].join(' ');
    return 'Google' + (text ? ' · ' + text : '');
  }

  /** Stream tiles for the current view and the area around the car. */
  update(x: number, z: number): void {
    this.scene.updateMatrixWorld();
    if (!this.tiles) return;
    const c = this.cam, g = this.camera;
    c.fov = g.fov; c.aspect = g.aspect; c.near = g.near; c.far = this.range;
    c.updateProjectionMatrix();
    c.matrixWorld.copy(g.matrixWorld); c.matrixWorldInverse.copy(g.matrixWorldInverse);
    // a low camera straight above the car: tiles all around it, at close-range detail
    const nc = this.nearCam, H = 160;
    nc.fov = (2 * Math.atan(this.nearRange / H) * 180) / Math.PI; nc.aspect = 1; nc.near = 5; nc.far = H + 300;
    nc.updateProjectionMatrix();
    nc.position.set(x, g.position.y + H, z); nc.up.set(0, 0, -1); nc.lookAt(x, g.position.y, z);
    nc.updateMatrixWorld(); nc.matrixWorldInverse.copy(nc.matrixWorld).invert();
    try {
      this.tiles.setResolutionFromRenderer(nc, this.renderer);
      this.tiles.setResolutionFromRenderer(c, this.renderer);
      this.tiles.update();
    } catch (e) { this.status = 'error'; this.message = String(e); this.disable(true); }
  }
}

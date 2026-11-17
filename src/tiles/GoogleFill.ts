// Optional: Google Photorealistic 3D Tiles used ONLY as a colour source for the
// procedural facades of PLATEAU buildings that have no texture of their own.
// (Cesium ion token or Google Maps API key supplied by the player - nothing is
// shipped in the code or the repository.)
//
// Google's mesh is never drawn on screen. Each frame it is rendered off-screen from
// the game camera into a colour + depth target. When the facade shader draws a pixel
// of an untextured PLATEAU building it looks up the same screen position: if Google's
// surface there lies at the same depth (it is the same wall or roof) the photo colour
// is used, otherwise - a tree or another building in front, or no building in Google's
// data - the procedural facade stays.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GoogleCloudAuthPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { frame } from '../geo/geodesy';

const GOOGLE_ION_ASSET = 2275207;      // "Google Photorealistic 3D Tiles" on Cesium ion
const GOOGLE_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';

/** Read by the facade shader (TilesManager.applyFacade). */
export const googleTexUniforms = {
  tdGOn: { value: 0 },
  tdGColor: { value: null as THREE.Texture | null },
  tdGDepth: { value: null as THREE.Texture | null },
  tdGRes: { value: new THREE.Vector2(1, 1) },        // size of the main render target (gl_FragCoord space)
  tdGNearFar: { value: new THREE.Vector2(0.5, 20000) },
  tdGRange: { value: 700 },                          // beyond this the procedural facade is used
};

export type GoogleStatus = 'off' | 'loading' | 'on' | 'error';

export class GoogleFill {
  /** Off-screen scene: never added to the game scene. */
  readonly scene = new THREE.Scene();
  private holder = new THREE.Group();               // ECEF -> local frame
  private tiles: TilesRenderer | null = null;
  private cam = new THREE.PerspectiveCamera();
  private draco = new DRACOLoader().setDecoderPath(import.meta.env.BASE_URL + 'draco/').setWorkerLimit(1);
  private target: THREE.WebGLRenderTarget;
  private size = new THREE.Vector2();
  status: GoogleStatus = 'off';
  message = '';
  range = 700;
  /** Render scale of the colour lookup relative to the screen (cost vs. sharpness). */
  scale = 0.5;
  /** Test hook: render this scene instead of Google's tiles. */
  debugSource: THREE.Scene | null = null;
  private attributions: { type: string; value: string }[] = [];

  constructor(private camera: THREE.PerspectiveCamera, private renderer: THREE.WebGLRenderer) {
    this.holder.matrixAutoUpdate = false;
    this.holder.matrix.fromArray(frame.ecefToLocalMatrix());
    this.holder.updateMatrixWorld(true);
    this.scene.add(this.holder);
    this.scene.background = null;
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.depthTexture = new THREE.DepthTexture(4, 4);
    this.target.texture.minFilter = THREE.LinearFilter; this.target.texture.magFilter = THREE.LinearFilter;
    googleTexUniforms.tdGColor.value = this.target.texture;
    googleTexUniforms.tdGDepth.value = this.target.depthTexture;
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
    tiles.errorTarget = 12;
    tiles.autoDisableRendererCulling = false;
    // own cache, well below the PLATEAU one: this is only a colour source
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
      this.message = (msg || 'load error').slice(0, 160);
      console.warn('[google] tileset unavailable:', this.message);
      this.disable(true);
    });
    this.holder.add(tiles.group);
    // This scene is never part of the main render, so nothing updates its world matrices for
    // us: without this the tiles sit at raw ECEF coordinates, fail every frustum test and are
    // never requested (the layer stayed at "loading" forever).
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
    googleTexUniforms.tdGOn.value = 0;
    if (!keepStatus) { this.status = 'off'; this.message = ''; }
    this.attributions = [];
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

  /** Stream tiles for the current view. Call after the camera has moved. */
  update(): void {
    if (!this.tiles) return;
    const c = this.cam, g = this.camera;
    c.fov = g.fov; c.aspect = g.aspect; c.near = g.near; c.far = this.range;
    c.updateProjectionMatrix();
    c.matrixWorld.copy(g.matrixWorld); c.matrixWorldInverse.copy(g.matrixWorldInverse);
    this.scene.updateMatrixWorld();
    try { this.tiles.setResolutionFromRenderer(c, this.renderer); this.tiles.update(); }
    catch (e) { this.status = 'error'; this.message = String(e); this.disable(true); }
  }

  /** Render the colour source off-screen. Call right before the main render. */
  render(): void {
    const source = this.debugSource ?? (this.tiles && this.status === 'on' ? this.scene : null);
    googleTexUniforms.tdGOn.value = source ? 1 : 0;
    if (!source) return;
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    googleTexUniforms.tdGRes.value.copy(this.size);
    const w = Math.max(1, Math.round(this.size.x * this.scale)), h = Math.max(1, Math.round(this.size.y * this.scale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const g = this.camera;
    googleTexUniforms.tdGNearFar.value.set(g.near, g.far);
    googleTexUniforms.tdGRange.value = this.range;
    const prevTarget = r.getRenderTarget(), prevShadow = r.shadowMap.autoUpdate, prevClear = r.getClearAlpha();
    const prevColor = r.getClearColor(new THREE.Color());
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(this.target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    const ov = (source.userData as any).tdOverride as THREE.Material | undefined; // test hook
    if (ov) source.overrideMaterial = ov;
    r.render(source, g);
    if (ov) source.overrideMaterial = null;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevClear);
    r.shadowMap.autoUpdate = prevShadow;
  }
}

/** GLSL inserted into the facade shader: replaces `diffuseColor.rgb` with Google's colour on a depth match. */
export const GOOGLE_FACADE_GLSL = /* glsl */ `
  if (tdGOn > 0.5) {
    // Google's photogrammetry never lines up exactly with PLATEAU's walls: surfaces bulge,
    // sag and are often shifted a few metres. A strict per-pixel depth match therefore
    // breaks a wall into patches. Instead:
    //  - tolerances are asymmetric: Google's surface lying BEHIND the wall (recessed, or a
    //    slightly smaller scanned building) is accepted generously; one IN FRONT of it (a
    //    tree, another building) only within a small margin;
    //  - five samples around the pixel vote, and the accepted ones are averaged, which
    //    removes the ragged patch edges.
    float tdFz = -(viewMatrix * vec4(tdWP, 1.0)).z;
    // Measure the mismatch as distance from the wall's plane, not along the view ray: street
    // walls are seen at grazing angles, where a small shift of the scanned wall moves the
    // hit point far along the ray while it stays close to the wall.
    float tdCos = max(abs(dot(normalize(tdWN), normalize(tdWP - cameraPosition))), 0.12);
    float tdBack = 2.5 + tdFz * 0.01, tdFront = 1.2 + tdFz * 0.005;
    vec2 tdUv = gl_FragCoord.xy / tdGRes;
    vec2 tdTx = 3.0 / vec2(textureSize(tdGColor, 0));
    vec3 tdSum = vec3(0.0); float tdW = 0.0;
    for (int k = 0; k < 5; k++) {
      vec2 o = k == 0 ? vec2(0.0) : k == 1 ? vec2(tdTx.x, 0.0) : k == 2 ? vec2(-tdTx.x, 0.0) : k == 3 ? vec2(0.0, tdTx.y) : vec2(0.0, -tdTx.y);
      vec4 c = texture2D(tdGColor, tdUv + o);
      float d = texture2D(tdGDepth, tdUv + o).r;
      float gz = (tdGNearFar.x * tdGNearFar.y) / (tdGNearFar.y - d * (tdGNearFar.y - tdGNearFar.x));
      float dz = (gz - tdFz) * tdCos;                         // > 0: Google surface is behind the wall plane
      float ok = c.a * (dz >= 0.0 ? 1.0 - smoothstep(tdBack, tdBack * 1.5, dz) : 1.0 - smoothstep(tdFront, tdFront * 1.5, -dz));
      tdSum += c.rgb * ok; tdW += ok;
    }
    float tdHit = smoothstep(0.15, 0.6, tdW / 5.0) * (1.0 - smoothstep(tdGRange * 0.8, tdGRange, tdFz));
    if (tdW > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, tdSum / tdW, tdHit);
  }
`;

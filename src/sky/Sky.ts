// Sky / atmosphere / sun via three-geospatial's atmosphere package (§9.3).
// Sun direction is computed from date + the local frame's position on Earth.
import * as THREE from 'three';
import {
  AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyLightProbe, SkyMaterial,
  SunDirectionalLight, getMoonDirectionECEF, getSunDirectionECEF,
} from '@takram/three-atmosphere';
import { EffectComposer, EffectPass, RenderPass, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { frame } from '../geo/geodesy';

export class Sky {
  readonly composer: EffectComposer;
  private skyMaterial = new SkyMaterial();
  private sunLight = new SunDirectionalLight({ distance: 300 });
  private skyLight = new SkyLightProbe();
  private aerial: AerialPerspectiveEffect;
  private sunDir = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  private localToEcef = new THREE.Matrix4();
  date: Date;
  ready = false;
  private shadowCenter = new THREE.Vector3(1e9, 0, 1e9);
  private shadowRange = 0;
  private shadowDirty = true;
  private lastShadowTime = 0;
  private renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.renderer = renderer;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // refreshed on demand, see update()
    // default: a clear late morning in Tokyo (10:30 JST), today's date
    const now = new Date();
    this.date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 30, 0));

    this.localToEcef.fromArray(frame.ecefToLocalMatrix()).invert();
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
    sky.frustumCulled = false; sky.renderOrder = -10; sky.name = 'sky';
    scene.add(sky);
    scene.add(this.skyLight, this.sunLight, this.sunLight.target);
    // neutral fill so shadowed facades are not lit by blue sky light alone
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 0.2));

    this.aerial = new AerialPerspectiveEffect(camera);
    for (const o of [this.skyMaterial, this.sunLight, this.skyLight, this.aerial] as any[]) o.worldToECEFMatrix.copy(this.localToEcef);

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 10;
    this.composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new EffectPass(camera, this.aerial, new ToneMappingEffect({ mode: ToneMappingMode.AGX })));

    const generator = new PrecomputedTexturesGenerator(renderer);
    generator.update().then(() => { this.ready = true; }).catch((e: unknown) => console.error('[sky] precompute failed', e));
    const { textures } = generator;
    Object.assign(this.skyMaterial, textures);
    this.sunLight.transmittanceTexture = textures.transmittanceTexture;
    this.skyLight.irradianceTexture = textures.irradianceTexture;
    Object.assign(this.aerial, textures);
  }

  /** Atmospheric haze costs a full-screen pass; Performance quality turns it off. */
  setAerial(on: boolean): void { this.aerial.inscatter = on; this.aerial.transmittance = on; }

  /** Sun shadows. size 0 disables them. */
  setShadows(size: number, range: number): void {
    const on = size > 0;
    this.renderer.shadowMap.enabled = on;
    this.sunLight.castShadow = on;
    this.shadowRange = range;
    if (on) {
      const sh = this.sunLight.shadow, cam = sh.camera;
      if (sh.mapSize.x !== size) { sh.mapSize.set(size, size); sh.map?.dispose(); (sh as any).map = null; }
      cam.left = -range; cam.right = range; cam.top = range; cam.bottom = -range; cam.near = 1; cam.far = 900;
      cam.updateProjectionMatrix();
      sh.bias = -0.0004; sh.normalBias = (range * 2 / size) * 2.5;
      this.sunLight.distance = 450;
    }
    this.shadowDirty = true;
    this.shadowCenter.set(1e9, 0, 1e9);
  }

  /** Ask for a shadow map refresh (e.g. new buildings appeared). */
  invalidateShadows(): void { this.shadowDirty = true; }

  setSize(w: number, h: number): void { this.composer.setSize(w, h); }

  /** Sun elevation above the local horizon, degrees. */
  get sunElevation(): number {
    const d = this.sunDir.clone().transformDirection(new THREE.Matrix4().fromArray(frame.ecefToLocalMatrix()));
    return (Math.asin(d.y) * 180) / Math.PI;
  }

  update(focus: THREE.Vector3): void {
    getSunDirectionECEF(this.date, this.sunDir);
    getMoonDirectionECEF(this.date, this.moonDir);
    this.skyMaterial.sunDirection.copy(this.sunDir);
    this.skyMaterial.moonDirection.copy(this.moonDir);
    this.sunLight.sunDirection.copy(this.sunDir);
    this.skyLight.sunDirection.copy(this.sunDir);
    this.aerial.sunDirection.copy(this.sunDir);
    this.aerial.moonDirection.copy(this.moonDir);
    // Shadow trick: buildings are static and the sun barely moves, so the shadow map is
    // only re-rendered when the car has left the centre of the shadowed area or new
    // geometry arrived - not every frame. The car itself uses a cheap blob shadow.
    const now = performance.now();
    if (this.shadowRange > 0) {
      const far = Math.hypot(focus.x - this.shadowCenter.x, focus.z - this.shadowCenter.z) > this.shadowRange * 0.3;
      if (far || (this.shadowDirty && now - this.lastShadowTime > 600)) {
        this.shadowCenter.copy(focus);
        this.shadowDirty = false; this.lastShadowTime = now;
        this.renderer.shadowMap.needsUpdate = true;
      }
      this.sunLight.target.position.copy(this.shadowCenter);
    } else this.sunLight.target.position.copy(focus);
    this.sunLight.target.updateMatrixWorld();
    this.skyLight.position.copy(focus);
    this.sunLight.update();
    this.skyLight.update();
  }

  render(dt: number): void { this.composer.render(dt); }
}

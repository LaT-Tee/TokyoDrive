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

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    // default: a clear late morning in Tokyo (10:30 JST), today's date
    const now = new Date();
    this.date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 30, 0));

    this.localToEcef.fromArray(frame.ecefToLocalMatrix()).invert();
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMaterial);
    sky.frustumCulled = false; sky.renderOrder = -10; sky.name = 'sky';
    scene.add(sky);
    scene.add(this.skyLight, this.sunLight, this.sunLight.target);
    // neutral fill so shadowed facades are not lit by blue sky light alone
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8478, 0.55));

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
    this.sunLight.target.position.copy(focus);
    this.skyLight.position.copy(focus);
    this.sunLight.update();
    this.skyLight.update();
  }

  render(dt: number): void { this.composer.render(dt); }
}

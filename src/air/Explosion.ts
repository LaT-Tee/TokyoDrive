// An aircraft hitting a building, a road or the ground: fireball, flash, flying debris,
// and a column of smoke that keeps rising from the wreck until the player takes off
// again (R). Plain meshes, no textures.
import * as THREE from 'three';

const DEBRIS = 16;

/** Fire: hot yellow-orange where the ball faces the camera, dark red at its rim, with
 *  rolling noise; `heat` 1 -> 0 cools it. The frame is exposed and hazed in post, so the
 *  contrast has to be in the material itself. */
function fireMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { heat: { value: 1 }, time: { value: 0 }, seed: { value: 0 } },
    vertexShader: `
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vP = position; vN = normalize(mat3(modelMatrix) * normal); vV = normalize(cameraPosition - w.xyz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float heat; uniform float time; uniform float seed;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float n3(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      void main() {
        float facing = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float n = n3(vP * 2.3 + vec3(0.0, -time * 2.5, seed)) * 0.6 + n3(vP * 5.1 + vec3(seed, time * 1.7, 0.0)) * 0.4;
        float t = clamp(pow(facing, 1.2) * (0.25 + 1.1 * n) * (0.35 + 0.8 * heat), 0.0, 1.0);
        vec3 col = mix(vec3(0.03, 0.002, 0.0), vec3(0.32, 0.025, 0.0), smoothstep(0.0, 0.4, t));
        col = mix(col, vec3(0.62, 0.17, 0.005), smoothstep(0.4, 0.95, t));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
const PUFFS = 14;

interface Bit { mesh: THREE.Mesh; v: THREE.Vector3; spin: THREE.Vector3; rest: boolean }
interface Puff { mesh: THREE.Mesh; age: number; life: number; v: number; size: number }

export class Explosion {
  readonly group = new THREE.Group();
  private fire: THREE.Mesh;
  private core: THREE.Mesh;
  /** Lobes of the fireball: offset direction and size, re-rolled per blast. */
  private lobes: { m: THREE.Mesh; dir: THREE.Vector3; k: number; speed: number }[] = [];
  private light = new THREE.PointLight(0xffa860, 0, 180, 2);
  private bits: Bit[] = [];
  private puffs: Puff[] = [];
  private t = -1;          // seconds since the blast, -1 = idle
  private smoking = false;
  private nextPuff = 0;
  private floor = 0;
  private origin = new THREE.Vector3();

  constructor() {
    this.group.name = 'explosion';
    this.group.visible = false;
    // Deep, saturated colours that write depth: the frame is exposed, tone-mapped and hazed
    // in post by depth, so additive or very bright fire comes out as a pale cream disc.
    const ball = new THREE.IcosahedronGeometry(1, 4);
    // opaque: translucent fire is washed out further by the post pipeline; it dies by shrinking
    this.fire = new THREE.Mesh(ball, fireMaterial());
    this.core = new THREE.Mesh(ball, fireMaterial());
    this.core.visible = false; // the lobes carry the look; kept for the flash
    this.core.renderOrder = 2;
    this.group.add(this.fire, this.core, this.light);
    // billows: the same fire material on a few offset balls, so the blast is not one sphere
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(ball, this.fire.material);
      this.group.add(m);
      this.lobes.push({ m, dir: new THREE.Vector3(), k: 1, speed: 1 });
    }
    const box = new THREE.BoxGeometry(1, 1, 1);
    const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
    for (let i = 0; i < DEBRIS; i++) {
      const m = new THREE.Mesh(box, dark);
      this.group.add(m);
      this.bits.push({ mesh: m, v: new THREE.Vector3(), spin: new THREE.Vector3(), rest: false });
    }
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < PUFFS; i++) {
      const m = new THREE.Mesh(puff, new THREE.MeshLambertMaterial({ color: 0x1c1c1c, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false;
      this.group.add(m);
      this.puffs.push({ mesh: m, age: 0, life: 1, v: 0, size: 1 });
    }
  }

  get active(): boolean { return this.t >= 0; }

  /** Blast at (x, y, z); `floor` = ground height there (debris stops on it). */
  start(x: number, y: number, z: number, floor: number): void {
    this.origin.set(x, y, z); this.floor = floor;
    this.group.visible = true; this.t = 0; this.smoking = true; this.nextPuff = 0;
    this.fire.position.copy(this.origin); this.core.position.copy(this.origin);
    for (const l of this.lobes) {
      l.dir.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      l.k = 0.45 + Math.random() * 0.35; l.speed = 0.6 + Math.random() * 0.6;
    }
    (this.fire.material as THREE.ShaderMaterial).uniforms.seed.value = Math.random() * 50;
    this.light.position.copy(this.origin).y += 4;
    for (const b of this.bits) {
      const a = Math.random() * Math.PI * 2, up = 0.35 + Math.random() * 0.9, s = 14 + Math.random() * 26;
      b.mesh.position.copy(this.origin);
      b.mesh.scale.set(0.4 + Math.random() * 1.6, 0.2 + Math.random() * 0.5, 0.4 + Math.random() * 1.4);
      b.v.set(Math.cos(a) * s * (1 - up * 0.5), up * s, Math.sin(a) * s * (1 - up * 0.5));
      b.spin.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      b.rest = false; b.mesh.visible = true;
    }
    for (const p of this.puffs) { p.mesh.visible = false; p.age = 0; }
  }

  /** The wreck is gone (player took off again): smoke thins out, then everything goes. */
  stop(): void { this.smoking = false; }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    const t = this.t;
    // fireball: expands fast, cools from yellow to dull red, fades within ~1.5 s
    // grows fast, then collapses into the smoke
    const r = (3 + 19 * (1 - Math.exp(-t * 4.5))) * (t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.7));
    this.fire.scale.setScalar(r);
    const heat = Math.max(0, 1 - t / 1.4);
    const fu = (this.fire.material as THREE.ShaderMaterial).uniforms;
    fu.heat.value = heat; fu.time.value = t;
    this.core.scale.setScalar(r * 0.62 * Math.max(0, 1 - t / 0.9));
    this.fire.visible = t < 1.4; this.core.visible = false;
    this.fire.scale.setScalar(r * 0.7);
    for (const l of this.lobes) {
      l.m.visible = this.fire.visible;
      l.m.position.copy(this.origin).addScaledVector(l.dir, r * 0.55 * l.speed);
      l.m.scale.setScalar(r * l.k);
    }
    this.light.intensity = 2.5e4 * Math.exp(-t * 4);
    // debris: ballistic, tumbling, stops on the ground
    for (const b of this.bits) {
      if (b.rest) continue;
      b.v.y -= 9.81 * dt;
      b.mesh.position.addScaledVector(b.v, dt);
      b.mesh.rotation.x += b.spin.x * dt; b.mesh.rotation.y += b.spin.y * dt; b.mesh.rotation.z += b.spin.z * dt;
      if (b.mesh.position.y < this.floor + 0.2) { b.mesh.position.y = this.floor + 0.2; b.rest = true; }
    }
    // smoke: puffs rise, grow and fade; new ones keep coming while the wreck is there
    this.nextPuff -= dt;
    if (this.smoking && this.nextPuff <= 0) {
      const p = this.puffs.find((q) => !q.mesh.visible);
      if (p) {
        p.age = 0; p.life = 4 + Math.random() * 3; p.v = 4 + Math.random() * 4; p.size = 2.5 + Math.random() * 3;
        p.mesh.position.set(this.origin.x + (Math.random() - 0.5) * 10, this.origin.y + 1 + Math.random() * 3, this.origin.z + (Math.random() - 0.5) * 10);
        p.mesh.visible = true;
      }
      this.nextPuff = t < 2 ? 0.08 : 0.45;
    }
    let any = false;
    for (const p of this.puffs) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      if (p.age > p.life) { p.mesh.visible = false; continue; }
      any = true;
      const k = p.age / p.life;
      p.mesh.position.y += p.v * dt; p.mesh.position.x += 1.5 * dt;
      p.mesh.scale.setScalar(p.size * (1 + k * 2.2));
      (p.mesh.material as THREE.MeshLambertMaterial).opacity = 0.55 * (1 - k) * Math.min(1, p.age * 3);
    }
    if (!this.smoking && !any && t > 2) { this.group.visible = false; this.t = -1; this.light.intensity = 0; for (const b of this.bits) b.mesh.visible = false; }
  }
}

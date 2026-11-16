// Aircraft: a propeller plane and a helicopter. Like the car, both are
// kinematic models with an arcade feel - no rigid-body engine.
// Heading is clockwise from north; forward = (sin h, 0, -cos h); pitch > 0 is nose up.
import * as THREE from 'three';
import type { VehicleKind } from '../car/garage';

export interface AirInput {
  pitch: number;    // plane: -1 nose down … +1 nose up      heli: +1 forward … -1 backward
  roll: number;     // plane: -1 left … +1 right             heli: yaw, -1 left … +1 right
  lift: number;     // plane: throttle change -1 … +1        heli: collective, -1 down … +1 up
  side: number;     // plane: rudder                         heli: strafe, -1 left … +1 right
}

const G = 9.81;
export const AIR_SPAWN_AGL = 300;  // metres above the ground when deployed
export const AIR_CEILING = 2500;   // metres above the ground

export class AircraftController {
  kind: VehicleKind = 'plane';
  x = 0; y = 0; z = 0;
  heading = 0; pitch = 0; roll = 0;
  speed = 0;          // m/s: airspeed (plane) or ground speed (heli)
  vy = 0;             // vertical speed, m/s
  throttle = 0.65;    // plane only
  rpm = 2300;
  load = 0.6;
  rotor = 0;          // propeller / rotor angle for the visual
  crashed = false;
  // helicopter velocity in its own frame
  private vf = 0; private vs = 0;

  // plane envelope (m/s)
  readonly stall = 28; readonly cruise = 61; readonly vmax = 83;
  // helicopter envelope (m/s)
  readonly heliMax = 67;

  /** Put the aircraft in the air, already flying. */
  deploy(x: number, groundY: number, z: number, headingRad: number): void {
    this.x = x; this.z = z; this.y = groundY + AIR_SPAWN_AGL; this.heading = headingRad;
    this.pitch = 0; this.roll = 0; this.vy = 0; this.vs = 0; this.crashed = false;
    if (this.kind === 'plane') { this.speed = this.cruise; this.throttle = 0.65; }
    else { this.speed = 0; this.vf = 0; }
  }

  update(dt: number, input: AirInput, groundY: number): void {
    if (this.kind === 'plane') this.updatePlane(dt, input); else this.updateHeli(dt, input);
    const top = groundY + AIR_CEILING;
    if (this.y > top) { this.y = top; if (this.vy > 0) this.vy = 0; if (this.pitch > 0) this.pitch *= 0.9; }
  }

  private updatePlane(dt: number, i: AirInput): void {
    this.throttle = Math.max(0, Math.min(1, this.throttle + i.lift * dt * 0.5));
    // roll and pitch follow the stick; both relax to level when it is released
    this.roll += (i.roll * 1.15 - this.roll) * Math.min(1, dt * 2.4);
    this.pitch += (i.pitch * 0.55 - this.pitch) * Math.min(1, dt * 1.7);
    // climbing trades speed for height, diving does the opposite
    const target = this.stall * 1.1 + (this.vmax - this.stall * 1.1) * this.throttle;
    this.speed += ((target - this.speed) * 0.35 - G * Math.sin(this.pitch) * 0.75) * dt;
    this.speed = Math.max(12, Math.min(this.vmax * 1.25, this.speed));
    if (this.speed < this.stall) this.pitch -= dt * 0.9 * (1 - this.speed / this.stall + 0.3); // stall: the nose drops
    // a banked wing turns the aircraft (coordinated turn) + a little rudder
    this.heading += ((G * Math.tan(this.roll)) / Math.max(this.speed, 22) + i.side * 0.25) * dt;
    const cp = Math.cos(this.pitch);
    this.vy = Math.sin(this.pitch) * this.speed;
    this.x += Math.sin(this.heading) * cp * this.speed * dt;
    this.z -= Math.cos(this.heading) * cp * this.speed * dt;
    this.y += this.vy * dt;
    this.load = this.throttle;
    this.rpm = 1500 + this.throttle * 1150 + Math.max(0, this.speed - this.cruise) * 6;
    this.rotor += dt * (this.rpm / 60) * Math.PI * 2 * 0.25; // slowed for the eye (aliasing)
  }

  private updateHeli(dt: number, i: AirInput): void {
    this.heading += i.roll * 1.15 * dt;
    const k = Math.min(1, dt * 0.9);
    this.vf += (i.pitch * this.heliMax - this.vf) * k;
    this.vs += (i.side * 16 - this.vs) * Math.min(1, dt * 1.6);
    this.vy += (i.lift * 13 - this.vy) * Math.min(1, dt * 1.8);
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    this.x += (fx * this.vf - fz * this.vs) * dt;
    this.z += (fz * this.vf + fx * this.vs) * dt;
    this.y += this.vy * dt;
    this.speed = Math.hypot(this.vf, this.vs);
    // the fuselage tilts into its motion
    this.pitch += (-(this.vf / this.heliMax) * 0.32 - this.pitch) * Math.min(1, dt * 3);
    this.roll += ((this.vs / 16) * 0.3 + i.roll * 0.12 * Math.min(1, Math.abs(this.vf) / 30) - this.roll) * Math.min(1, dt * 3);
    this.load = Math.min(1, 0.45 + Math.abs(i.lift) * 0.35 + this.speed / this.heliMax * 0.3);
    this.rpm = 390 + this.load * 25;
    this.rotor += dt * 7.5; // visually slowed
  }
}

// ---------------------------------------------------------------- visuals
// Built from primitives in code (no model files, nothing to license).
export class AircraftVisual {
  readonly root = new THREE.Group();
  private plane = new THREE.Group();
  private heli = new THREE.Group();
  private prop = new THREE.Group();
  private mainRotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private paint = new THREE.MeshStandardMaterial({ color: 0xd7263d, roughness: 0.35, metalness: 0.2 });
  private white = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, roughness: 0.4, metalness: 0.1 });
  private dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 });
  private glass = new THREE.MeshStandardMaterial({ color: 0x0c1722, roughness: 0.08, metalness: 0.6 });
  private blur = new THREE.MeshBasicMaterial({ color: 0x060606, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });

  constructor() {
    this.buildPlane(); this.buildHeli();
    this.root.add(this.plane, this.heli);
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material !== this.blur) { m.receiveShadow = true; m.castShadow = true; } });
    this.setKind('plane');
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); parent.add(o); return o;
  }

  private buildPlane(): void {
    const p = this.plane;
    // fuselage along Z (nose at -Z): a lathe profile gives a proper tapered body
    const prof = [[0, -4.1], [0.35, -4.0], [0.62, -3.4], [0.72, -2.2], [0.74, -0.6], [0.66, 1.0], [0.42, 2.6], [0.2, 3.8], [0.06, 4.2], [0, 4.25]].map(([r, z]) => new THREE.Vector2(r, z));
    this.mesh(new THREE.LatheGeometry(prof, 20).rotateX(Math.PI / 2).scale(1, 1.08, 1), this.white, p);
    this.mesh(new THREE.SphereGeometry(0.66, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.92, 0.72, 1.7), this.glass, p, 0, 0.5, -1.2); // canopy
    // high wing with a slight taper and dihedral, struts, tail surfaces
    const wing = new THREE.Shape(); wing.moveTo(-5.5, -0.45); wing.lineTo(5.5, -0.45); wing.lineTo(5.5, 0.4); wing.lineTo(0.9, 0.85); wing.lineTo(-0.9, 0.85); wing.lineTo(-5.5, 0.4); wing.closePath();
    this.mesh(new THREE.ExtrudeGeometry(wing, { depth: 0.16, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 }).rotateX(Math.PI / 2), this.paint, p, 0, 1.0, -0.9);
    for (const s of [-1, 1]) { const st = this.mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6), this.dark, p, s * 1.55, 0.2, -1.0); st.rotation.z = s * 1.02; }
    const tail = new THREE.Shape(); tail.moveTo(-1.9, -0.25); tail.lineTo(1.9, -0.25); tail.lineTo(1.9, 0.2); tail.lineTo(0.3, 0.55); tail.lineTo(-0.3, 0.55); tail.lineTo(-1.9, 0.2); tail.closePath();
    this.mesh(new THREE.ExtrudeGeometry(tail, { depth: 0.1, bevelEnabled: false }).rotateX(Math.PI / 2), this.paint, p, 0, 0.25, 3.5);
    const fin = new THREE.Shape(); fin.moveTo(0, 0); fin.lineTo(1.25, 0); fin.lineTo(1.05, 1.45); fin.lineTo(0.55, 1.45); fin.closePath();
    this.mesh(new THREE.ExtrudeGeometry(fin, { depth: 0.1, bevelEnabled: false }).rotateY(-Math.PI / 2), this.paint, p, 0.05, 0.15, 2.85);
    // fixed gear
    for (const s of [-1, 1]) { this.mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.0, 6), this.dark, p, s * 0.75, -0.95, -1.2).rotation.z = s * 0.5; this.mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.14, 14).rotateZ(Math.PI / 2), this.dark, p, s * 1.0, -1.38, -1.2); }
    this.mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 12).rotateZ(Math.PI / 2), this.dark, p, 0, -1.3, -3.2);
    // propeller: spinner, two blades and a blur disc
    this.prop.position.set(0, 0, -4.15); p.add(this.prop);
    this.mesh(new THREE.ConeGeometry(0.22, 0.5, 12).rotateX(-Math.PI / 2), this.dark, this.prop, 0, 0, -0.15);
    this.mesh(new THREE.BoxGeometry(0.16, 2.0, 0.04), this.dark, this.prop);
    this.mesh(new THREE.CircleGeometry(1.0, 28), this.blur, this.prop, 0, 0, -0.02);
  }

  private buildHeli(): void {
    const h = this.heli;
    this.mesh(new THREE.SphereGeometry(1, 20, 14).scale(1.05, 1.0, 2.1), this.paint, h, 0, 0, -0.4);                       // cabin
    this.mesh(new THREE.SphereGeometry(0.98, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.62).rotateX(-Math.PI / 2).scale(0.98, 0.9, 1.15), this.glass, h, 0, 0.12, -1.35); // nose glazing
    const boom = this.mesh(new THREE.CylinderGeometry(0.34, 0.12, 5.2, 12).rotateX(Math.PI / 2), this.paint, h, 0, 0.35, 3.6); boom.rotation.x = -0.05;
    this.mesh(new THREE.BoxGeometry(0.08, 1.5, 0.9), this.paint, h, 0, 0.95, 6.0).rotation.x = -0.35;                         // fin
    this.mesh(new THREE.BoxGeometry(1.9, 0.07, 0.5), this.paint, h, 0, 0.4, 5.3);                                             // stabiliser
    this.mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.55, 12), this.white, h, 0, 1.05, 0);                                    // engine housing
    this.mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.6, 8), this.dark, h, 0, 1.55, 0);                                      // mast
    for (const s of [-1, 1]) {                                                                                                // skids
      this.mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.6, 8).rotateX(Math.PI / 2), this.dark, h, s * 1.05, -1.35, -0.3);
      for (const z of [-1.3, 0.7]) this.mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), this.dark, h, s * 0.82, -0.95, z).rotation.z = s * 0.5;
    }
    this.mainRotor.position.set(0, 1.86, 0); h.add(this.mainRotor);
    this.mesh(new THREE.BoxGeometry(10.4, 0.05, 0.3), this.dark, this.mainRotor);
    this.mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 12), this.dark, this.mainRotor);
    this.mesh(new THREE.CircleGeometry(5.2, 40).rotateX(-Math.PI / 2), this.blur, this.mainRotor, 0, -0.01, 0);
    this.tailRotor.position.set(0.22, 1.05, 6.1); h.add(this.tailRotor);
    this.mesh(new THREE.BoxGeometry(0.04, 1.7, 0.14), this.dark, this.tailRotor);
    this.mesh(new THREE.CircleGeometry(0.85, 20).rotateY(Math.PI / 2), this.blur, this.tailRotor);
  }

  setKind(kind: VehicleKind): void { this.plane.visible = kind === 'plane'; this.heli.visible = kind === 'heli'; }
  setColor(hex: string): void { this.paint.color.set(hex); }
  refreshMaterials(): void { for (const m of [this.paint, this.white, this.dark, this.glass]) m.needsUpdate = true; }

  animate(a: AircraftController): void {
    this.prop.rotation.z = a.rotor;
    this.mainRotor.rotation.y = a.rotor;
    this.tailRotor.rotation.x = a.rotor * 3;
  }
}

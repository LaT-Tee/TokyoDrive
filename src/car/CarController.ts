// Kinematic bicycle model (CLAUDE.md §3). No rigid-body physics.
// Heading is measured clockwise from north; forward = (sin h, 0, -cos h).
import { WALL_PROBE_DIST } from '../config';
import type { Ground } from '../world/Ground';
import type { CarSpec } from './garage';

export interface CarInput { throttle: number; brake: number; steer: number; handbrake: boolean }

const D2R = Math.PI / 180;

export class CarController {
  x = 0; y = 0; z = 0;
  heading = 0;      // rad, clockwise from north
  speed = 0;        // m/s, signed (negative = reversing)
  steer = 0;        // rad, current front wheel angle (positive = right)
  pitch = 0; roll = 0;
  vy = 0;           // vertical speed while airborne
  airborne = false;
  blocked = false;  // wall probe hit this frame
  odometer = 0;     // metres travelled
  wheelSpin = 0;
  minClearance = 0; maxClearance = 0; // ground-follow error stats (for checks)

  constructor(private ground: Ground, public spec: CarSpec) {}

  place(x: number, z: number, headingDeg: number): void {
    this.x = x; this.z = z; this.heading = headingDeg * D2R;
    this.speed = 0; this.steer = 0; this.vy = 0; this.airborne = false;
    this.y = this.ground.surface(x, z, this.ground.terrain.heightAt(x, z) + 0.5);
    this.pitch = 0; this.roll = 0;
  }

  update(dt: number, input: CarInput): void {
    const s = this.spec;
    const vmax = s.topSpeed / 3.6;
    // --- steering: ~32 deg at standstill, decreasing with speed
    const maxSteer = (32 * D2R) / (1 + (Math.abs(this.speed) / 14) ** 1.6);
    const target = input.steer * maxSteer;
    const rate = (input.steer === 0 ? 2.6 : 1.9) * dt;
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));

    // --- longitudinal
    let a = 0;
    const v = this.speed;
    if (input.throttle > 0) {
      if (v < -0.3) a += s.brake * input.throttle;                     // braking out of reverse
      else a += s.accel * input.throttle * Math.max(0, 1 - (v / vmax) ** 2);
    }
    if (input.brake > 0) {
      if (v > 0.3) a -= s.brake * input.brake;                         // brake
      else a -= s.accel * 0.6 * input.brake * Math.max(0, 1 - (-v / (vmax * 0.25)) ** 2); // then reverse
    }
    // rolling resistance + aero drag
    a -= Math.sign(v) * (0.35 + 0.0009 * v * v);
    if (input.handbrake) a -= Math.sign(v) * 14;
    let nv = v + a * dt;
    if ((input.handbrake || (input.throttle === 0 && input.brake === 0)) && Math.sign(nv) !== Math.sign(v) && v !== 0) nv = 0;
    if (Math.abs(nv) < 0.02 && input.throttle === 0 && input.brake === 0) nv = 0;
    this.speed = Math.max(-vmax * 0.25, Math.min(vmax, nv));

    // --- kinematic bicycle
    const L = s.wheelbase;
    const yawRate = (this.speed / L) * Math.tan(this.steer);
    this.heading += yawRate * dt;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    let dx = fx * this.speed * dt, dz = fz * this.speed * dt;

    // --- wall probe: ~2 m beyond the bumper in the direction of travel
    this.blocked = false;
    if (this.speed !== 0) {
      const dir = Math.sign(this.speed);
      const reach = s.length / 2 + WALL_PROBE_DIST;
      const rx = -fz, rz = fx; // right vector
      for (const side of [0, -0.45, 0.45]) {
        const px = this.x + fx * dir * reach + rx * side * s.width;
        const pz = this.z + fz * dir * reach + rz * side * s.width;
        // compare against the surface at the bumper, WALL_PROBE_DIST behind the probe
        const bx = this.x + fx * dir * (s.length / 2) + rx * side * s.width;
        const bz = this.z + fz * dir * (s.length / 2) + rz * side * s.width;
        const by = this.ground.surface(bx, bz, this.y);
        const onDeck = this.ground.lastOnDeck;
        if (this.ground.isWall(px, pz, Math.max(by, this.y - 0.3), WALL_PROBE_DIST, onDeck)) { this.blocked = true; break; }
      }
      if (this.blocked) { this.speed = 0; dx = 0; dz = 0; } // cancel motion into the wall
    }
    this.x += dx; this.z += dz;
    this.odometer += Math.hypot(dx, dz);
    this.wheelSpin += (this.speed * dt) / s.wheelRadius;

    // --- ground following: sample under both axles and both sides
    const half = L / 2, hw = s.width * 0.4;
    const rx = -fz, rz = fx;
    const hf = this.ground.surface(this.x + fx * half, this.z + fz * half, this.y);
    const hr = this.ground.surface(this.x - fx * half, this.z - fz * half, this.y);
    const hl = this.ground.surface(this.x - rx * hw, this.z - rz * hw, this.y);
    const hR = this.ground.surface(this.x + rx * hw, this.z + rz * hw, this.y);
    const gy = (hf + hr) / 2;
    if (this.y > gy + 0.25) {
      // drove off an edge: fall
      this.airborne = true;
      this.vy -= 9.81 * dt;
      this.y += this.vy * dt;
      if (this.y <= gy) { this.y = gy; this.vy = 0; this.airborne = false; }
    } else {
      this.airborne = false; this.vy = 0;
      // critically damped follow so tile seams do not jolt the car, but never below ground
      this.y += (gy - this.y) * Math.min(1, dt * 25);
      if (this.y < gy - 0.02) this.y = gy - 0.02;
    }
    const tp = Math.atan2(hf - hr, L), tr = Math.atan2(hl - hR, hw * 2);
    const k = Math.min(1, dt * 10);
    this.pitch += (Math.max(-0.5, Math.min(0.5, tp)) - this.pitch) * k;
    this.roll += (Math.max(-0.4, Math.min(0.4, tr)) - this.roll) * k;
    const clr = this.y - gy;
    if (!this.airborne) { this.minClearance = Math.min(this.minClearance, clr); this.maxClearance = Math.max(this.maxClearance, clr); }
  }
}

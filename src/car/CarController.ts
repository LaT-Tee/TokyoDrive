// Kinematic bicycle model (CLAUDE.md §3) extended with a tyre-grip budget:
// no rigid-body engine, but lateral acceleration is limited by surface
// friction (friction circle shared with braking / traction), so the car
// understeers when pushed, slides when the handbrake unloads the rear, and
// behaves differently on asphalt and off-road.
// Heading is measured clockwise from north; forward = (sin h, 0, -cos h).
import { WALL_PROBE_DIST } from '../config';
import type { Ground } from '../world/Ground';
import type { CarSpec } from './garage';

export interface CarInput { throttle: number; brake: number; steer: number; handbrake: boolean }

const D2R = Math.PI / 180;
const G = 9.81;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class CarController {
  x = 0; y = 0; z = 0;
  heading = 0;      // rad, where the body points
  course = 0;       // rad, where the car is actually travelling (differs from heading while sliding)
  speed = 0;        // m/s along the course, signed (negative = reversing)
  steer = 0;        // rad, current front wheel angle (positive = right)
  pitch = 0; roll = 0;      // body attitude incl. terrain
  vy = 0;           // vertical speed while airborne
  airborne = false;
  blocked = false;  // wall probe hit this frame
  odometer = 0;     // metres travelled
  wheelSpin = 0;
  /** Surface friction coefficient under the car (set by the game: asphalt ≈ 1, off-road ≈ 0.6). */
  surfaceGrip = 1;
  slip = 0;         // rad, body slip angle (heading - course)
  aLat = 0; aLong = 0; // m/s^2, for body motion and tests
  minClearance = 0; maxClearance = 0; // ground-follow error stats (for checks)
  private bodyRoll = 0; private bodyPitch = 0;

  constructor(private ground: Ground, public spec: CarSpec) {}

  place(x: number, z: number, headingDeg: number): void {
    this.x = x; this.z = z; this.heading = headingDeg * D2R; this.course = this.heading;
    this.speed = 0; this.steer = 0; this.vy = 0; this.airborne = false; this.slip = 0;
    this.y = this.ground.surface(x, z, this.ground.terrain.heightAt(x, z) + 0.5);
    this.pitch = 0; this.roll = 0;
  }

  update(dt: number, input: CarInput): void {
    const s = this.spec;
    const vmax = s.topSpeed / 3.6;
    const mu = this.surfaceGrip * s.grip;
    const offRoad = this.surfaceGrip < 0.8;
    const v = this.speed, av = Math.abs(v);

    // --- steering: ~32 deg at standstill, decreasing with speed; self-centring
    const maxSteer = (32 * D2R) / (1 + (av / 13) ** 1.7);
    const target = input.steer * maxSteer;
    const rate = (input.steer === 0 ? 3.2 : 1.7 + 6 / (1 + av * 0.25)) * dt;
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));

    // --- longitudinal: traction- and power-limited drive, friction-limited braking
    let a = 0;
    const traction = mu * G * 0.62;
    if (input.throttle > 0) {
      if (v < -0.3) a += Math.min(s.brake, mu * 10.5) * input.throttle;                 // braking out of reverse
      else a += Math.min(traction, s.accel * Math.min(1, 9 / Math.max(av, 9)) ** 0.55) * input.throttle * Math.max(0, 1 - (v / vmax) ** 2);
    }
    if (input.brake > 0) {
      if (v > 0.3) a -= Math.min(s.brake, mu * 10.5) * input.brake;                     // brake
      else a -= Math.min(traction, s.accel * 0.6) * input.brake * Math.max(0, 1 - (-v / (vmax * 0.25)) ** 2); // then reverse
    }
    // rolling resistance (much higher off the road), engine braking, aero drag
    const coast = input.throttle === 0 ? 0.55 : 0;
    a -= Math.sign(v) * ((offRoad ? 1.5 : 0.3) + coast + 0.00085 * v * v);
    if (input.handbrake) a -= Math.sign(v) * Math.min(9, mu * 8.5);
    // sliding sideways scrubs speed
    a -= Math.sign(v) * Math.abs(Math.sin(this.slip)) * mu * G * 0.55;
    let nv = v + a * dt;
    if ((input.handbrake || (input.throttle === 0 && input.brake === 0)) && Math.sign(nv) !== Math.sign(v) && v !== 0) nv = 0;
    if (Math.abs(nv) < 0.03 && input.throttle === 0 && input.brake === 0) nv = 0;
    this.speed = Math.max(-vmax * 0.25, Math.min(vmax * (offRoad ? 0.6 : 1), nv));
    this.aLong = (this.speed - v) / Math.max(dt, 1e-4);

    // --- yaw: bicycle geometry, limited by the lateral grip left in the friction circle
    const L = s.wheelbase;
    const sp = this.speed, asp = Math.abs(sp);
    let yawRate = (sp / L) * Math.tan(this.steer);
    const used = Math.min(Math.abs(this.aLong), mu * G * 0.85);
    const latGrip = Math.sqrt(Math.max((mu * G) ** 2 - used * used, (0.35 * mu * G) ** 2));
    if (asp > 1) {
      const maxYaw = (latGrip / asp) * 1.12;                 // beyond this the front tyres just scrub (understeer)
      if (input.handbrake && sp > 4) yawRate *= 1.55;        // locked rears: the tail steps out
      else yawRate = Math.max(-maxYaw, Math.min(maxYaw, yawRate));
    }
    this.heading += yawRate * dt;

    // --- course follows the body as fast as the tyres can turn the velocity vector
    if (sp < 2.5) { this.course = this.heading; }
    else {
      const rearGrip = input.handbrake ? 0.4 : 1;
      const maxTurn = ((latGrip * rearGrip) / asp) * dt;
      const d = wrap(this.heading - this.course);
      this.course += Math.max(-maxTurn, Math.min(maxTurn, d));
      // the body cannot rotate arbitrarily far from the direction of travel
      const sl = wrap(this.heading - this.course);
      if (Math.abs(sl) > 1.05) this.heading = this.course + Math.sign(sl) * 1.05;
    }
    this.slip = wrap(this.heading - this.course);
    this.aLat = asp > 0.5 ? sp * yawRate : 0;

    const fx = Math.sin(this.course), fz = -Math.cos(this.course);
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
      if (this.blocked) { this.speed = 0; dx = 0; dz = 0; this.course = this.heading; } // cancel motion into the wall
    }
    this.x += dx; this.z += dz;
    this.odometer += Math.hypot(dx, dz);
    this.wheelSpin += (this.speed * dt) / s.wheelRadius;

    // --- ground following: sample under both axles and both sides
    const hx = Math.sin(this.heading), hz = -Math.cos(this.heading);
    const half = L / 2, hw = s.width * 0.4;
    const rx = -hz, rz = hx;
    const hf = this.ground.surface(this.x + hx * half, this.z + hz * half, this.y);
    const hr = this.ground.surface(this.x - hx * half, this.z - hz * half, this.y);
    const hl = this.ground.surface(this.x - rx * hw, this.z - rz * hw, this.y);
    const hR = this.ground.surface(this.x + rx * hw, this.z + rz * hw, this.y);
    const gy = (hf + hr) / 2;
    if (this.y > gy + 0.25) {
      // drove off an edge: fall
      this.airborne = true;
      this.vy -= G * dt;
      this.y += this.vy * dt;
      if (this.y <= gy) { this.y = gy; this.vy = 0; this.airborne = false; }
    } else {
      this.airborne = false; this.vy = 0;
      // critically damped follow so tile seams do not jolt the car, but never below ground
      this.y += (gy - this.y) * Math.min(1, dt * 25);
      if (this.y < gy - 0.02) this.y = gy - 0.02;
    }
    // body attitude = terrain slope + weight transfer (roll in corners, dive / squat)
    const k = Math.min(1, dt * 8);
    this.bodyRoll += (Math.max(-0.075, Math.min(0.075, this.aLat * 0.0085)) - this.bodyRoll) * k;
    this.bodyPitch += (Math.max(-0.05, Math.min(0.05, this.aLong * 0.0055)) - this.bodyPitch) * k;
    const tp = Math.atan2(hf - hr, L), tr = Math.atan2(hl - hR, hw * 2);
    const kt = Math.min(1, dt * 10);
    this.pitch += (Math.max(-0.5, Math.min(0.5, tp)) + this.bodyPitch - this.pitch) * kt;
    this.roll += (Math.max(-0.4, Math.min(0.4, tr)) + this.bodyRoll - this.roll) * kt;
    const clr = this.y - gy;
    if (!this.airborne) { this.minClearance = Math.min(this.minClearance, clr); this.maxClearance = Math.max(this.maxClearance, clr); }
  }
}

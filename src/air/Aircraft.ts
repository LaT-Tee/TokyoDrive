// Aircraft: a light business jet and a helicopter. Like the car, both are
// kinematic models with an arcade feel - no rigid-body engine.
// Heading is clockwise from north; forward = (sin h, 0, -cos h); pitch > 0 is nose up.
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
  rpm = 80;           // jet: fan speed N1 in %; helicopter: main rotor rpm
  load = 0.6;
  rotor = 0;          // propeller / rotor angle for the visual
  crashed = false;
  // helicopter velocity in its own frame (read by the rotor visual)
  vf = 0; vs = 0;

  // business-jet envelope (m/s): stall ~190 km/h, low-level cruise ~430 km/h, max ~830 km/h
  readonly stall = 52; readonly cruise = 120; readonly vmax = 231;
  // helicopter envelope (m/s)
  readonly heliMax = 67;

  /** Put the aircraft in the air, already flying. */
  deploy(x: number, groundY: number, z: number, headingRad: number): void {
    this.x = x; this.z = z; this.y = groundY + AIR_SPAWN_AGL; this.heading = headingRad;
    this.pitch = 0; this.roll = 0; this.vy = 0; this.vs = 0; this.crashed = false;
    if (this.kind === 'plane') { this.speed = this.cruise; this.throttle = 0.4; this.rpm = 56; }
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
    this.speed = Math.max(30, Math.min(this.vmax * 1.1, this.speed));
    if (this.speed < this.stall) this.pitch -= dt * 0.9 * (1 - this.speed / this.stall + 0.3); // stall: the nose drops
    // a banked wing turns the aircraft (coordinated turn) + a little rudder
    this.heading += ((G * Math.tan(this.roll)) / Math.max(this.speed, 40) + i.side * 0.12) * dt;
    const cp = Math.cos(this.pitch);
    this.vy = Math.sin(this.pitch) * this.speed;
    this.x += Math.sin(this.heading) * cp * this.speed * dt;
    this.z -= Math.cos(this.heading) * cp * this.speed * dt;
    this.y += this.vy * dt;
    this.load = this.throttle;
    // fan speed follows the throttle with turbine lag
    this.rpm += ((28 + this.throttle * 70) - this.rpm) * Math.min(1, dt * 0.9);
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
  }
}

export { AircraftVisual } from './AircraftModels';

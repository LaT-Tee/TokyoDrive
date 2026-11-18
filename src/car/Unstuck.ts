// Getting a car that cannot go on back on the road - only when the driver presses R. This
// notices when the car looks stuck and says so (a hint to press R); it never moves the car
// by itself.
//
// The car looks stuck when the driver has been pressing throttle or brake for HINT_MS
// without getting 1.5 m anywhere, or it is inside a building, below the ground, or has been
// in the air for over 3 s.
// R goes FORWARD: the car is put on its road further along the way it is facing, past
// whatever stopped it (8 m, then further; pressed again at the same place soon after, it
// starts further ahead). Only when nothing ahead is safe does it fall back to the newest
// safe pose behind it (the car leaves a trail of those while driving normally), and
// without one to the nearest road.
import type { CarController, CarInput } from './CarController';

const CRUMB_MS = 300;
const TRAIL = 100;        // poses kept (~30 s of driving)
const HINT_MS = 1500;
const PROGRESS_M = 1.5;
const REWIND_M = 10;
const AHEAD = [8, 14, 22, 32, 45, 60, 80];

export interface Pose { x: number; y: number; z: number; heading: number }
interface Crumb extends Pose { t: number }

export interface UnstuckEnv {
  /** The car is on something it can rely on (a mapped street, a deck, a tunnel floor). */
  onRoad: boolean;
  /** Ground height under the car (to tell "fell through the world"). */
  groundY: number;
  /** Inside a building footprint, above the street. */
  inBuilding: boolean;
}

export class Unstuck {
  private trail: Crumb[] = [];
  private lastCrumb = 0;
  private refX = 0; private refZ = 0; private refT = 0; private wantMs = 0;
  private airSince = 0; private badSince = 0;
  private lastRewind = { t: -1e9, x: 0, z: 0, n: 0 };
  /** True while the car looks stuck (show "press R"). */
  stuck = false;
  rescues = 0;

  /** Forget the trail (teleport, vehicle change). */
  reset(car: CarController, now: number): void {
    this.trail.length = 0; this.refX = car.x; this.refZ = car.z; this.refT = now; this.wantMs = 0;
    this.airSince = 0; this.badSince = 0; this.stuck = false;
  }

  /** Call every frame while driving: keeps the trail and decides whether the car looks stuck. */
  update(now: number, dt: number, car: CarController, input: CarInput, env: UnstuckEnv): void {
    if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.z)) { this.stuck = true; return; }
    // in the air too long, under the ground, inside a building
    this.airSince = car.airborne ? this.airSince || now : 0;
    const bad = car.y < env.groundY - 4 || env.inBuilding;
    this.badSince = bad ? this.badSince || now : 0;
    const trapped = (this.airSince > 0 && now - this.airSince > 3000) || (this.badSince > 0 && now - this.badSince > 400);

    // trail of safe poses
    const moving = Math.abs(car.speed) > 1.5 && !car.blocked && !car.airborne;
    if (moving && env.onRoad && !env.inBuilding && now - this.lastCrumb > CRUMB_MS) {
      this.lastCrumb = now;
      const last = this.trail[this.trail.length - 1];
      if (!last || Math.hypot(last.x - car.x, last.z - car.z) > 2) {
        this.trail.push({ x: car.x, y: car.y, z: car.z, heading: car.heading, t: now });
        if (this.trail.length > TRAIL) this.trail.shift();
      }
    }

    // no progress although the driver is trying to move
    if (Math.hypot(car.x - this.refX, car.z - this.refZ) > PROGRESS_M) { this.refX = car.x; this.refZ = car.z; this.refT = now; this.wantMs = 0; }
    const trying = input.throttle > 0 || input.brake > 0;
    if (trying) this.wantMs += dt * 1000;
    this.stuck = trapped || (this.wantMs > HINT_MS && now - this.refT > HINT_MS);
  }

  /** R: where to put the car (forward along its road first); pose null = nearest road. */
  rescue(now: number, car: CarController): { pose: Pose | null; back: number } {
    this.stuck = false;
    const here = Number.isFinite(car.x) ? { x: car.x, z: car.z } : { x: this.refX, z: this.refZ };
    // stuck again near the same place soon after: go further back each time
    const again = now - this.lastRewind.t < 20000 && Math.hypot(here.x - this.lastRewind.x, here.z - this.lastRewind.z) < 25;
    const n = again ? this.lastRewind.n + 1 : 0;
    // forward along the road first
    const heading = Number.isFinite(car.heading) ? car.heading : 0;
    for (const d of AHEAD.slice(Math.min(n, AHEAD.length - 1))) {
      const p = this.aheadFn(here.x, here.z, heading, d);
      if (p && this.safeFn(p)) {
        this.lastRewind = { t: now, x: here.x, z: here.z, n };
        this.rescues++;
        this.refX = p.x; this.refZ = p.z; this.refT = now; this.wantMs = 0; this.airSince = 0; this.badSince = 0;
        return { pose: p, back: -d };
      }
    }
    const minBack = REWIND_M * (1 + 2 * n);
    let pick = -1;
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const c = this.trail[i];
      if (Math.hypot(c.x - here.x, c.z - here.z) >= minBack && this.safeFn(c)) { pick = i; break; }
    }
    this.lastRewind = { t: now, x: here.x, z: here.z, n };
    this.rescues++;
    this.refT = now; this.wantMs = 0; this.airSince = 0; this.badSince = 0;
    if (pick < 0) { this.trail.length = 0; return { pose: null, back: 0 }; }
    const c = this.trail[pick];
    const back = Math.hypot(c.x - here.x, c.z - here.z);
    this.trail.length = pick; // the next rescue starts further back
    this.refX = c.x; this.refZ = c.z;
    return { pose: { x: c.x, y: c.y, z: c.z, heading: c.heading }, back };
  }

  private safeFn: (p: Pose) => boolean = () => true;
  private aheadFn: (x: number, z: number, heading: number, dist: number) => Pose | null = () => null;
  /** Where the road goes on: the pose `dist` metres ahead of (x, z) along it, or null. */
  setAhead(f: (x: number, z: number, heading: number, dist: number) => Pose | null): void { this.aheadFn = f; }
  /** Set the safety test used when choosing where to rewind to. */
  setSafe(f: (p: Pose) => boolean): void { this.safeFn = f; }
}

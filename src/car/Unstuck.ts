// Automatic recovery for a car that cannot go on: whatever trapped it (a gap in the data,
// a pit, a wall it cannot back out of, falling through the world), it is put back on the
// road a little way behind, where it last drove normally, facing the way it was going.
//
// The car leaves a trail of safe poses (moving, on a street / deck / tunnel floor, not
// blocked, not in the air). It is stuck when:
//   - the driver has been pressing throttle or brake for STUCK_MS without getting 1.5 m
//     anywhere (a hint with a countdown shows first),
//   - it is below the ground, inside a building, or has been airborne for over 3 s,
//   - its position is not a number.
// The rescue always goes FORWARD: the car is put on its road further along the way it is
// facing, past whatever stopped it (8 m, then further; stuck again at the same place soon
// after, it starts further ahead). Only when nothing ahead is safe does it fall back to the
// newest safe pose behind it, and without a trail to the nearest road (as with R).
import type { CarController, CarInput } from './CarController';

const CRUMB_MS = 300;
const TRAIL = 100;        // poses kept (~30 s of driving)
const STUCK_MS = 3000;
const HINT_MS = 1200;
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
  /** While the driver is getting nowhere: seconds left before the automatic rescue. */
  hint: { left: number } | null = null;
  rescues = 0;

  /** Forget the trail (teleport, vehicle change). */
  reset(car: CarController, now: number): void {
    this.trail.length = 0; this.refX = car.x; this.refZ = car.z; this.refT = now; this.wantMs = 0;
    this.airSince = 0; this.badSince = 0; this.hint = null;
  }

  /** Call every frame while driving. Returns where to put the car, or null. */
  update(now: number, dt: number, car: CarController, input: CarInput, env: UnstuckEnv): { pose: Pose | null; back: number } | null {
    this.hint = null;
    if (!Number.isFinite(car.x) || !Number.isFinite(car.y) || !Number.isFinite(car.z)) return this.rescue(now, car);
    // falling, under the ground, inside a building: rescue straight away
    this.airSince = car.airborne ? this.airSince || now : 0;
    const bad = car.y < env.groundY - 4 || env.inBuilding;
    this.badSince = bad ? this.badSince || now : 0;
    if ((this.airSince && now - this.airSince > 3000) || (this.badSince && now - this.badSince > 400)) return this.rescue(now, car);

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
    const still = now - this.refT;
    if (trying && this.wantMs > HINT_MS && still > HINT_MS) {
      if (this.wantMs >= STUCK_MS && still >= STUCK_MS) return this.rescue(now, car);
      this.hint = { left: Math.max(0, (STUCK_MS - this.wantMs) / 1000) };
    }
    return null;
  }

  private rescue(now: number, car: CarController): { pose: Pose | null; back: number } {
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

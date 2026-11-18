// Unified ground / collision queries used by the car controller.
//  - drivable surface = a mapped street's normalized profile inside its carriageway,
//    else the terrain heightfield; an elevated deck or a tunnel floor where the car is on one
//  - obstacles        = baked building height grid (never inside a mapped street)
import * as THREE from 'three';
import { WALL_SLOPE, WALL_STEP } from '../config';
import type { Terrain } from './Terrain';
import type { HeightGrid } from './HeightGrid';

export interface DeckProvider {
  /** Highest deck surface at (x, z) that is below `maxY`, or -Infinity. */
  deckHeight(x: number, z: number, maxY: number): number;
}

export interface TunnelProvider { floorAt(x: number, z: number, refY: number): number }

export class Ground {
  decks: DeckProvider[] = [];
  tunnels: TunnelProvider | null = null;
  /** Returns true when (x, z) lies on a mapped carriageway: real road data beats the 2 m obstacle grid. */
  onRoad: ((x: number, z: number) => boolean) | null = null;
  /** Normalized street surface at (x, z) for a vehicle at refY, NaN off the streets (RoadProfiles). */
  street: ((x: number, z: number, refY: number) => number) | null = null;
  /** Set by surface(): true when the returned height is a mapped street's surface. */
  lastOnStreet = false;
  /** Set by surface(): true when the returned height is a tunnel floor well below the terrain. */
  lastInTunnel = false;
  // sampling statistics for the §9.4 acceptance check
  samples = 0; fallbackSamples = 0; sampleMs = 0;
  /** Set by surface(): true when the returned height came from an elevated deck. */
  lastOnDeck = false;

  constructor(readonly terrain: Terrain, readonly obstacles: HeightGrid) {}

  /** Drivable surface height at (x, z) for a vehicle currently at height refY. */
  surface(x: number, z: number, refY: number): number {
    const t0 = performance.now();
    let h = this.terrain.heightAt(x, z, refY);
    if (!this.terrain.isReady(x, z, refY)) this.fallbackSamples++;
    this.lastOnDeck = false; this.lastInTunnel = false;
    // a mapped street: its own smooth surface, whatever the elevation model has there
    const st = this.street ? this.street(x, z, refY) : NaN;
    this.lastOnStreet = st === st;
    if (this.lastOnStreet) h = st;
    // inside a tunnel corridor at tunnel level, the floor wins over the terrain above it -
    // but a car on a street that crosses the tunnel's open cut stays on the street
    const tf = this.tunnels ? this.tunnels.floorAt(x, z, refY) : NaN;
    if (tf === tf && tf < h + 0.3 && !(this.lastOnStreet && refY > st - 1.5)) {
      this.lastInTunnel = h - tf > 2.5;
      h = Math.min(h, tf);
      this.lastOnStreet = false;
    } else for (const d of this.decks) {
      // only a deck at (or just above) the car's own level: stacked decks are not stepped onto
      const dh = d.deckHeight(x, z, refY + 0.9);
      if (dh > h + 0.25) { h = dh; this.lastOnDeck = true; this.lastOnStreet = false; }
    }
    this.samples++;
    this.sampleMs += performance.now() - t0;
    return h;
  }

  /** True if moving from a point at height `y` onto (x, z), `dist` metres away, hits a wall. */
  isWall(x: number, z: number, y: number, dist: number, fromDeck = false): boolean {
    const s = this.surface(x, z, y);
    const rise = s - y;
    if (rise > WALL_STEP || rise / dist > WALL_SLOPE) return true;
    // leaving an elevated deck sideways = guardrail
    if (fromDeck && rise < -2.5) return true;
    if (this.lastInTunnel) return false; // buildings above a tunnel are not in the way
    if (this.lastOnStreet) return false; // nothing stands in a mapped street
    const b = this.obstacles.heightAt(x, z);
    if (!(b > Math.max(s, y) + WALL_STEP)) return false;
    // a building edge rounded up to the grid must not close a street that really exists
    return !(this.onRoad && this.onRoad(x, z));
  }
}

export const _v = new THREE.Vector3();

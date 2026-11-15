// Unified ground / collision queries used by the car controller.
//  - drivable surface = terrain heightfield, or an elevated deck (BVH raycast)
//  - obstacles        = baked building height grid
import * as THREE from 'three';
import { WALL_SLOPE, WALL_STEP } from '../config';
import type { Terrain } from './Terrain';
import type { HeightGrid } from './HeightGrid';

export interface DeckProvider {
  /** Highest deck surface at (x, z) that is below `maxY`, or -Infinity. */
  deckHeight(x: number, z: number, maxY: number): number;
}

export class Ground {
  decks: DeckProvider[] = [];
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
    this.lastOnDeck = false;
    for (const d of this.decks) {
      const dh = d.deckHeight(x, z, refY + 1.6);
      if (dh > h + 0.25) { h = dh; this.lastOnDeck = true; }
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
    const b = this.obstacles.heightAt(x, z);
    return b > Math.max(s, y) + WALL_STEP;
  }
}

export const _v = new THREE.Vector3();

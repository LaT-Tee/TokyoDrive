// Top-down map of the mapped streets around the car (1 m per pixel), holding each street's
// surface height. Building shaders read it to leave the street clear: whatever part of a
// building stands inside a carriageway, from just below the road up to clearance height, is
// not drawn. PLATEAU models a station concourse, a skyway or a deck over a road as a solid
// block down to the ground; with this the road runs through underneath it, the way it
// does in reality. A building footprint that strays onto the road loses that corner.
import * as THREE from 'three';
import type { RoadProfiles } from './RoadProfiles';

const SIZE = 1024;          // px = metres
const SNAP = 64;            // m: the window moves in steps
const CLEARANCE = 5.0;      // m above the road kept clear
const NONE = -1e4;

/** Shared uniforms for building materials. */
export const streetCarve = {
  tdStreetMask: { value: null as THREE.DataTexture | null },
  tdStreetBox: { value: new THREE.Vector4(0, 0, SIZE, 0) }, // x0, z0, size, enabled
  tdStreetClear: { value: CLEARANCE },
};

/** GLSL for a fragment at world position `tdWorld`: discard inside a street's clearance. */
export const STREET_CARVE_GLSL = `
  if (tdStreetBox.w > 0.5) {
    vec2 tdUv = (tdWorld.xz - tdStreetBox.xy) / tdStreetBox.z;
    if (tdUv.x > 0.0 && tdUv.y > 0.0 && tdUv.x < 1.0 && tdUv.y < 1.0) {
      float tdSh = texture2D(tdStreetMask, tdUv).r;
      if (tdSh > -9000.0 && tdWorld.y < tdSh + tdStreetClear && tdWorld.y > tdSh - 3.0) discard;
    }
  }`;

export class StreetMask {
  private data = new Float32Array(SIZE * SIZE).fill(NONE);
  private tex = new THREE.DataTexture(this.data, SIZE, SIZE, THREE.RedFormat, THREE.FloatType);
  private x0 = NaN; private z0 = NaN;
  private painted = -1;
  private lastPaint = 0;

  constructor(private streets: RoadProfiles) {
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.flipY = false;
    streetCarve.tdStreetMask.value = this.tex;
  }

  update(x: number, z: number, now: number): void {
    const cx = Math.round(x / SNAP) * SNAP - SIZE / 2, cz = Math.round(z / SNAP) * SNAP - SIZE / 2;
    const moved = Math.abs(cx - this.x0) > SNAP * 2 || Math.abs(cz - this.z0) > SNAP * 2 || this.x0 !== this.x0;
    const changed = this.streets.version !== this.painted && now - this.lastPaint > 1500;
    if (!moved && !changed) return;
    if (moved) { this.x0 = cx; this.z0 = cz; }
    this.painted = this.streets.version; this.lastPaint = now;
    const d = this.data;
    d.fill(NONE);
    const x0 = this.x0, z0 = this.z0;
    this.streets.forEachSegment(x0, z0, x0 + SIZE, z0 + SIZE, (ax, az, ay, bx, bz, by, hw) => {
      const px0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - x0)), px1 = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + hw - x0));
      const pz0 = Math.max(0, Math.floor(Math.min(az, bz) - hw - z0)), pz1 = Math.min(SIZE - 1, Math.ceil(Math.max(az, bz) + hw - z0));
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      for (let pz = pz0; pz <= pz1; pz++) {
        const wz = z0 + pz + 0.5;
        for (let px = px0; px <= px1; px++) {
          const wx = x0 + px + 0.5;
          const t = Math.max(0, Math.min(1, ((wx - ax) * dx + (wz - az) * dz) / l2));
          const ex = ax + dx * t - wx, ez = az + dz * t - wz;
          if (ex * ex + ez * ez > hw * hw) continue;
          const y = ay + (by - ay) * t, i = pz * SIZE + px;
          if (y > d[i]) d[i] = y;
        }
      }
    });
    this.tex.needsUpdate = true;
    streetCarve.tdStreetBox.value.set(x0, z0, SIZE, 1);
  }
}

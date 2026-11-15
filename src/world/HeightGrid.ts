// Baked obstacle height grid (CLAUDE.md §9.4): as building tiles load, their
// triangles are rasterised (max height) into a 2 m grid per 1 km cell, off
// the critical path (time-sliced). The wall probe reads this grid; nothing
// raycasts raw tile meshes per frame.
import * as THREE from 'three';

const CELL = 1000;
const RES = 2;
const DIM = CELL / RES; // 500
const EMPTY = -32768;
const MAX_CELLS = 400;

interface Job { pos: ArrayLike<number>; index: ArrayLike<number> | null; matrix: THREE.Matrix4; cursor: number; count: number }

export class HeightGrid {
  private cells = new Map<string, Int16Array>();
  private queue: Job[] = [];
  trianglesBaked = 0;

  get pendingJobs(): number { return this.queue.length; }

  /** Queue a mesh (geometry + local-frame world matrix) for rasterisation. */
  addMesh(geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4): void {
    const pos = geometry.getAttribute('position');
    if (!pos) return;
    const index = geometry.getIndex();
    this.queue.push({
      pos: pos.array, index: index ? index.array : null, matrix: matrixWorld.clone(), cursor: 0,
      count: (index ? index.count : pos.count) / 3,
    });
  }

  private cell(cx: number, cz: number, create: boolean): Int16Array | undefined {
    const key = cx + ',' + cz;
    let c = this.cells.get(key);
    if (!c && create) {
      if (this.cells.size >= MAX_CELLS) this.cells.delete(this.cells.keys().next().value!);
      c = new Int16Array(DIM * DIM).fill(EMPTY);
      this.cells.set(key, c);
    }
    return c;
  }

  private stamp(gx: number, gz: number, y: number): void {
    const cx = Math.floor(gx / DIM), cz = Math.floor(gz / DIM);
    const c = this.cell(cx, cz, true)!;
    const i = (gz - cz * DIM) * DIM + (gx - cx * DIM);
    const v = Math.max(-32767, Math.min(32767, Math.round(y * 10)));
    if (v > c[i]) c[i] = v;
  }

  /** Obstacle (building) top height at local (x, z), or -Infinity if none baked. */
  heightAt(x: number, z: number): number {
    const gx = Math.floor(x / RES), gz = Math.floor(z / RES);
    const cx = Math.floor(gx / DIM), cz = Math.floor(gz / DIM);
    const c = this.cells.get(cx + ',' + cz);
    if (!c) return -Infinity;
    const v = c[(gz - cz * DIM) * DIM + (gx - cx * DIM)];
    return v === EMPTY ? -Infinity : v / 10;
  }

  /** Process queued triangles for at most `budgetMs`. Call once per frame. */
  update(budgetMs: number): void {
    if (!this.queue.length) return;
    const t0 = performance.now();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    while (this.queue.length) {
      const job = this.queue[0];
      const { pos, index, matrix } = job;
      const end = Math.min(job.count, job.cursor + 400);
      for (let t = job.cursor; t < end; t++) {
        const i0 = index ? index[t * 3] : t * 3, i1 = index ? index[t * 3 + 1] : t * 3 + 1, i2 = index ? index[t * 3 + 2] : t * 3 + 2;
        a.set(pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]).applyMatrix4(matrix);
        b.set(pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]).applyMatrix4(matrix);
        c.set(pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]).applyMatrix4(matrix);
        this.raster(a, b, c);
      }
      this.trianglesBaked += end - job.cursor;
      job.cursor = end;
      if (job.cursor >= job.count) this.queue.shift();
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  private raster(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const minX = Math.floor(Math.min(a.x, b.x, c.x) / RES), maxX = Math.floor(Math.max(a.x, b.x, c.x) / RES);
    const minZ = Math.floor(Math.min(a.z, b.z, c.z) / RES), maxZ = Math.floor(Math.max(a.z, b.z, c.z) / RES);
    if (maxX - minX > 400 || maxZ - minZ > 400) return; // degenerate / absurd triangle
    const top = Math.max(a.y, b.y, c.y);
    const den = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(den) < 1e-6 || (maxX === minX && maxZ === minZ)) {
      // vertical wall or sub-cell triangle: stamp along its footprint line
      const steps = Math.max(1, Math.ceil(Math.max(maxX - minX, maxZ - minZ) * 1.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        this.stamp(Math.floor((a.x + (b.x - a.x) * t) / RES), Math.floor((a.z + (b.z - a.z) * t) / RES), top);
        this.stamp(Math.floor((a.x + (c.x - a.x) * t) / RES), Math.floor((a.z + (c.z - a.z) * t) / RES), top);
      }
      return;
    }
    for (let gz = minZ; gz <= maxZ; gz++) for (let gx = minX; gx <= maxX; gx++) {
      const px = (gx + 0.5) * RES, pz = (gz + 0.5) * RES;
      const w0 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / den;
      const w1 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / den;
      const w2 = 1 - w0 - w1;
      // slightly conservative so thin roofs are not missed
      if (w0 < -0.15 || w1 < -0.15 || w2 < -0.15) continue;
      const y = Math.min(top, w0 * a.y + w1 * b.y + w2 * c.y);
      this.stamp(gx, gz, y);
    }
  }
}

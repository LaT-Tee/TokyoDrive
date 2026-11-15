// Trees near the car. Placement is read from the ortho photo itself (the ground
// classifies dark-green pixels as canopy, see Terrain.classifyVegetation), so
// trees appear where the real ones are - parks, shrine groves, river banks,
// street trees - without any extra dataset. Instanced, built per 100 m cell.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Terrain } from './Terrain';
import type { HeightGrid } from './HeightGrid';
import type { Roads } from './Roads';

const CELL = 100;
const RANGE = 320;
const DROP = 460;
const GRID = 6.5;

function treeGeometry(): THREE.BufferGeometry {
  const paint = (g: THREE.BufferGeometry, r: number, gr: number, b: number) => {
    const n = g.getAttribute('position').count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // darker toward the bottom of the crown: cheap ambient occlusion
      const y = g.getAttribute('position').getY(i), k = 0.72 + 0.28 * Math.min(1, Math.max(0, (y - 2) / 4.5));
      c[i * 3] = r * k; c[i * 3 + 1] = gr * k; c[i * 3 + 2] = b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g.toNonIndexed();
  };
  const trunk = paint(new THREE.CylinderGeometry(0.16, 0.24, 2.6, 6).translate(0, 1.3, 0), 0.16, 0.11, 0.07);
  const c1 = paint(new THREE.IcosahedronGeometry(2.3, 1).scale(1, 0.85, 1).translate(0, 4.3, 0), 0.07, 0.17, 0.05);
  const c2 = paint(new THREE.IcosahedronGeometry(1.6, 1).translate(0.9, 5.6, 0.4), 0.09, 0.2, 0.06);
  const c3 = paint(new THREE.IcosahedronGeometry(1.5, 1).translate(-0.8, 5.2, -0.7), 0.06, 0.15, 0.045);
  const g = mergeGeometries([trunk, c1, c2, c3])!;
  g.computeVertexNormals();
  return g;
}

export class Vegetation {
  readonly group = new THREE.Group();
  private cells = new Map<string, THREE.InstancedMesh | null>();
  private geo = treeGeometry();
  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  enabled = true;
  treeCount = 0;

  constructor(private terrain: Terrain, private obstacles: HeightGrid, private roads: Roads) { this.group.name = 'vegetation'; }

  update(x: number, z: number): void {
    for (const [key, m] of this.cells) {
      const [kx, kz] = key.split(',').map(Number);
      if (!this.enabled || Math.hypot((kx + 0.5) * CELL - x, (kz + 0.5) * CELL - z) > DROP) {
        if (m) { this.group.remove(m); m.dispose(); this.treeCount -= m.count; }
        this.cells.delete(key);
      }
    }
    if (!this.enabled) return;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), R = Math.ceil(RANGE / CELL);
    let best: [number, number] | null = null, bd = Infinity;
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot((cx + dx + 0.5) * CELL - x, (cz + dz + 0.5) * CELL - z);
      if (d < RANGE && d < bd && !this.cells.has(cx + dx + ',' + (cz + dz))) { bd = d; best = [cx + dx, cz + dz]; }
    }
    if (best) this.build(best[0], best[1]); // one cell per tick keeps this off the frame budget
  }

  private build(kx: number, kz: number): void {
    const x0 = kx * CELL, z0 = kz * CELL;
    // wait until the photo for this cell has been classified
    if (this.terrain.vegAt(x0 + CELL / 2, z0 + CELL / 2) < 0) return;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), s = new THREE.Vector3();
    const mats: THREE.Matrix4[] = [], cols: THREE.Color[] = [];
    let seed = (kx * 73856093) ^ (kz * 19349663);
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
    for (let gz = 0; gz < CELL; gz += GRID) for (let gx = 0; gx < CELL; gx += GRID) {
      const x = x0 + gx + rnd() * GRID, z = z0 + gz + rnd() * GRID, r = rnd(), sc = 0.75 + rnd() * 0.75, rot = rnd() * Math.PI * 2, tint = rnd();
      const cls = this.terrain.vegAt(x, z);
      if (!(cls === 2 || (cls === 1 && r < 0.05))) continue;   // canopy, plus the odd tree on grass
      const y = this.terrain.heightAt(x, z);
      if (this.obstacles.heightAt(x, z) > y + 1.5) continue;    // roof gardens
      const road = this.roads.nearest(x, z, 9);
      if (road && road.dist < road.width / 2 + 1) continue;     // canopy overhanging a road: keep the carriageway clear
      p.set(x - x0, y - 0.1, z - z0); q.setFromAxisAngle(up, rot); s.set(sc, sc * (0.85 + tint * 0.3), sc);
      mats.push(m4.compose(p, q, s).clone());
      cols.push(new THREE.Color().setHSL(0.27 + tint * 0.06, 0.1, 0.42 + tint * 0.2));
      if (mats.length >= 500) break;
    }
    if (!mats.length) { this.cells.set(kx + ',' + kz, null); return; }
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, mats.length);
    for (let i = 0; i < mats.length; i++) { mesh.setMatrixAt(i, mats[i]); mesh.setColorAt(i, cols[i]); }
    mesh.position.set(x0, 0, z0); mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.cells.set(kx + ',' + kz, mesh);
    this.treeCount += mats.length;
  }
}

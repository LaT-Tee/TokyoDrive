// Aircraft built in code - no model files, nothing to license - to real-type proportions:
//  - a light business jet (~16 m long, 16 m span, rear-mounted turbofans, T-tail)
//  - a light single-engine helicopter (~10.7 m rotor, 12.7 m overall)
// Lofted fuselages with superellipse cross-sections, wings with a real airfoil
// thickness, clear-coat paint, tinted glass, navigation lights and strobes.
//
// Rotor realism (helicopter): a spinning rotor filmed at 60 fps aliases into a slowly
// wandering or backwards-turning X. So, like a camera with a slow shutter, the solid
// blades fade out as the rotor spins up and are replaced by
//   - a few trailing "ghost" copies of each blade (motion smear),
//   - a translucent disc whose density rises toward the tips,
//   - a faint tip-path ring,
// while the drawn blades turn at a calm apparent rate instead of the true one.
// The disc tilts with the direction of flight and the blades cone upward under load.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VehicleKind } from '../car/garage';

// ------------------------------------------------------------------ geometry helpers
interface Section { z: number; y: number; w: number; h: number; e: number } // centre height, half width / height, superellipse exponent

const smooth = (keys: Section[], n: number): Section[] => {
  // Catmull-Rom through the key sections, sampled evenly along z
  const out: Section[] = [];
  const z0 = keys[0].z, z1 = keys[keys.length - 1].z;
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    let k = 0; while (k < keys.length - 2 && keys[k + 1].z < z) k++;
    const p0 = keys[Math.max(0, k - 1)], p1 = keys[k], p2 = keys[k + 1], p3 = keys[Math.min(keys.length - 1, k + 2)];
    const t = (z - p1.z) / Math.max(1e-6, p2.z - p1.z);
    const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
    out.push({ z, y: cr(p0.y, p1.y, p2.y, p3.y), w: Math.max(0, cr(p0.w, p1.w, p2.w, p3.w)), h: Math.max(0, cr(p0.h, p1.h, p2.h, p3.h)), e: cr(p0.e, p1.e, p2.e, p3.e) });
  }
  return out;
};
const sePoint = (s: Section, a: number) => {
  const c = Math.cos(a), sn = Math.sin(a), p = 2 / s.e;
  return [s.w * Math.sign(c) * Math.abs(c) ** p, s.y + s.h * Math.sign(sn) * Math.abs(sn) ** p, s.z];
};

/** Closed loft through superellipse sections (z increasing = toward the tail). */
function loft(keys: Section[], rings = 64, seg = 40): THREE.BufferGeometry {
  const S = smooth(keys, rings), pos: number[] = [], idx: number[] = [];
  for (const s of S) for (let j = 0; j <= seg; j++) pos.push(...sePoint(s, (j / seg) * Math.PI * 2));
  for (let i = 0; i < S.length - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, b, c, b, d, c); // outward-facing
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** A patch of a loft's surface (z range x angle range), pushed out a little: glazing, cheatlines. */
function loftPatch(keys: Section[], z0: number, z1: number, a0: number, a1: number, lift = 0.012, rings = 24, seg = 16): THREE.BufferGeometry {
  const S = smooth(keys, 256).filter((s) => s.z >= z0 && s.z <= z1);
  const step = Math.max(1, Math.floor(S.length / rings)), R = S.filter((_, i) => i % step === 0);
  const pos: number[] = [], idx: number[] = [];
  for (const s of R) for (let j = 0; j <= seg; j++) {
    const a = a0 + ((a1 - a0) * j) / seg, p = sePoint({ ...s, w: s.w + lift, h: s.h + lift }, a);
    pos.push(...p);
  }
  for (let i = 0; i < R.length - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, b, c, b, d, c); // outward-facing
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** Symmetric NACA 4-digit thickness at x in 0..1, as a fraction of chord. */
const naca = (x: number, t: number) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);

/**
 * A lifting surface: span along the local +X (or +Y when vertical), chord along +Z
 * (leading edge toward -Z). side = -1 mirrors it to the left.
 */
function surface(o: { span: number; root: number; tip: number; sweep: number; dihedral: number; t: number; twist?: number; vertical?: boolean; side?: number; stations?: number }): THREE.BufferGeometry {
  const n = o.stations ?? 12, m = 18, side = o.side ?? 1, pos: number[] = [], idx: number[] = [];
  const xs: number[] = []; for (let i = 0; i <= m; i++) xs.push((1 - Math.cos((i / m) * Math.PI)) / 2); // cosine spacing
  for (let s = 0; s <= n; s++) {
    const f = s / n, c = o.root + (o.tip - o.root) * f, le = f * o.span * Math.tan(o.sweep), sp = f * o.span;
    const lift = sp * Math.tan(o.dihedral), tw = (o.twist ?? 0) * f;
    const ring: number[][] = [];
    for (let i = m; i >= 0; i--) ring.push([xs[i], naca(xs[i], o.t)]);        // upper, TE -> LE
    for (let i = 1; i <= m; i++) ring.push([xs[i], -naca(xs[i], o.t)]);      // lower, LE -> TE
    for (const [x, y] of ring) {
      let zc = le + x * c - c * 0.25, yc = y * c;
      // twist about the quarter chord
      const z2 = zc * Math.cos(tw) - yc * Math.sin(tw), y2 = zc * Math.sin(tw) + yc * Math.cos(tw); zc = z2; yc = y2;
      if (o.vertical) pos.push(yc * side, sp, zc + c * 0.25);
      else pos.push(sp * side, yc + lift, zc + c * 0.25);
    }
  }
  const R = 2 * m + 1;
  for (let s = 0; s < n; s++) for (let i = 0; i < R - 1; i++) {
    const a = s * R + i, b = a + 1, c = a + R, d = c + 1;
    if (side > 0 !== !!o.vertical) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  // tip cap
  const base = n * R, cx = pos.length / 3;
  let ax = 0, ay = 0, az = 0; for (let i = 0; i < R; i++) { ax += pos[(base + i) * 3]; ay += pos[(base + i) * 3 + 1]; az += pos[(base + i) * 3 + 2]; }
  pos.push(ax / R, ay / R, az / R);
  for (let i = 0; i < R - 1; i++) if (side > 0 !== !!o.vertical) idx.push(base + i, base + i + 1, cx); else idx.push(base + i + 1, base + i, cx);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!, gr = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 256, 256);
  // faint concentric banding: the blades' twist catches the light at different radii
  ctx.globalCompositeOperation = 'destination-out';
  for (let r = 40; r < 128; r += 7) { ctx.beginPath(); ctx.arc(128, 128, r, 0, Math.PI * 2); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ------------------------------------------------------------------ materials
const mats = () => ({
  paint: new THREE.MeshPhysicalMaterial({ color: 0xd7263d, metalness: 0.2, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }),
  white: new THREE.MeshPhysicalMaterial({ color: 0xeceae6, metalness: 0.05, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xa9adb3, metalness: 0.75, roughness: 0.32 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.3, roughness: 0.55 }),
  intake: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.6, roughness: 0.4, side: THREE.DoubleSide }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1724, metalness: 0.2, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.85 }),
});
type Mats = ReturnType<typeof mats>;
const lightMat = (r: number, g: number, b: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });

// ------------------------------------------------------------------ business jet
function buildJet(m: Mats): { group: THREE.Group; strobes: THREE.Mesh[]; beacons: THREE.Mesh[]; fans: THREE.Object3D[] } {
  const g = new THREE.Group(); g.name = 'jet';
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };
  // fuselage: nose at -Z (z = -7.9), tail cone up-swept to z = +8
  const F: Section[] = [
    { z: -7.9, y: -0.05, w: 0.02, h: 0.02, e: 2 },
    { z: -7.45, y: -0.02, w: 0.42, h: 0.4, e: 2 },
    { z: -6.6, y: 0.06, w: 0.78, h: 0.74, e: 2.1 },
    { z: -5.4, y: 0.12, w: 0.93, h: 0.92, e: 2.2 },
    { z: -4.0, y: 0.13, w: 0.97, h: 0.98, e: 2.25 },
    { z: 2.2, y: 0.13, w: 0.97, h: 0.98, e: 2.25 },
    { z: 4.2, y: 0.24, w: 0.82, h: 0.86, e: 2.15 },
    { z: 6.3, y: 0.46, w: 0.5, h: 0.55, e: 2 },
    { z: 7.9, y: 0.7, w: 0.12, h: 0.16, e: 2 },
    { z: 8.05, y: 0.72, w: 0.02, h: 0.02, e: 2 },
  ];
  add(loft(F, 90, 44), m.white);
  // windshield (four-piece look from the dark band), cheatline and lower belly accent
  add(loftPatch(F, -6.5, -5.35, Math.PI * 0.18, Math.PI * 0.82, 0.008), m.glass);
  add(loftPatch(F, -7.2, 7.0, -Math.PI * 0.035, Math.PI * 0.025, 0.006, 80, 3), m.paint);           // right stripe
  add(loftPatch(F, -7.2, 7.0, Math.PI * 0.975, Math.PI * 1.035, 0.006, 80, 3), m.paint);            // left stripe
  add(loftPatch(F, -7.6, 7.6, Math.PI * 1.22, Math.PI * 1.78, 0.004, 60, 10), m.paint);              // belly
  // cabin windows: oval, six a side
  const win = new THREE.SphereGeometry(0.15, 16, 10).scale(1, 1.3, 0.2);
  for (let i = 0; i < 6; i++) for (const side of [-1, 1]) {
    const z = -3.4 + i * 0.86, y = 0.33;
    const o = add(win, m.glass, side * 0.955, y, z); o.rotation.y = side * Math.PI / 2;
  }
  // low swept wing with dihedral and winglets
  for (const side of [-1, 1]) {
    const w = add(surface({ span: 7.4, root: 2.9, tip: 1.05, sweep: 0.42, dihedral: 0.055, t: 0.12, twist: -0.04, side, stations: 14 }), m.white, side * 0.7, -0.55, -0.6);
    w.name = 'wing';
    const wl = add(surface({ span: 1.3, root: 1.0, tip: 0.45, sweep: 0.75, dihedral: 0, t: 0.09, vertical: true, side }), m.paint,
      side * (0.7 + 7.4), -0.55 + 7.4 * Math.tan(0.055) + 0.02, -0.6 + 7.4 * Math.tan(0.42));
    wl.rotation.z = -side * 0.18;
  }
  // T-tail: swept fin + stabiliser on top
  add(surface({ span: 2.7, root: 3.0, tip: 1.55, sweep: 0.72, dihedral: 0, t: 0.1, vertical: true }), m.paint, 0, 0.9, 5.0);
  for (const side of [-1, 1]) add(surface({ span: 2.75, root: 1.45, tip: 0.7, sweep: 0.5, dihedral: 0.03, t: 0.09, side }), m.white, side * 0.06, 3.55, 6.85);
  // rear turbofans on pylons
  const nac = [[0, -1.2], [0.4, -1.18], [0.47, -0.9], [0.5, 0.2], [0.47, 0.9], [0.36, 1.45], [0.3, 1.5]].map(([r, z]) => new THREE.Vector2(r, z));
  const fans: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const ng = new THREE.LatheGeometry(nac, 32).rotateX(Math.PI / 2);
    const x = side * 1.55, y = 0.75, z = 4.9;
    add(ng, m.metal, x, y, z);
    add(new THREE.CylinderGeometry(0.405, 0.405, 0.05, 32).rotateX(Math.PI / 2), m.intake, x, y, z - 1.12);   // intake face
    const fan = new THREE.Group(); fan.position.set(x, y, z - 1.08); g.add(fan); fans.push(fan);
    for (let b = 0; b < 12; b++) { const bl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.015), m.metal); bl.position.y = 0.19; const piv = new THREE.Group(); piv.rotation.z = (b / 12) * Math.PI * 2; bl.rotation.y = 0.5; piv.add(bl); fan.add(piv); }
    add(new THREE.ConeGeometry(0.13, 0.25, 16).rotateX(-Math.PI / 2), m.dark, x, y, z - 1.12);              // spinner
    add(new THREE.CylinderGeometry(0.29, 0.29, 0.05, 24).rotateX(Math.PI / 2), m.intake, x, y, z + 1.48);      // exhaust
    const py = add(surface({ span: 0.95, root: 1.5, tip: 1.2, sweep: 0.2, dihedral: 0, t: 0.08, side }), m.white, side * 0.62, 0.62, 4.6);
    py.rotation.z = side * 0.08;
  }
  // navigation lights (red left, green right, white tail) + strobes and beacons
  const strobes: THREE.Mesh[] = [], beacons: THREE.Mesh[] = [];
  const dot = new THREE.SphereGeometry(0.07, 10, 8);
  for (const side of [-1, 1]) {
    const tipX = side * (0.7 + 7.4), tipY = -0.55 + 7.4 * Math.tan(0.055), tipZ = -0.6 + 7.4 * Math.tan(0.42) + 0.1;
    add(dot, side < 0 ? lightMat(6, 0.15, 0.1) : lightMat(0.1, 6, 0.4), tipX, tipY + 0.05, tipZ);
    strobes.push(add(dot, lightMat(30, 30, 30), tipX, tipY + 0.05, tipZ + 0.35));
  }
  add(dot, lightMat(4, 4, 4), 0, 0.72, 8.06);
  beacons.push(add(dot, lightMat(20, 0.6, 0.3), 0, 1.13, 0.3), add(dot, lightMat(20, 0.6, 0.3), 0, -0.86, 0.6));
  return { group: g, strobes, beacons, fans };
}

// ------------------------------------------------------------------ helicopter
interface Rotor { root: THREE.Group; spin: THREE.Group; blades: THREE.Mesh[]; ghosts: THREE.Mesh[]; disc: THREE.Mesh; ring: THREE.Mesh | null; bladeMat: THREE.MeshStandardMaterial; ghostMat: THREE.MeshBasicMaterial; discMat: THREE.MeshBasicMaterial; ringMat: THREE.MeshBasicMaterial | null }

function buildRotor(m: Mats, radius: number, chord: number, blades: number, ghostsPerBlade: number, discAxis: 'y' | 'x'): Rotor {
  const root = new THREE.Group(), spin = new THREE.Group(); root.add(spin);
  const bladeMat = (m.dark as THREE.MeshStandardMaterial).clone(); bladeMat.transparent = true;
  const geo = surface({ span: radius - 0.25, root: chord, tip: chord * 0.85, sweep: 0, dihedral: 0, t: 0.1, twist: -0.18, stations: 6 });
  geo.translate(0.25, 0, 0);
  const bl: THREE.Mesh[] = [];
  for (let i = 0; i < blades; i++) {
    const hinge = new THREE.Group(); hinge.rotation.y = (i / blades) * Math.PI * 2; spin.add(hinge);
    const b = new THREE.Mesh(geo, bladeMat); b.castShadow = true; hinge.add(b); bl.push(b);
  }
  // motion smear: copies trailing each blade, fading with age
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x0d0e10, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const ghosts: THREE.Mesh[] = [];
  for (let i = 0; i < blades; i++) for (let k = 1; k <= ghostsPerBlade; k++) {
    const hinge = new THREE.Group(); hinge.rotation.y = (i / blades) * Math.PI * 2 - k * 0.11; spin.add(hinge);
    const gm = ghostMat.clone(); (gm as any).userData = { age: k / (ghostsPerBlade + 1) };
    const gh = new THREE.Mesh(geo, gm); gh.renderOrder = 3; hinge.add(gh); ghosts.push(gh);
  }
  const discMat = new THREE.MeshBasicMaterial({
    map: radialTexture([[0, 'rgba(10,11,13,0)'], [0.08, 'rgba(10,11,13,0.1)'], [0.55, 'rgba(10,11,13,0.22)'], [0.93, 'rgba(10,11,13,0.4)'], [0.985, 'rgba(10,11,13,0.5)'], [1, 'rgba(10,11,13,0)']]),
    transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 64), discMat); disc.renderOrder = 4;
  disc.rotation.x = -Math.PI / 2;
  root.add(disc);
  let ring: THREE.Mesh | null = null, ringMat: THREE.MeshBasicMaterial | null = null;
  if (discAxis === 'y') {
    ringMat = new THREE.MeshBasicMaterial({ color: 0x2a2c30, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.07, radius, 96), ringMat); ring.rotation.x = -Math.PI / 2; ring.renderOrder = 4; root.add(ring);
  }
  // built as a horizontal rotor; the tail rotor is the same thing turned on its side (spins about X)
  if (discAxis === 'x') root.rotation.z = Math.PI / 2;
  return { root, spin, blades: bl, ghosts, disc, ring, bladeMat, ghostMat, discMat, ringMat };
}

function buildHeli(m: Mats): { group: THREE.Group; main: Rotor; tail: Rotor; strobes: THREE.Mesh[]; beacons: THREE.Mesh[] } {
  const g = new THREE.Group(); g.name = 'heli';
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); g.add(o); return o; };
  // cabin pod: rounded nose (-Z), flat-ish floor
  const C: Section[] = [
    { z: -2.35, y: -0.15, w: 0.05, h: 0.05, e: 2 },
    { z: -2.15, y: -0.1, w: 0.55, h: 0.52, e: 2 },
    { z: -1.6, y: 0.0, w: 0.82, h: 0.8, e: 2.3 },
    { z: -0.6, y: 0.05, w: 0.88, h: 0.86, e: 2.7 },
    { z: 0.8, y: 0.05, w: 0.86, h: 0.84, e: 2.7 },
    { z: 1.7, y: 0.2, w: 0.6, h: 0.62, e: 2.4 },
    { z: 2.4, y: 0.42, w: 0.3, h: 0.32, e: 2 },
  ];
  add(loft(C, 70, 44), m.paint);
  // glazing: wrap-around windshield + door windows
  add(loftPatch(C, -2.12, -0.75, Math.PI * 0.04, Math.PI * 0.96, 0.01), m.glass);
  add(loftPatch(C, -2.2, -1.65, Math.PI * 1.08, Math.PI * 1.42, 0.01), m.glass);                    // chin window L
  add(loftPatch(C, -2.2, -1.65, Math.PI * 1.58, Math.PI * 1.92, 0.01), m.glass);                    // chin window R
  for (const [a0, a1] of [[-0.05, 0.36], [0.64, 1.05]] as const) add(loftPatch(C, -0.5, 0.65, Math.PI * a0, Math.PI * a1, 0.01), m.glass); // doors
  add(loftPatch(C, -2.3, 2.3, Math.PI * 1.3, Math.PI * 1.7, 0.006, 40, 8), m.white);                // white belly
  // engine / transmission fairing on the roof
  const T: Section[] = [{ z: -0.8, y: 0.72, w: 0.05, h: 0.03, e: 2 }, { z: -0.3, y: 0.82, w: 0.5, h: 0.26, e: 2.4 }, { z: 1.3, y: 0.86, w: 0.52, h: 0.3, e: 2.4 }, { z: 2.6, y: 0.66, w: 0.28, h: 0.2, e: 2 }, { z: 3.0, y: 0.6, w: 0.05, h: 0.05, e: 2 }];
  add(loft(T, 40, 32), m.paint);
  add(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 20).rotateX(Math.PI / 2), m.intake, 0, 0.62, 3.0);   // exhaust
  // tail boom, tapering, slightly raised
  const B: Section[] = [{ z: 2.0, y: 0.32, w: 0.32, h: 0.34, e: 2 }, { z: 5.0, y: 0.48, w: 0.2, h: 0.21, e: 2 }, { z: 7.6, y: 0.62, w: 0.12, h: 0.13, e: 2 }, { z: 7.75, y: 0.62, w: 0.02, h: 0.02, e: 2 }];
  add(loft(B, 40, 24), m.paint);
  // fins: upper + small lower vertical, horizontal stabiliser with end plates
  add(surface({ span: 1.25, root: 0.95, tip: 0.55, sweep: 0.62, dihedral: 0, t: 0.1, vertical: true }), m.paint, 0, 0.66, 7.1);
  add(surface({ span: 0.45, root: 0.6, tip: 0.4, sweep: 0.5, dihedral: 0, t: 0.1, vertical: true }), m.paint, 0, 0.6, 7.25).rotation.x = Math.PI;
  for (const side of [-1, 1]) {
    add(surface({ span: 0.95, root: 0.55, tip: 0.45, sweep: 0.1, dihedral: 0, t: 0.1, side }), m.white, side * 0.1, 0.52, 5.6);
    add(surface({ span: 0.35, root: 0.45, tip: 0.35, sweep: 0.3, dihedral: 0, t: 0.08, vertical: true }), m.paint, side * 1.05, 0.38, 5.7);
  }
  // skids: tubes with up-turned toes on curved cross tubes
  for (const side of [-1, 1]) {
    const path = new THREE.CatmullRomCurve3([new THREE.Vector3(side * 1.1, -1.12, -2.05), new THREE.Vector3(side * 1.1, -1.32, -1.75), new THREE.Vector3(side * 1.1, -1.35, -1.2), new THREE.Vector3(side * 1.1, -1.35, 1.6), new THREE.Vector3(side * 1.1, -1.3, 1.95)]);
    add(new THREE.TubeGeometry(path, 40, 0.045, 10), m.metal);
  }
  for (const z of [-1.0, 0.95]) {
    const arc = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.1, -1.33, z), new THREE.Vector3(-0.85, -0.85, z), new THREE.Vector3(-0.4, -0.72, z), new THREE.Vector3(0.4, -0.72, z), new THREE.Vector3(0.85, -0.85, z), new THREE.Vector3(1.1, -1.33, z)]);
    add(new THREE.TubeGeometry(arc, 30, 0.04, 8), m.metal);
  }
  // mast, swashplate and hub
  add(new THREE.CylinderGeometry(0.07, 0.09, 0.55, 14), m.metal, 0, 1.38, 0.15);
  add(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 20), m.metal, 0, 1.22, 0.15);
  const main = buildRotor(m, 5.35, 0.29, 4, 4, 'y');
  main.root.position.set(0, 1.68, 0.15); g.add(main.root);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.16, 16), m.dark); main.spin.add(hub);
  const tail = buildRotor(m, 0.85, 0.16, 2, 3, 'x');
  tail.root.position.set(-0.24, 0.92, 7.45); g.add(tail.root);
  // lights
  const strobes: THREE.Mesh[] = [], beacons: THREE.Mesh[] = [];
  const dot = new THREE.SphereGeometry(0.06, 10, 8);
  add(dot, lightMat(6, 0.15, 0.1), -1.06, 0.5, 5.7); add(dot, lightMat(0.1, 6, 0.4), 1.06, 0.5, 5.7);
  strobes.push(add(dot, lightMat(30, 30, 30), 0, 0.62, 7.8));
  beacons.push(add(dot, lightMat(20, 0.6, 0.3), 0, 1.05, 2.2), add(dot, lightMat(20, 0.6, 0.3), 0, -0.82, 0.2));
  return { group: g, main, tail, strobes, beacons };
}

// ------------------------------------------------------------------ visual
export interface AirState { kind: VehicleKind; rotor: number; rpm: number; load: number; vf: number; vs: number; heliMax: number; crashed: boolean }

export class AircraftVisual {
  readonly root = new THREE.Group();
  private m = mats();
  private jet = buildJet(this.m);
  private heli = buildHeli(this.m);
  private time = 0;
  private shown: VehicleKind = 'plane';
  /** Replacement GLB models (public/planes/jet.glb, heli.glb) if the owner adds licensed ones. */
  private custom: Partial<Record<VehicleKind, THREE.Object3D>> = {};

  constructor() {
    this.root.add(this.jet.group, this.heli.group);
    this.root.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh && !(me.material as THREE.Material).transparent && !(me.material instanceof THREE.MeshBasicMaterial)) { me.castShadow = true; me.receiveShadow = true; } });
    this.setKind('plane');
    void this.tryCustom('plane', 'jet.glb'); void this.tryCustom('heli', 'heli.glb');
  }

  private async tryCustom(kind: VehicleKind, file: string): Promise<void> {
    try {
      const head = await fetch(import.meta.env.BASE_URL + 'planes/' + file, { method: 'HEAD' });
      if (!head.ok || !/model|octet|gltf/.test(head.headers.get('content-type') ?? '')) return;
      const gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'planes/' + file);
      const s = gltf.scene; s.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.custom[kind] = s; this.root.add(s); this.setKind(this.shown);
    } catch { /* keep the built-in model */ }
  }

  setKind(kind: VehicleKind): void {
    this.shown = kind;
    this.jet.group.visible = kind === 'plane' && !this.custom.plane;
    this.heli.group.visible = kind === 'heli' && !this.custom.heli;
    if (this.custom.plane) this.custom.plane.visible = kind === 'plane';
    if (this.custom.heli) this.custom.heli.visible = kind === 'heli';
  }
  setColor(hex: string): void { this.m.paint.color.set(hex); }
  refreshMaterials(): void { for (const mm of Object.values(this.m)) (mm as THREE.Material).needsUpdate = true; }

  animate(a: AirState, dt: number): void {
    this.time += dt;
    // anti-collision lights: double strobe flash every 1.2 s, beacon 1 Hz
    const ts = this.time % 1.2, strobe = ts < 0.05 || (ts > 0.16 && ts < 0.21), beacon = this.time % 1.0 < 0.12;
    for (const set of [this.jet, this.heli]) { for (const s of set.strobes) s.visible = strobe; for (const b of set.beacons) b.visible = beacon; }
    if (a.kind === 'plane') {
      // fan face: the blades are visible only as a blur at operating N1
      for (const f of this.jet.fans) f.rotation.z += dt * (8 + a.rpm * 0.1);
      return;
    }
    this.animateRotor(this.heli.main, a, dt, true);
    this.animateRotor(this.heli.tail, a, dt, false);
  }

  private animateRotor(r: Rotor, a: AirState, dt: number, main: boolean): void {
    // spin-up (0..1): full rotor speed in flight, slows when crashed
    const spinUp = a.crashed ? 0.15 : Math.min(1, a.rpm / 390);
    const blur = THREE.MathUtils.smoothstep(spinUp, 0.25, 0.85);
    // Apparent rotation: the true rate (~6.5 rev/s, tail ~5x) aliases at 60 fps. Below the
    // blur point show it; once blurred, turn at a calm rate a slow shutter would suggest.
    const trueRate = (main ? 6.5 : 33) * spinUp * Math.PI * 2;
    const calm = (main ? 1.1 : 2.4) * Math.PI * 2;
    r.spin.rotation.y += dt * THREE.MathUtils.lerp(trueRate, calm, blur);
    r.bladeMat.opacity = 1 - blur * 0.82;
    r.bladeMat.depthWrite = r.bladeMat.opacity > 0.6;
    for (const gh of r.ghosts) (gh.material as THREE.MeshBasicMaterial).opacity = blur * 0.2 * (1 - (gh.material as any).userData.age);
    r.discMat.opacity = blur * (main ? 0.85 : 0.7);
    if (r.ringMat) r.ringMat.opacity = blur * 0.12;
    if (main) {
      // coning under load, and the disc tilts toward the direction of flight (cyclic)
      const cone = 0.025 + 0.05 * a.load;
      for (const b of r.blades) b.rotation.z = cone; for (const gh of r.ghosts) gh.rotation.z = cone;
      r.root.rotation.x += ((-a.vf / a.heliMax) * 0.11 - r.root.rotation.x) * Math.min(1, dt * 4);
      r.root.rotation.z += ((a.vs / 16) * 0.09 - r.root.rotation.z) * Math.min(1, dt * 4);
    }
  }
}

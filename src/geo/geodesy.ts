// All lat/lon <-> local-frame math lives here (CLAUDE.md §9.1). Float64 only.
// Local frame: origin at ORIGIN on the ellipsoid (h = 0), X east, Y up, Z south.
import { ORIGIN } from '../config';

const A = 6378137.0; // GRS80 / WGS84 semi-major axis
const F = 1 / 298.257222101; // GRS80 (JGD2011); differs from WGS84 by < 0.1 mm
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);
const D2R = Math.PI / 180;

export interface Vec3 { x: number; y: number; z: number }

export function llaToEcef(lat: number, lon: number, h: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const p = lat * D2R, l = lon * D2R;
  const sp = Math.sin(p), cp = Math.cos(p);
  const n = A / Math.sqrt(1 - E2 * sp * sp);
  out.x = (n + h) * cp * Math.cos(l);
  out.y = (n + h) * cp * Math.sin(l);
  out.z = (n * (1 - E2) + h) * sp;
  return out;
}

export function ecefToLla(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  // Bowring initial guess + Newton-style fixed point iterations
  let th = Math.atan2(z * A, p * B);
  let lat = Math.atan2(z + EP2 * B * Math.sin(th) ** 3, p - E2 * A * Math.cos(th) ** 3);
  for (let i = 0; i < 4; i++) {
    const sp = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sp * sp);
    lat = Math.atan2(z + E2 * n * sp, p);
  }
  const sp = Math.sin(lat), cp = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sp * sp);
  const h = Math.abs(cp) > 1e-6 ? p / cp - n : Math.abs(z) / Math.abs(sp) - n * (1 - E2);
  return { lat: lat / D2R, lon: lon / D2R, h };
}

export class LocalFrame {
  readonly lat0: number; readonly lon0: number;
  private ox: number; private oy: number; private oz: number;
  // rows of the ECEF->ENU rotation
  private e: [number, number, number]; private n: [number, number, number]; private u: [number, number, number];

  constructor(lat0: number, lon0: number) {
    this.lat0 = lat0; this.lon0 = lon0;
    const o = llaToEcef(lat0, lon0, 0);
    this.ox = o.x; this.oy = o.y; this.oz = o.z;
    const p = lat0 * D2R, l = lon0 * D2R;
    const sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l);
    this.e = [-sl, cl, 0];
    this.n = [-sp * cl, -sp * sl, cp];
    this.u = [cp * cl, cp * sl, sp];
  }

  ecefToLocal(x: number, y: number, z: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const dx = x - this.ox, dy = y - this.oy, dz = z - this.oz;
    const e = this.e, n = this.n, u = this.u;
    out.x = e[0] * dx + e[1] * dy + e[2] * dz;
    out.y = u[0] * dx + u[1] * dy + u[2] * dz;
    out.z = -(n[0] * dx + n[1] * dy + n[2] * dz);
    return out;
  }

  localToEcef(x: number, y: number, z: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const e = this.e, n = this.n, u = this.u;
    const nn = -z;
    out.x = this.ox + e[0] * x + n[0] * nn + u[0] * y;
    out.y = this.oy + e[1] * x + n[1] * nn + u[1] * y;
    out.z = this.oz + e[2] * x + n[2] * nn + u[2] * y;
    return out;
  }

  llaToLocal(lat: number, lon: number, h = 0, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const c = llaToEcef(lat, lon, h, tmp);
    return this.ecefToLocal(c.x, c.y, c.z, out);
  }

  localToLla(x: number, y: number, z: number): { lat: number; lon: number; h: number } {
    const c = this.localToEcef(x, y, z, tmp);
    return ecefToLla(c.x, c.y, c.z);
  }

  /** Column-major 4x4 (Three.js Matrix4.elements layout) mapping ECEF -> local. */
  ecefToLocalMatrix(): number[] {
    const e = this.e, n = this.n, u = this.u;
    const r0 = e, r1 = u, r2 = [-n[0], -n[1], -n[2]];
    const t = (r: number[]) => -(r[0] * this.ox + r[1] * this.oy + r[2] * this.oz);
    return [
      r0[0], r1[0], r2[0], 0,
      r0[1], r1[1], r2[1], 0,
      r0[2], r1[2], r2[2], 0,
      t(r0), t(r1), t(r2), 1,
    ];
  }
}
const tmp: Vec3 = { x: 0, y: 0, z: 0 };

export const frame = new LocalFrame(ORIGIN.lat, ORIGIN.lon);

// ---- Web-mercator XYZ tile math -------------------------------------------
export function lonToTileX(lon: number, z: number): number { return ((lon + 180) / 360) * 2 ** z; }
export function latToTileY(lat: number, z: number): number {
  const p = lat * D2R;
  return ((1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2) * 2 ** z;
}
export function tileXToLon(x: number, z: number): number { return (x / 2 ** z) * 360 - 180; }
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / D2R;
}

// ---- Geoid (ellipsoidal height = orthometric + geoid) ----------------------
export interface GeoidGrid { lat0: number; lon0: number; step: number; nx: number; ny: number; values: number[] }
let geoid: GeoidGrid | null = null;
export function setGeoid(g: GeoidGrid): void { geoid = g; }
export function geoidHeight(lat: number, lon: number): number {
  if (!geoid) return 36.9;
  const g = geoid;
  let fx = (lon - g.lon0) / g.step, fy = (lat - g.lat0) / g.step;
  fx = Math.min(Math.max(fx, 0), g.nx - 1.0001); fy = Math.min(Math.max(fy, 0), g.ny - 1.0001);
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const v = g.values, i = iy * g.nx + ix;
  return (v[i] * (1 - tx) + v[i + 1] * tx) * (1 - ty) + (v[i + g.nx] * (1 - tx) + v[i + g.nx + 1] * tx) * ty;
}

import { describe, expect, it } from 'vitest';
import { LocalFrame, ecefToLla, llaToEcef } from './geodesy';

const f = new LocalFrame(35.6896, 139.7006);
const TOKYO = { lat: 35.6812, lon: 139.7671 };
const TACHIKAWA = { lat: 35.6977, lon: 139.4137 };
const YOKOHAMA = { lat: 35.4549, lon: 139.6319 };

// Reference geodesic distances (Vincenty on GRS80), computed independently.
function vincenty(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const A = 6378137, F = 1 / 298.257222101, B = A * (1 - F), R = Math.PI / 180;
  const U1 = Math.atan((1 - F) * Math.tan(a.lat * R)), U2 = Math.atan((1 - F) * Math.tan(b.lat * R));
  const L = (b.lon - a.lon) * R; let lam = L, sinS = 0, cosS = 0, sig = 0, cos2A = 0, cos2SM = 0;
  for (let i = 0; i < 100; i++) {
    const sl = Math.sin(lam), cl = Math.cos(lam);
    sinS = Math.hypot(Math.cos(U2) * sl, Math.cos(U1) * Math.sin(U2) - Math.sin(U1) * Math.cos(U2) * cl);
    cosS = Math.sin(U1) * Math.sin(U2) + Math.cos(U1) * Math.cos(U2) * cl;
    sig = Math.atan2(sinS, cosS);
    const sinA = (Math.cos(U1) * Math.cos(U2) * sl) / sinS; cos2A = 1 - sinA * sinA;
    cos2SM = cosS - (2 * Math.sin(U1) * Math.sin(U2)) / cos2A;
    const C = (F / 16) * cos2A * (4 + F * (4 - 3 * cos2A));
    const next = L + (1 - C) * F * sinA * (sig + C * sinS * (cos2SM + C * cosS * (-1 + 2 * cos2SM ** 2)));
    if (Math.abs(next - lam) < 1e-13) { lam = next; break; }
    lam = next;
  }
  const u2 = (cos2A * (A * A - B * B)) / (B * B);
  const AA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const BB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = BB * sinS * (cos2SM + (BB / 4) * (cosS * (-1 + 2 * cos2SM ** 2) - (BB / 6) * cos2SM * (-3 + 4 * sinS ** 2) * (-3 + 4 * cos2SM ** 2)));
  return B * AA * (sig - dS);
}

describe('geodesy', () => {
  it('round-trips lat/lon -> local -> lat/lon under 1 mm', () => {
    for (const p of [TOKYO, TACHIKAWA, YOKOHAMA]) for (const h of [0, 40, 300]) {
      const l = f.llaToLocal(p.lat, p.lon, h);
      const b = f.localToLla(l.x, l.y, l.z);
      const back = f.llaToLocal(b.lat, b.lon, b.h);
      expect(Math.hypot(back.x - l.x, back.y - l.y, back.z - l.z)).toBeLessThan(1e-3);
      expect(Math.abs(b.lat - p.lat) * 111_000).toBeLessThan(1e-3);
      expect(Math.abs(b.lon - p.lon) * 91_000).toBeLessThan(1e-3);
      expect(Math.abs(b.h - h)).toBeLessThan(1e-3);
    }
  });
  it('ecef round trip', () => {
    const e = llaToEcef(35.6812, 139.7671, 12.5);
    const b = ecefToLla(e.x, e.y, e.z);
    expect(b.lat).toBeCloseTo(35.6812, 10); expect(b.lon).toBeCloseTo(139.7671, 10); expect(b.h).toBeCloseTo(12.5, 5);
  });
  it('known inter-point distances within 0.1%', () => {
    const pairs: [typeof TOKYO, typeof TOKYO][] = [[TOKYO, TACHIKAWA], [TOKYO, YOKOHAMA], [TACHIKAWA, YOKOHAMA]];
    for (const [a, b] of pairs) {
      const la = f.llaToLocal(a.lat, a.lon), lb = f.llaToLocal(b.lat, b.lon);
      const d = Math.hypot(la.x - lb.x, la.y - lb.y, la.z - lb.z), ref = vincenty(a, b);
      expect(Math.abs(d - ref) / ref).toBeLessThan(1e-3);
    }
    // sanity: Tokyo Station <-> Tachikawa Station is ~32 km
    expect(vincenty(TOKYO, TACHIKAWA)).toBeGreaterThan(31_500);
    expect(vincenty(TOKYO, TACHIKAWA)).toBeLessThan(32_500);
  });
  it('axes: east is +X, north is -Z, up is +Y; all coverage within 40 km', () => {
    const e = f.llaToLocal(35.6896, 139.7106), n = f.llaToLocal(35.6996, 139.7006), u = f.llaToLocal(35.6896, 139.7006, 100);
    expect(e.x).toBeGreaterThan(800); expect(Math.abs(e.z)).toBeLessThan(1);
    expect(n.z).toBeLessThan(-1000); expect(Math.abs(n.x)).toBeLessThan(1);
    expect(u.y).toBeCloseTo(100, 6);
    for (const p of [TOKYO, TACHIKAWA, YOKOHAMA]) { const l = f.llaToLocal(p.lat, p.lon); expect(Math.hypot(l.x, l.z)).toBeLessThan(40_000); }
  });
});

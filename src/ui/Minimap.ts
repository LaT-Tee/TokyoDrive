// Zoomed-in minimap with a compass, in the HUD. North-up, so the map's labels always
// read upright; the vehicle arrow turns with the heading and the red N on the rim marks
// north. Base map: GSI standard map tiles (public, no key).
import { latToTileY, lonToTileX } from '../geo/geodesy';

const TILES = 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Minimap {
  readonly el = document.createElement('div');
  private canvas = document.createElement('canvas');
  private label = document.createElement('div');
  private cache = new Map<string, HTMLImageElement>();
  private size = 190;
  private last = 0;

  constructor() {
    this.el.className = 'minimap';
    this.label.className = 'minimap-heading';
    this.el.append(this.canvas, this.label);
  }

  private tile(z: number, x: number, y: number): HTMLImageElement | null {
    const key = `${z}/${x}/${y}`;
    let img = this.cache.get(key);
    if (!img) {
      img = new Image(); img.crossOrigin = 'anonymous';
      img.src = TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      this.cache.set(key, img);
      if (this.cache.size > 160) this.cache.delete(this.cache.keys().next().value!);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  /**
   * @param heading radians clockwise from north   @param zoom web-mercator zoom (fractional ok)
   */
  update(lat: number, lon: number, heading: number, zoom: number, now: number): void {
    if (now - this.last < 66) return; // ~15 fps is plenty for a map
    this.last = now;
    const dpr = Math.min(2, window.devicePixelRatio || 1), S = this.size;
    if (this.canvas.width !== S * dpr) { this.canvas.width = this.canvas.height = S * dpr; this.canvas.style.width = this.canvas.style.height = S + 'px'; }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const r = S / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#d9d6cf'; ctx.fillRect(0, 0, S, S);
    // map: integer tile zoom, scaled to the fractional zoom; north up
    const z = Math.max(5, Math.min(18, Math.floor(zoom))), scale = 2 ** (zoom - z), px = 256 * scale;
    const fx = lonToTileX(lon, z), fy = latToTileY(lat, z);
    ctx.translate(r, r);
    const reach = Math.ceil((r * 1.5) / px);
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      const tx = Math.floor(fx) + dx, ty = Math.floor(fy) + dy;
      const img = this.tile(z, tx, ty);
      if (img) ctx.drawImage(img, (tx - fx) * px, (ty - fy) * px, px + 0.5, px + 0.5);
    }
    ctx.restore();
    // vignette + rim
    const g = ctx.createRadialGradient(r, r, r * 0.55, r, r, r);
    g.addColorStop(0, 'rgba(12,14,18,0)'); g.addColorStop(1, 'rgba(12,14,18,0.35)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(16,18,22,0.85)'; ctx.stroke();
    // compass: cardinal letters on the rim; N in red
    ctx.font = '700 12px "Hiragino Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2, x = r + Math.sin(a) * (r - 13), y = r - Math.cos(a) * (r - 13);
      ctx.fillStyle = 'rgba(16,18,22,0.78)'; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = i === 0 ? '#ff5a36' : '#f4f1ea'; ctx.fillText('NESW'[i], x, y + 0.5);
    }
    // vehicle marker, pointing along the heading
    ctx.save(); ctx.translate(r, r); ctx.rotate(heading);
    ctx.fillStyle = '#ff5a36'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    const deg = ((Math.round((heading * 180) / Math.PI) % 360) + 360) % 360;
    const text = `${DIRS[Math.round(deg / 45) % 8]} ${deg}°`;
    if (this.label.textContent !== text) this.label.textContent = text;
  }
}

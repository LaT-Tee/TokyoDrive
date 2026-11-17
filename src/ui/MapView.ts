// Region map with click-to-teleport. Teleporting is only allowed inside the
// prepared coverage (the manifest's building tilesets); everything else is
// dimmed and refused. Base map: GSI pale tiles (public, no key).
import { latToTileY, lonToTileX, tileXToLon, tileYToLat } from '../geo/geodesy';
import type { SpawnPoint } from '../config';
import { onLangChange, t } from '../i18n';

export interface MapOptions {
  bounds: { west: number; south: number; east: number; north: number };
  coverage: { west: number; south: number; east: number; north: number }[];
  spawns: SpawnPoint[];
  covers(lat: number, lon: number): boolean;
  onPick(lat: number, lon: number): void;
  onClose(): void;
}

const TILES = 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png';

export class MapView {
  readonly el = document.createElement('div');
  private canvas = document.createElement('canvas');
  private note = document.createElement('div');
  private cache = new Map<string, HTMLImageElement>();
  private z = 11; private cx: number; private cy: number; // centre in tile units at zoom z
  private car = { lat: 0, lon: 0, heading: 0 };
  private drag: { x: number; y: number; moved: boolean } | null = null;

  constructor(private opt: MapOptions) {
    this.el.className = 'mapview hidden';
    const bar = document.createElement('div'); bar.className = 'mapbar';
    const title = document.createElement('span');
    const close = document.createElement('button'); close.type = 'button'; close.className = 'menu-btn static';
    const label = () => { title.textContent = t('map.title'); close.textContent = t('map.close'); if (this.open) this.draw(); };
    label(); onLangChange(label);
    close.addEventListener('click', () => opt.onClose());
    bar.append(title, close);
    this.note.className = 'mapnote';
    this.el.append(this.canvas, bar, this.note);
    const b = opt.bounds;
    this.cx = lonToTileX((b.west + b.east) / 2, this.z); this.cy = latToTileY((b.south + b.north) / 2, this.z);

    this.canvas.addEventListener('pointerdown', (e) => { this.drag = { x: e.clientX, y: e.clientY, moved: false }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.drag.moved = true;
      if (this.drag.moved) { this.cx -= dx / 256; this.cy -= dy / 256; this.drag.x = e.clientX; this.drag.y = e.clientY; this.clampView(); this.draw(); }
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const d = this.drag; this.drag = null;
      if (!d || d.moved) return;
      const r = this.canvas.getBoundingClientRect();
      const tx = this.cx + (e.clientX - r.left - r.width / 2) / 256, ty = this.cy + (e.clientY - r.top - r.height / 2) / 256;
      const lat = tileYToLat(ty, this.z), lon = tileXToLon(tx, this.z);
      if (opt.covers(lat, lon)) opt.onPick(lat, lon);
      else this.flash(t('map.outside'));
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const nz = Math.max(10, Math.min(16, this.z + (e.deltaY < 0 ? 1 : -1)));
      if (nz === this.z) return;
      const r = this.canvas.getBoundingClientRect();
      const ox = (e.clientX - r.left - r.width / 2) / 256, oy = (e.clientY - r.top - r.height / 2) / 256;
      const k = 2 ** (nz - this.z);
      this.cx = (this.cx + ox) * k - ox; this.cy = (this.cy + oy) * k - oy; this.z = nz;
      this.clampView(); this.draw();
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.open) this.draw(); });
  }

  get open(): boolean { return !this.el.classList.contains('hidden'); }

  show(on: boolean, car?: { lat: number; lon: number; heading: number }): void {
    this.el.classList.toggle('hidden', !on);
    if (on && car) {
      this.car = car;
      this.z = 12; this.cx = lonToTileX(car.lon, this.z); this.cy = latToTileY(car.lat, this.z);
      this.clampView(); this.draw();
    }
  }

  private flash(text: string): void {
    this.note.textContent = text; this.note.classList.add('show');
    setTimeout(() => this.note.classList.remove('show'), 1600);
  }

  private clampView(): void {
    const b = this.opt.bounds;
    this.cx = Math.max(lonToTileX(b.west, this.z), Math.min(lonToTileX(b.east, this.z), this.cx));
    this.cy = Math.max(latToTileY(b.north, this.z), Math.min(latToTileY(b.south, this.z), this.cy));
  }

  private tile(z: number, x: number, y: number): HTMLImageElement | null {
    const key = `${z}/${x}/${y}`;
    let img = this.cache.get(key);
    if (!img) {
      img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { if (this.open) this.draw(); };
      img.src = TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      this.cache.set(key, img);
      if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value!);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  private draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) { this.canvas.width = w * dpr; this.canvas.height = h * dpr; }
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1d22'; ctx.fillRect(0, 0, w, h);
    const px = (tx: number) => (tx - this.cx) * 256 + w / 2, py = (ty: number) => (ty - this.cy) * 256 + h / 2;
    const x0 = Math.floor(this.cx - w / 512), x1 = Math.floor(this.cx + w / 512), y0 = Math.floor(this.cy - h / 512), y1 = Math.floor(this.cy + h / 512);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const img = this.tile(this.z, x, y);
      if (img) ctx.drawImage(img, Math.round(px(x)), Math.round(py(y)), 256, 256);
    }
    // dim everything, then punch the coverage back out
    const dim = document.createElement('canvas'); dim.width = w; dim.height = h;
    const d = dim.getContext('2d')!;
    d.fillStyle = 'rgba(12,14,18,0.72)'; d.fillRect(0, 0, w, h);
    d.globalCompositeOperation = 'destination-out'; d.fillStyle = '#000';
    for (const c of this.opt.coverage) {
      const ax = px(lonToTileX(c.west, this.z)), bx = px(lonToTileX(c.east, this.z)), ay = py(latToTileY(c.north, this.z)), by = py(latToTileY(c.south, this.z));
      d.fillRect(ax, ay, bx - ax, by - ay);
    }
    ctx.drawImage(dim, 0, 0);
    // spawn points
    ctx.font = '12px "Hiragino Sans", sans-serif'; ctx.textBaseline = 'middle';
    for (const s of this.opt.spawns) {
      const x = px(lonToTileX(s.lon, this.z)), y = py(latToTileY(s.lat, this.z));
      ctx.fillStyle = '#14110f'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd166'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(t(`spawn.${s.id}`), x + 9, y);
      ctx.fillStyle = '#14110f'; ctx.fillText(t(`spawn.${s.id}`), x + 9, y);
    }
    // car
    const cxp = px(lonToTileX(this.car.lon, this.z)), cyp = py(latToTileY(this.car.lat, this.z));
    ctx.save(); ctx.translate(cxp, cyp); ctx.rotate(this.car.heading);
    ctx.fillStyle = '#ff5a36'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}

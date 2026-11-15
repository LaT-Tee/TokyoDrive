// Garage / start screen and HUD (plain DOM, no framework).
import { SPAWNS, type Quality, type SpawnPoint } from '../config';
import { BODY_COLORS, CARS, type CarSpec } from '../car/garage';

export interface UiCallbacks {
  onCar(spec: CarSpec): void;
  onColor(hex: string): void;
  onSpawn(spawn: SpawnPoint): void;
  onQuality(q: Quality): void;
  onStart(): void;
  onOpenGarage(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Ui {
  private garage = el('section', 'garage');
  private hud = el('div', 'hud hidden');
  private speedNum = el('div', 'num', '0');
  private city = el('div', 'city');
  private road = el('div', 'road');
  private camTag = el('span', '', 'CHASE');
  private lightTag = el('span', '', 'LIGHTS');
  private loading = el('div', 'loading hidden');
  private startBtn = el('button', 'go', 'DRIVE');
  private lastSpeed = -1; private lastCity = ''; private lastRoad = '';

  constructor(root: HTMLElement, cb: UiCallbacks, initial: { car: string; color: string; spawn: string; quality: Quality }) {
    const g = this.garage;
    const head = el('div');
    const h1 = el('h1'); h1.append('TOKYO ', el('span', '', 'DRIVE'));
    head.append(h1, el('p', 'sub', '東京・横浜 フリードライブ'));
    g.append(head);

    const group = <T,>(title: string, items: T[], label: (t: T) => [string, string?], key: (t: T) => string, sel: string, pick: (t: T) => void) => {
      const box = el('div'); box.append(el('h2', '', title));
      const grid = el('div', 'grid');
      const btns: HTMLButtonElement[] = [];
      for (const it of items) {
        const b = el('button', 'opt'); b.type = 'button';
        const [main, sub] = label(it);
        b.append(main); if (sub) b.append(el('small', '', sub));
        b.setAttribute('aria-pressed', String(key(it) === sel));
        b.addEventListener('click', () => { btns.forEach((o) => o.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); pick(it); b.blur(); });
        btns.push(b); grid.append(b);
      }
      box.append(grid); g.append(box);
    };

    group('Car', CARS, (c) => [c.name, `${c.topSpeed} km/h`], (c) => c.id, initial.car, cb.onCar);

    const colorBox = el('div'); colorBox.append(el('h2', '', 'Body color'));
    const sw = el('div', 'swatches');
    const swBtns: HTMLButtonElement[] = [];
    const custom = el('input'); custom.type = 'color'; custom.value = initial.color; custom.setAttribute('aria-label', 'カスタムカラー');
    for (const c of BODY_COLORS) {
      const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
      b.setAttribute('aria-pressed', String(c === initial.color));
      b.addEventListener('click', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); custom.value = c; cb.onColor(c); b.blur(); });
      swBtns.push(b); sw.append(b);
    }
    custom.addEventListener('input', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); cb.onColor(custom.value); });
    sw.append(custom); colorBox.append(sw); g.append(colorBox);

    group('Start point', SPAWNS, (s) => [s.name], (s) => s.id, initial.spawn, cb.onSpawn);
    const qs: { id: Quality; name: string; sub: string }[] = [
      { id: 'performance', name: 'Performance', sub: '軽い' }, { id: 'balanced', name: 'Balanced', sub: '標準' }, { id: 'ultra', name: 'Ultra', sub: '高精細' },
    ];
    group('Quality', qs, (q) => [q.name, q.sub], (q) => q.id, initial.quality, (q) => cb.onQuality(q.id));

    const keys = el('p', 'keys');
    keys.innerHTML = '<b>W/S</b> アクセル・ブレーキ　<b>A/D</b> ハンドル　<b>Space</b> サイドブレーキ<br><b>R</b> 道路に復帰　<b>C</b> カメラ　<b>L</b> ライト　<b>G</b> ガレージ';
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => cb.onStart());
    g.append(keys, this.startBtn, el('p', 'credit', '3D都市モデル: Project PLATEAU (国土交通省) / 標高・航空写真: 国土地理院 / 道路: © OpenStreetMap contributors / 車両: Kenney (CC0)'));

    const h = this.hud;
    const speed = el('div', 'speed'); speed.append(this.speedNum, el('div', 'unit', 'KM/H'));
    const place = el('div', 'place'); place.append(this.city, this.road);
    const status = el('div', 'status'); status.append(this.camTag, this.lightTag);
    const menu = el('button', 'menu-btn', 'GARAGE'); menu.type = 'button';
    menu.addEventListener('click', () => { menu.blur(); cb.onOpenGarage(); });
    h.append(speed, place, status, this.loading, menu);
    root.append(h, g);
  }

  showGarage(show: boolean): void {
    this.garage.classList.toggle('hidden', !show);
    this.hud.classList.toggle('hidden', show);
  }
  get garageOpen(): boolean { return !this.garage.classList.contains('hidden'); }

  setStartEnabled(ok: boolean, label: string): void { this.startBtn.disabled = !ok; this.startBtn.textContent = label; }

  setHud(kmh: number, city: string, road: string, cam: string, lights: boolean, loadingText: string): void {
    const s = Math.round(Math.abs(kmh));
    if (s !== this.lastSpeed) { this.speedNum.textContent = String(s); this.lastSpeed = s; }
    if (city !== this.lastCity) { this.city.textContent = city; this.lastCity = city; }
    if (road !== this.lastRoad) { this.road.textContent = road; this.lastRoad = road; }
    this.camTag.textContent = cam;
    this.lightTag.classList.toggle('on', lights);
    this.loading.classList.toggle('hidden', !loadingText);
    if (loadingText) this.loading.textContent = loadingText;
  }
}

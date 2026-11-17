// Garage / start screen and HUD (plain DOM, no framework).
import { SPAWNS, type Quality, type SpawnPoint } from '../config';
import { BODY_COLORS, VEHICLES, type CarSpec } from '../car/garage';

export interface UiCallbacks {
  onCar(spec: CarSpec): void;
  onColor(hex: string): void;
  onSpawn(spawn: SpawnPoint): void;
  onQuality(q: Quality): void;
  onStart(): void;
  onOpenGarage(): void;
  onCycleCamera(): void;
  onToggleLights(): void;
  onMap(): void;
  onRecover(): void;
  onGoogleToken(token: string): void;
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
  private camBtn = el('button', 'hud-btn');
  private lightBtn = el('button', 'hud-btn');
  private loading = el('div', 'loading hidden');
  private startBtn = el('button', 'go', '出发');
  private googleStatus = el('p', 'hint');
  private credits = el('div', 'credits');
  private cockpit = el('div', 'cockpit hidden');
  private wheel = el('div', 'wheel');
  private lastSpeed = -1; private lastCity = ''; private lastRoad = ''; private lastCam = ''; private lastLights: boolean | null = null;

  constructor(root: HTMLElement, cb: UiCallbacks, initial: { car: string; color: string; spawn: string; quality: Quality; googleToken: string }) {
    const g = this.garage;
    const head = el('div');
    const h1 = el('h1'); h1.append('TOKYO ', el('span', '', 'DRIVE'));
    head.append(h1, el('p', 'sub', '东京・横滨 自由驾驶'));
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

    group('载具', VEHICLES, (c) => [c.name, c.note], (c) => c.id, initial.car, cb.onCar);

    const colorBox = el('div'); colorBox.append(el('h2', '', '车身颜色'));
    const sw = el('div', 'swatches');
    const swBtns: HTMLButtonElement[] = [];
    const custom = el('input'); custom.type = 'color'; custom.value = initial.color; custom.setAttribute('aria-label', '自定义颜色');
    for (const c of BODY_COLORS) {
      const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
      b.setAttribute('aria-pressed', String(c === initial.color));
      b.addEventListener('click', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); custom.value = c; cb.onColor(c); b.blur(); });
      swBtns.push(b); sw.append(b);
    }
    custom.addEventListener('input', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); cb.onColor(custom.value); });
    sw.append(custom); colorBox.append(sw); g.append(colorBox);

    group('出发地点', SPAWNS, (s) => [s.name], (s) => s.id, initial.spawn, cb.onSpawn);
    const qs: { id: Quality; name: string; sub: string }[] = [
      { id: 'performance', name: '流畅', sub: '低负载，无阴影' }, { id: 'balanced', name: '均衡', sub: '默认' }, { id: 'ultra', name: '极致', sub: '更远、更细，负载高' },
    ];
    group('画质（切换后建筑会重新加载）', qs, (q) => [q.name, q.sub], (q) => q.id, initial.quality, (q) => cb.onQuality(q.id));

    // optional Google 3D fill (player's own key; stored only in this browser)
    const gBox = el('div'); gBox.append(el('h2', '', 'Google 3D 补全（可选）'));
    const gRow = el('div', 'token-row');
    const gIn = el('input'); gIn.type = 'password'; gIn.placeholder = 'Cesium ion 令牌 或 Google Maps API key'; gIn.value = initial.googleToken; gIn.autocomplete = 'off'; gIn.spellcheck = false;
    gIn.setAttribute('aria-label', 'Cesium ion 令牌或 Google Maps API key');
    const gBtn = el('button', 'opt', '应用'); gBtn.type = 'button';
    gBtn.addEventListener('click', () => { cb.onGoogleToken(gIn.value); gBtn.blur(); });
    gRow.append(gIn, gBtn);
    gBox.append(gRow, this.googleStatus, el('p', 'hint', 'PLATEAU 没有模型的地方用 Google 扫描模型补上（寺庙、公园建筑、树等）。留空即关闭。令牌只保存在本浏览器。'));
    g.append(gBox);

    const keys = el('p', 'keys');
    keys.innerHTML = '<b>汽车</b>　W/S 油门・刹车　A/D 转向　空格 手刹<br><b>飞机</b>　W/S 压杆・拉杆　A/D 滚转　Q/E 方向舵　空格/Shift 加减油门<br><b>直升机</b>　W/S 前后　A/D 转向　Q/E 横移　空格/Shift 升降<br><b>C</b> 视角　<b>鼠标</b> 环顾・滚轮远近　<b>L</b> 灯　<b>R</b> 复位　<b>M</b> 地图　<b>N</b> 静音　<b>G</b> 车库';
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => cb.onStart());
    g.append(keys, this.startBtn, el('p', 'credit', '3D 城市模型: Project PLATEAU（国土交通省）/ 高程・航拍・地图: 国土地理院 / 道路: © OpenStreetMap contributors / 车辆: Kenney (CC0)'));

    const h = this.hud;
    const speed = el('div', 'speed'); speed.append(this.speedNum, el('div', 'unit', 'KM/H'));
    const place = el('div', 'place'); place.append(this.city, this.road);
    const bar = el('div', 'hud-bar');
    const btn = (b: HTMLButtonElement, text: string, fn: () => void) => { b.type = 'button'; b.textContent = text; b.addEventListener('click', () => { b.blur(); fn(); }); bar.append(b); return b; };
    btn(el('button', 'hud-btn'), '车库 G', cb.onOpenGarage);
    btn(el('button', 'hud-btn'), '地图 M', cb.onMap);
    btn(el('button', 'hud-btn'), '回到道路 R', cb.onRecover);
    btn(this.camBtn, '视角 C', cb.onCycleCamera);
    btn(this.lightBtn, '车灯 L', cb.onToggleLights);
    // cockpit overlay: dashboard + steering wheel (right-hand drive)
    const dash = el('div', 'dash'); this.wheel.append(el('div', 'spoke'), el('div', 'spoke v')); this.cockpit.append(el('div', 'pillar l'), el('div', 'pillar r'), dash, this.wheel);
    h.append(this.cockpit, speed, place, bar, this.loading, this.credits);
    root.append(h, g);
  }

  setGoogleStatus(text: string): void { if (this.googleStatus.textContent !== text) this.googleStatus.textContent = text; }
  setCredits(text: string): void { if (this.credits.textContent !== text) this.credits.textContent = text; }

  showGarage(show: boolean): void {
    this.garage.classList.toggle('hidden', !show);
    this.hud.classList.toggle('hidden', show);
  }
  get garageOpen(): boolean { return !this.garage.classList.contains('hidden'); }

  setStartEnabled(ok: boolean, label: string): void { this.startBtn.disabled = !ok; this.startBtn.textContent = label; }

  /** Cockpit overlay visibility and steering wheel angle (rad of front-wheel steer). */
  setCockpit(on: boolean, steer: number): void {
    this.cockpit.classList.toggle('hidden', !on);
    if (on) this.wheel.style.transform = `rotate(${(steer * 520) / Math.PI}deg)`;
  }

  setHud(kmh: number, city: string, road: string, cam: string, lights: boolean, loadingText: string): void {
    const s = Math.round(Math.abs(kmh));
    if (s !== this.lastSpeed) { this.speedNum.textContent = String(s); this.lastSpeed = s; }
    if (city !== this.lastCity) { this.city.textContent = city; this.lastCity = city; }
    if (road !== this.lastRoad) { this.road.textContent = road; this.lastRoad = road; }
    if (cam !== this.lastCam) { this.camBtn.textContent = `视角 C：${cam}`; this.lastCam = cam; }
    if (lights !== this.lastLights) { this.lightBtn.textContent = `车灯 L：${lights ? '开' : '关'}`; this.lightBtn.classList.toggle('on', lights); this.lastLights = lights; }
    this.loading.classList.toggle('hidden', !loadingText);
    if (loadingText) this.loading.textContent = loadingText;
  }
}

// Garage / start screen and HUD (plain DOM, no framework). All text goes through i18n;
// switching language rebuilds the garage (keeping the current choices) and relabels the HUD.
import { SPAWNS, type Quality, type SpawnPoint } from '../config';
import { BODY_COLORS, VEHICLES, type CarSpec } from '../car/garage';
import { LANGS, lang, onLangChange, setLang, t } from '../i18n';

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
  private garageBtn = el('button', 'hud-btn');
  private mapBtn = el('button', 'hud-btn');
  private recoverBtn = el('button', 'hud-btn');
  private camBtn = el('button', 'hud-btn');
  private lightBtn = el('button', 'hud-btn');
  private loading = el('div', 'loading hidden');
  private startBtn = el('button', 'go');
  private googleStatus = el('p', 'hint');
  private credits = el('div', 'credits');
  private cockpit = el('div', 'cockpit hidden');
  private wheel = el('div', 'wheel');
  private lastSpeed = -1; private lastCity = ''; private lastRoad = ''; private lastCam = ''; private lastLights: boolean | null = null;
  private startState: { ok: boolean; label: string } = { ok: false, label: '' };
  // current garage choices (kept across language switches)
  private sel: { car: string; color: string; spawn: string; quality: Quality; googleToken: string };

  constructor(root: HTMLElement, private cb: UiCallbacks, initial: { car: string; color: string; spawn: string; quality: Quality; googleToken: string }) {
    this.sel = { ...initial };
    this.startBtn.type = 'button';
    this.startBtn.addEventListener('click', () => cb.onStart());

    const h = this.hud;
    const speed = el('div', 'speed'); speed.append(this.speedNum, el('div', 'unit', 'KM/H'));
    const place = el('div', 'place'); place.append(this.city, this.road);
    const bar = el('div', 'hud-bar');
    const btn = (b: HTMLButtonElement, fn: () => void) => { b.type = 'button'; b.addEventListener('click', () => { b.blur(); fn(); }); bar.append(b); };
    btn(this.garageBtn, cb.onOpenGarage); btn(this.mapBtn, cb.onMap); btn(this.recoverBtn, cb.onRecover);
    btn(this.camBtn, cb.onCycleCamera); btn(this.lightBtn, cb.onToggleLights);
    // cockpit overlay: dashboard + steering wheel (right-hand drive)
    const dash = el('div', 'dash'); this.wheel.append(el('div', 'spoke'), el('div', 'spoke v')); this.cockpit.append(el('div', 'pillar l'), el('div', 'pillar r'), dash, this.wheel);
    h.append(this.cockpit, speed, place, bar, this.loading, this.credits);
    root.append(h, this.garage);

    this.buildGarage();
    this.relabelHud();
    onLangChange(() => { this.buildGarage(); this.relabelHud(); });
  }

  private relabelHud(): void {
    this.garageBtn.textContent = t('hud.garage');
    this.mapBtn.textContent = t('hud.map');
    this.recoverBtn.textContent = t('hud.recover');
    this.lastCam = ''; this.lastLights = null; this.lastRoad = '\u0000'; this.lastCity = '\u0000';
    if (!this.camBtn.textContent) this.camBtn.textContent = t('hud.camera', { cam: t('cam.chase') });
    if (!this.lightBtn.textContent) this.lightBtn.textContent = t('hud.lights', { state: t('hud.off') });
  }

  /** (Re)build the whole garage panel in the current language. */
  private buildGarage(): void {
    const g = this.garage, cb = this.cb, sel = this.sel;
    const scroll = g.scrollTop;
    g.replaceChildren();
    const head = el('div');
    const h1 = el('h1'); h1.append('TOKYO ', el('span', '', 'DRIVE'));
    head.append(h1, el('p', 'sub', t('app.sub')));
    g.append(head);

    const group = <T,>(title: string, items: T[], label: (it: T) => [string, string?], key: (it: T) => string, current: string, pick: (it: T) => void, cls = 'grid') => {
      const box = el('div'); box.append(el('h2', '', title));
      const grid = el('div', cls);
      const btns: HTMLButtonElement[] = [];
      for (const it of items) {
        const b = el('button', 'opt'); b.type = 'button';
        const [main, sub] = label(it);
        b.append(main); if (sub) b.append(el('small', '', sub));
        b.setAttribute('aria-pressed', String(key(it) === current));
        b.addEventListener('click', () => { btns.forEach((o) => o.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); pick(it); b.blur(); });
        btns.push(b); grid.append(b);
      }
      box.append(grid); g.append(box);
    };

    // language first, so it is easy to find whatever the current language is
    group(t('garage.lang'), LANGS, (l) => [l.label], (l) => l.id, lang, (l) => setLang(l.id), 'grid lang');
    group(t('garage.vehicle'), VEHICLES, (c) => [t(`veh.${c.id}`), t(`veh.${c.id}.note`)], (c) => c.id, sel.car, (c) => { sel.car = c.id; cb.onCar(c); });

    const colorBox = el('div'); colorBox.append(el('h2', '', t('garage.color')));
    const sw = el('div', 'swatches');
    const swBtns: HTMLButtonElement[] = [];
    const custom = el('input'); custom.type = 'color'; custom.value = sel.color; custom.setAttribute('aria-label', t('garage.customColor'));
    for (const c of BODY_COLORS) {
      const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', c);
      b.setAttribute('aria-pressed', String(c === sel.color));
      b.addEventListener('click', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); custom.value = c; sel.color = c; cb.onColor(c); b.blur(); });
      swBtns.push(b); sw.append(b);
    }
    custom.addEventListener('input', () => { swBtns.forEach((o) => o.setAttribute('aria-pressed', 'false')); sel.color = custom.value; cb.onColor(custom.value); });
    sw.append(custom); colorBox.append(sw); g.append(colorBox);

    group(t('garage.spawn'), SPAWNS, (s) => [t(`spawn.${s.id}`)], (s) => s.id, sel.spawn, (s) => { sel.spawn = s.id; cb.onSpawn(s); });
    const qs: Quality[] = ['performance', 'balanced', 'ultra'];
    group(t('garage.quality'), qs, (q) => [t(`quality.${q}`), t(`quality.${q}.sub`)], (q) => q, sel.quality, (q) => { sel.quality = q; cb.onQuality(q); });

    // optional Google textures (player's own key; stored only in this browser)
    const gBox = el('div'); gBox.append(el('h2', '', t('google.title')));
    const gRow = el('div', 'token-row');
    const gIn = el('input'); gIn.type = 'password'; gIn.placeholder = t('google.placeholder'); gIn.value = sel.googleToken; gIn.autocomplete = 'off'; gIn.spellcheck = false;
    gIn.setAttribute('aria-label', t('google.placeholder'));
    gIn.addEventListener('input', () => { sel.googleToken = gIn.value; });
    const gBtn = el('button', 'opt', t('google.apply')); gBtn.type = 'button';
    gBtn.addEventListener('click', () => { sel.googleToken = gIn.value; cb.onGoogleToken(gIn.value); gBtn.blur(); });
    gRow.append(gIn, gBtn);
    gBox.append(gRow, this.googleStatus, el('p', 'hint', t('google.hint')));
    g.append(gBox);

    const keys = el('p', 'keys');
    keys.innerHTML = t('keys'); // static, trusted markup from the dictionary
    this.startBtn.textContent = this.startState.ok ? t('start') : t('start.loading');
    g.append(keys, this.startBtn, el('p', 'credit', t('credit')));
    g.scrollTop = scroll;
  }

  setGoogleStatus(text: string): void { if (this.googleStatus.textContent !== text) this.googleStatus.textContent = text; }
  setCredits(text: string): void { if (this.credits.textContent !== text) this.credits.textContent = text; }

  showGarage(show: boolean): void {
    this.garage.classList.toggle('hidden', !show);
    this.hud.classList.toggle('hidden', show);
  }
  get garageOpen(): boolean { return !this.garage.classList.contains('hidden'); }

  setStartEnabled(ok: boolean): void {
    const label = ok ? t('start') : t('start.loading');
    if (this.startState.ok === ok && this.startState.label === label) return;
    this.startState = { ok, label };
    this.startBtn.disabled = !ok; this.startBtn.textContent = label;
  }

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
    if (cam !== this.lastCam) { this.camBtn.textContent = t('hud.camera', { cam }); this.lastCam = cam; }
    if (lights !== this.lastLights) { this.lightBtn.textContent = t('hud.lights', { state: t(lights ? 'hud.on' : 'hud.off') }); this.lightBtn.classList.toggle('on', lights); this.lastLights = lights; }
    this.loading.classList.toggle('hidden', !loadingText);
    if (loadingText) this.loading.textContent = loadingText;
  }
}

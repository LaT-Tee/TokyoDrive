// Engine sound, synthesised with the Web Audio API (no audio files, nothing to license).
//
// Road cars use a physical-style model running in an AudioWorklet:
//   every cylinder firing is one exhaust pressure pulse -> the pulses excite the
//   exhaust system's resonances (two banks for a V engine) -> saturation.
// A pulse train carries its energy at the firing frequency and below it (half-order
// rumble from uneven banks), which is where a real engine's weight comes from.
// Lifting off at high revs lets unburnt fuel ignite in the exhaust: overrun
// crackle and pops. Up-shifts cut the torque for an instant and bang once.
//
// Aircraft keep simple oscillator models: a propeller drone and a rotor chop.
import type { EngineSpec } from '../car/garage';

/** AudioWorklet source (also rendered offline by the headless check). */
export const ENGINE_WORKLET_SRC = `
class TdEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.p = { rpm: 900, load: 0, cyl: 8, redline: 8000, gear: 1, on: 0 };
    this.rpm = 900; this.load = 0; this.gain = 0;
    this.cycle = 0;            // position in the 720 degree engine cycle, 0..1
    this.next = 0;             // index of the next cylinder to fire
    this.e = [0, 0];           // exhaust pulse energy per bank
    this.nz = [0, 0];          // combustion noise envelope per bank
    this.r = [];               // resonators: [y1, y2] per filter
    for (let i = 0; i < 8; i++) this.r.push([0, 0]);
    this.lp = [0, 0, 0]; this.dc = [0, 0]; this.sub = 0; this.env = [0.01, 0.01];
    this.overrun = 0;          // seconds of crackle left after lifting off
    this.popEnv = 0; this.popLow = 0; this.popNoise = 0; this.cut = 0;
    this.seed = 22222;
    this.port.onmessage = (m) => {
      const d = m.data;
      if (d.gear !== undefined && d.gear > this.p.gear && this.p.load > 0.4) { this.cut = 0.07; this.pendingBang = 0.07; } // up-shift under power
      // lift-off at high revs: fuel burns in the hot exhaust for a second or two
      if (d.load < 0.08 && this.p.load >= 0.3 && d.rpm > d.redline * 0.42) this.overrun = 0.9 + 1.6 * Math.min(1, d.rpm / d.redline);
      Object.assign(this.p, d);
    };
  }
  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  // two-pole resonator: rings at f with the given decay time
  res(i, x, f, decay) {
    const w = 2 * Math.PI * f / sampleRate, r = Math.exp(-1 / (decay * sampleRate)), s = this.r[i];
    const y = 2 * r * Math.cos(w) * s[0] - r * r * s[1] + x * (1 - r);
    s[1] = s[0]; s[0] = y; return y;
  }
  pop(size) { this.popEnv = Math.max(this.popEnv, size); this.popLow = Math.max(this.popLow, size); this.e[this.rnd() < 0.5 ? 0 : 1] += size * 1.6; }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], p = this.p, dt = 1 / sampleRate;
    const cyl = p.cyl, v8 = cyl === 8;
    // which exhaust bank each firing feeds: a cross-plane V8 fires L R R L R L L R (uneven
    // per bank -> the burble); inline engines have one manifold, split 3+3 / 2+2 by pairs
    const bank = v8 ? [0, 1, 1, 0, 1, 0, 0, 1] : cyl === 6 ? [0, 1, 0, 1, 0, 1] : [0, 1, 1, 0];
    for (let i = 0; i < L.length; i++) {
      this.rpm += (p.rpm - this.rpm) * 0.0009;
      this.load += (p.load - this.load) * 0.0014;
      this.gain += ((p.on ? 1 : 0) - this.gain) * 0.0004;
      const rev = Math.min(1, this.rpm / p.redline);
      if (this.cut > 0) this.cut -= dt;
      if (this.pendingBang > 0) { this.pendingBang -= dt; if (this.pendingBang <= 0) this.pop(0.9 + rev * 0.5); }
      const torque = this.cut > 0 ? 0.05 : this.load;

      // --- firing: one pressure pulse per cylinder per engine cycle
      this.cycle += (this.rpm / 120) * dt;
      for (;;) {
        if (this.next >= cyl) { if (this.cycle >= 1) { this.cycle -= 1; this.next = 0; } else break; }
        if (this.cycle < this.next / cyl) break;
        const b = bank[this.next];
        // each combustion differs a little; at idle the variation is what makes it lope
        // pulses overlap more as the firing rate rises: keep the summed pressure level steady
        const norm = Math.min(1.25, Math.sqrt(48 / Math.max(8, (this.rpm / 120) * cyl)));
        const a = norm * (0.13 + 0.87 * torque) * (1 - 0.14 * (1 - 0.7 * rev) + 0.28 * (1 - 0.7 * rev) * this.rnd()) * (1 + (1 - rev) * 0.25 * (this.rnd() - 0.5));
        this.e[b] += a; this.nz[b] = Math.max(this.nz[b], a);
        this.next++;
      }

      // --- overrun: irregular crackle, now and then a proper bang
      if (this.overrun > 0) {
        this.overrun -= dt;
        const rate = (4 + 9 * rev) * Math.min(1, this.overrun * 1.4);
        if (this.rnd() < rate * dt) this.pop(this.rnd() < 0.18 ? 0.8 + this.rnd() * 0.6 : 0.2 + this.rnd() * 0.35);
        if (p.load > 0.25) this.overrun = 0;
      }

      // --- exhaust: pulses decay in a few ms and ring the pipes
      const pulseDecay = Math.exp(-dt / (0.0016 + 0.0022 * (1 - rev)));
      let mix = [0, 0];
      for (let b = 0; b < 2; b++) {
        const x = this.e[b]; this.e[b] *= pulseDecay; this.nz[b] *= Math.exp(-dt / 0.004);
        const n = (this.rnd() * 2 - 1) * this.nz[b] * (0.25 + 0.5 * torque);       // combustion roughness
        const o = b * 4, d = b ? 1.07 : 1;                                             // banks are not identical
        const low = this.res(o, x, (v8 ? 92 : cyl === 6 ? 118 : 132) * d, 0.022);     // pipe fundamental: the body
        const mid = this.res(o + 1, x + n, (v8 ? 265 : 340) * d, 0.007);              // muffler / mid-pipe
        const hi = this.res(o + 2, x + n * 2, (900 + rev * 1500) * d, 0.0016);        // rasp, grows with revs
        const tip = this.res(o + 3, x, (48 + 14 * b), 0.05);                          // tailpipe thump
        // the deep pipe modes dominate at low revs and give way to the firing order higher up
        const deep = (1 - rev) * (1 - rev);
        mix[b] = low * (0.7 + 1.2 * deep) + tip * 1.0 * deep + mid * (1.0 + 0.6 * torque) + hi * (0.3 + 1.0 * torque * rev) + x * (0.1 + 0.35 * rev);
      }

      // --- pops: a sharp crack plus a low thud, both short
      this.popNoise = this.popNoise * 0.55 + (this.rnd() * 2 - 1) * 0.45;
      const crack = this.popNoise * this.popEnv; this.popEnv *= Math.exp(-dt / 0.006);
      this.sub += 2 * Math.PI * 58 * dt; const thud = Math.sin(this.sub) * this.popLow; this.popLow *= Math.exp(-dt / 0.045);
      const pops = crack * 1.5 + thud * 1.1;

      // --- intake / induction roar under load
      this.lp[2] += ((this.rnd() * 2 - 1) - this.lp[2]) * (0.03 + 0.1 * rev);
      const intake = this.lp[2] * torque * (0.1 + 0.5 * rev);

      const drive = 1.1 + 1.7 * torque;
      for (let b = 0; b < 2; b++) {
        // cabin sees both banks, each ear favours one
        // remove DC before the saturator (a pulse train has a large mean), then clip softly
        const raw = (mix[b] * 0.75 + mix[1 - b] * 0.45) * 0.2 + intake;
        const ac = raw - this.dc[b] + 0.9985 * this.lp[b]; this.dc[b] = raw; this.lp[b] = ac;
        // slow level control: every engine layout lands at the same loudness for a given
        // throttle, quiet when coasting so the pops stand clear of it
        this.env[b] += (ac * ac - this.env[b]) * 0.00008;
        const want = 0.07 + 0.3 * torque + 0.06 * rev;
        const agc = Math.min(4, want / Math.max(0.02, Math.sqrt(this.env[b])));
        const s = Math.tanh((ac * agc + pops * 0.9) * drive);
        (b ? R : L)[i] = s * this.gain * 0.9;
      }
    }
    return true;
  }
}
registerProcessor('td-engine', TdEngine);
`;

export class EngineSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private worklet: AudioWorkletNode | null = null;
  private osc: OscillatorNode[] = [];
  private oscGain: GainNode[] = [];
  private filter!: BiquadFilterNode;
  private engineGain!: GainNode;      // oscillator models (aircraft)
  private noiseGain!: GainNode;
  private windGain!: GainNode;        // road and wind noise, follows speed
  private noiseFilter!: BiquadFilterNode;
  private chop!: GainNode;            // amplitude modulation for rotor blades
  private chopLfo!: OscillatorNode;
  private chopDepth!: GainNode;
  muted = false;
  volume = 0.6;

  /** Must be called from a user gesture (browsers block audio before one). */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);

    // --- piston engine: exhaust-pulse model in a worklet
    const url = URL.createObjectURL(new Blob([ENGINE_WORKLET_SRC], { type: 'application/javascript' }));
    ctx.audioWorklet.addModule(url).then(() => {
      this.worklet = new AudioWorkletNode(ctx, 'td-engine', { numberOfInputs: 0, outputChannelCount: [2] });
      // a low shelf restores the weight small speakers lose; a gentle top cut removes fizz
      const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 140; shelf.gain.value = 7;
      const top = ctx.createBiquadFilter(); top.type = 'lowpass'; top.frequency.value = 6500;
      this.worklet.connect(shelf).connect(top).connect(this.master);
    }).catch((e) => console.warn('[sound] engine worklet unavailable', e));

    // --- aircraft: oscillator stack through a shaper
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 1.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 511.5) - 1; curve[i] = Math.tanh(x * 2.6); }
    shaper.curve = curve;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
    this.chop = ctx.createGain(); this.chop.gain.value = 1;
    const types: OscillatorType[] = ['sawtooth', 'square', 'sawtooth', 'triangle'];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator(); o.type = types[i]; o.frequency.value = 40;
      const g = ctx.createGain(); g.gain.value = 0;
      o.connect(g).connect(shaper); o.start();
      this.osc.push(o); this.oscGain.push(g);
    }
    shaper.connect(this.filter).connect(this.engineGain).connect(this.chop).connect(this.master);

    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.noiseFilter = ctx.createBiquadFilter(); this.noiseFilter.type = 'bandpass'; this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.chop);
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 700;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    noise.connect(windFilter).connect(this.windGain).connect(this.master);

    this.chopLfo = ctx.createOscillator(); this.chopLfo.type = 'sawtooth'; this.chopLfo.frequency.value = 14;
    this.chopDepth = ctx.createGain(); this.chopDepth.gain.value = 0;
    this.chopLfo.connect(this.chopDepth).connect(this.chop.gain); this.chopLfo.start();
  }

  get running(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  /**
   * @param rpm engine (or rotor) speed   @param load 0..1 throttle
   * @param speed vehicle speed in m/s    @param active false fades everything out (garage, map)
   * @param gear current gear (road cars) so up-shifts can be heard
   */
  update(e: EngineSpec, rpm: number, load: number, speed: number, active: boolean, gear = 1): void {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime, k = 0.05;
    this.master.gain.setTargetAtTime(active && !this.muted ? this.volume : 0, t, 0.12);
    const piston = e.tone === 'piston';
    this.worklet?.port.postMessage({ rpm, load, cyl: e.cylinders, redline: e.redline, gear, on: piston ? 1 : 0 });
    if (piston) {
      this.engineGain.gain.setTargetAtTime(0, t, k); this.noiseGain.gain.setTargetAtTime(0, t, k);
      this.chopDepth.gain.setTargetAtTime(0, t, k);
      // tyre roar and wind build with speed
      this.windGain.gain.setTargetAtTime(Math.min(0.5, (speed / 90) ** 1.6 * 0.5), t, 0.2);
      return;
    }
    if (e.tone === 'heli') {
      // rpm = main rotor speed; two blades pass per revolution
      const blade = (rpm / 60) * 2;
      this.chopLfo.frequency.setTargetAtTime(blade, t, k);
      this.chopDepth.gain.setTargetAtTime(0.75, t, k);
      const whine = 380 + load * 160;
      const f = [blade * 2, blade, whine, whine * 2.01];
      const g = [0.5, 0.6, 0.1 + load * 0.08, 0.05];
      for (let i = 0; i < 4; i++) { this.osc[i].frequency.setTargetAtTime(f[i], t, k); this.oscGain[i].gain.setTargetAtTime(g[i], t, k); }
      this.filter.frequency.setTargetAtTime(1400 + load * 1600, t, k);
      this.engineGain.gain.setTargetAtTime(0.55 + load * 0.3, t, k);
      this.noiseFilter.frequency.setTargetAtTime(500, t, k);
      this.noiseGain.gain.setTargetAtTime(0.5 + load * 0.3, t, k);
      this.windGain.gain.setTargetAtTime(Math.min(0.25, speed * 0.0035), t, 0.2);
      return;
    }
    // propeller aircraft: near-constant RPM drone
    this.chopDepth.gain.setTargetAtTime(0, t, k);
    const fire = (rpm / 60) * (e.cylinders / 2);
    const f = [fire, fire / 2, fire * 2, fire * 3], g = [0.55, 0.35, 0.25, 0.12];
    for (let i = 0; i < 4; i++) { this.osc[i].frequency.setTargetAtTime(f[i], t, k); this.oscGain[i].gain.setTargetAtTime(g[i], t, k); }
    this.filter.frequency.setTargetAtTime(500 + load * 2600, t, k);
    this.engineGain.gain.setTargetAtTime(0.3 + load * 0.5, t, k);
    this.noiseFilter.frequency.setTargetAtTime(900, t, k);
    this.noiseGain.gain.setTargetAtTime(0.25 + load * 0.15, t, k);
    this.windGain.gain.setTargetAtTime(Math.min(0.4, (speed / 90) ** 1.6 * 0.4), t, 0.2);
  }
}

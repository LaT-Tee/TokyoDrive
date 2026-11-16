// Engine sound, synthesised with the Web Audio API (no audio files, nothing to
// license). The pitch is the engine's real firing frequency for the current
// RPM and cylinder count, so gear changes, revving and each engine layout
// sound different; throttle opens the filter and adds intake noise.
//  - piston: road cars (4 / 6 / 8 cylinders)
//  - prop:   piston aircraft at near-constant RPM plus propeller wash
//  - heli:   rotor blade chop over a turbine whine
import type { EngineSpec } from '../car/garage';

export class EngineSound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private osc: OscillatorNode[] = [];
  private oscGain: GainNode[] = [];
  private filter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private noiseGain!: GainNode;       // intake / exhaust rasp, follows throttle
  private windGain!: GainNode;        // road and wind noise, follows speed
  private noiseFilter!: BiquadFilterNode;
  private chop!: GainNode;            // amplitude modulation for rotor blades
  private chopLfo!: OscillatorNode;
  private chopDepth!: GainNode;
  muted = false;
  volume = 0.5;

  /** Must be called from a user gesture (browsers block audio before one). */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // harmonic stack: fundamental (firing frequency), half order (uneven exhaust pulses), 2nd, 3rd
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

    // one noise source feeds both the intake rasp and the wind
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
    this.noiseFilter = ctx.createBiquadFilter(); this.noiseFilter.type = 'bandpass'; this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain(); this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.chop);
    const windFilter = ctx.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 900;
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
   */
  update(e: EngineSpec, rpm: number, load: number, speed: number, active: boolean): void {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime, k = 0.05;
    this.master.gain.setTargetAtTime(active && !this.muted ? this.volume : 0, t, 0.12);
    const rev = Math.max(0, Math.min(1, (rpm - e.idle) / Math.max(1, e.redline - e.idle)));
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
    this.chopDepth.gain.setTargetAtTime(0, t, k);
    // four-stroke firing frequency: each cylinder fires once every two revolutions
    const fire = (rpm / 60) * (e.cylinders / 2);
    const prop = e.tone === 'prop';
    const f = [fire, fire / 2, fire * 2, fire * (e.cylinders >= 8 ? 1.5 : 3)];
    const g = prop
      ? [0.55, 0.35, 0.25, 0.12]
      : [0.5, e.cylinders === 8 ? 0.42 : 0.2, 0.22 + rev * 0.2, 0.08 + rev * 0.16];
    for (let i = 0; i < 4; i++) { this.osc[i].frequency.setTargetAtTime(f[i], t, k); this.oscGain[i].gain.setTargetAtTime(g[i], t, k); }
    // closed throttle = muffled; open throttle and high revs = bright
    this.filter.frequency.setTargetAtTime(260 + rev * 2200 + load * (900 + rev * 2600), t, k);
    this.engineGain.gain.setTargetAtTime(0.22 + load * 0.5 + rev * 0.18, t, k);
    this.noiseFilter.frequency.setTargetAtTime(700 + rev * 2600, t, k);
    this.noiseGain.gain.setTargetAtTime((prop ? 0.25 : 0.04) + load * (0.08 + rev * 0.16), t, k);
    this.windGain.gain.setTargetAtTime(Math.min(0.5, (speed / 90) ** 1.6 * 0.5), t, 0.2);
  }
}

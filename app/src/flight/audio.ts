/**
 * The ship's soundscape. Space is silent, so this is a sonification: the ship's computer
 * turning what it receives and feels into sound. Every voice follows a physical quantity:
 *
 *  - pad:        a slow ambient chord, brightening with how much light is in view
 *  - light hum:  pitched by the frequency shift g of the light at the centre of the view
 *  - heartbeat:  once per second of *your* proper time
 *  - home chime: home's clock ticks as they reach you: as many per heartbeat as the shift of
 *                home's signal (racing when you hover low, slowing as you fall in)
 *  - engines:    rumble growing with the acceleration you feel (silence in free fall)
 *  - creaks:     hull strain growing with the real tidal stretching across the ship
 *  - pings:      a beacon's blink, when its light actually arrives, pitched by its shift
 *
 * Built entirely from oscillators and noise with the Web Audio API: no sound files.
 */

export interface AmbienceInput {
  /** Simulation running (not paused). */
  running: boolean;
  /** Frequency shift and kind of the light at the centre of the view. */
  viewG: number;
  viewKind: string;
  /** How much light is in view, 0..1. */
  brightness: number;
  /** Acceleration felt on board (g). */
  feltG: number;
  /** Tidal stretching across the ship (g). */
  tidalG: number;
  /** Rate at which home's clock ticks reach you, per tick of yours (its signal's frequency shift). */
  timeRate: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class Ambience {
  enabled = true;
  volume = 0.6;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private reverb!: GainNode;
  private hum: OscillatorNode[] = [];
  private humGain!: GainNode;
  private padFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private heartPhase = 0;
  private homePhase = 0;

  /** Browsers only allow audio after a user gesture: call this from one. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const out = ctx.createDynamicsCompressor();
    out.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.master.connect(out);

    // A long, dark reverb: exponentially decaying noise, slightly different per ear.
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 5);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    conv.buffer = ir;
    this.reverb = ctx.createGain();
    this.reverb.gain.value = 0.9;
    this.reverb.connect(conv).connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    // Pad: an open A chord, slowly breathing through a low-pass filter.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 400;
    this.padFilter.Q.value = 0.7;
    const padGain = ctx.createGain();
    padGain.gain.value = 0.05;
    this.padFilter.connect(padGain);
    padGain.connect(this.master);
    padGain.connect(this.reverb);
    for (const [f, type] of [[55, 'sine'], [82.41, 'triangle'], [110, 'sine'], [164.81, 'triangle'], [277.18, 'sine']] as const) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(this.padFilter);
        o.start();
      }
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();

    // Light hum: two slightly detuned sines an octave apart.
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;
    this.humGain.connect(this.master);
    this.humGain.connect(this.reverb);
    for (const [mult, level] of [[1, 1], [2.004, 0.35]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 55 * mult;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(this.humGain);
      o.start();
      this.hum.push(o);
    }

    // Engines: filtered noise.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 80;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    src.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    src.start();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.applyVolume();
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyVolume();
  }

  private applyVolume() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.1);
  }

  update(s: AmbienceInput, dtReal: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;

    // Light hum follows the light's frequency shift, as pitch ∝ √g (one octave of pitch per two
    // of frequency shift, so extreme shifts stay audible); quiet when looking into the dark.
    const f = clamp(55 * Math.sqrt(Math.max(s.viewG, 1e-3)), 22, 440);
    this.hum[0].frequency.setTargetAtTime(f, t, 0.4);
    this.hum[1].frequency.setTargetAtTime(f * 2.004, t, 0.4);
    const lit = s.viewKind === 'hole' || s.viewKind === 'lost' ? 0.15 : 1;
    this.humGain.gain.setTargetAtTime(0.09 * lit * (0.3 + 0.7 * s.brightness), t, 0.5);
    this.padFilter.frequency.setTargetAtTime(220 + 1800 * s.brightness, t, 1.5);

    // Engines.
    const thrust = Math.log10(1 + s.feltG);
    this.engineGain.gain.setTargetAtTime(clamp(0.08 * thrust, 0, 0.35), t, 0.15);
    this.engineFilter.frequency.setTargetAtTime(60 + 60 * thrust, t, 0.2);

    if (!s.running) return;
    // Your heartbeat: one beat per second of your own time…
    this.heartPhase += dtReal;
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      this.thump();
    }
    // …and home's clock, as its ticks actually arrive (capped so it stays a sound).
    this.homePhase += dtReal * clamp(s.timeRate, 0, 12);
    if (this.homePhase >= 1) {
      this.homePhase -= Math.floor(this.homePhase);
      this.chime();
    }
    // Hull strain: creaks once tides reach ~a tenth of a g, more and louder as they grow.
    if (s.tidalG > 0.1) {
      const strain = clamp(Math.log10(s.tidalG / 0.1) / 6, 0, 1);
      if (Math.random() < dtReal * (0.3 + 6 * strain)) this.creak(strain);
    }
  }

  /** A beacon's blink arriving: pitched by its frequency shift g, louder when blueshifted. */
  ping(g: number, loudness: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const f = clamp(660 * Math.sqrt(g), 60, 3200);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(clamp(0.18 * loudness, 0.004, 0.25), t + 0.005);
    env.gain.exponentialRampToValueAtTime(1e-4, t + 2.5);
    env.connect(this.master);
    env.connect(this.reverb);
    for (const [mult, level] of [[1, 1], [2.76, 0.3], [5.4, 0.12]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * mult;
      const g2 = ctx.createGain();
      g2.gain.value = level;
      o.connect(g2).connect(env);
      o.start(t);
      o.stop(t + 2.6);
    }
  }

  private thump() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(72, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.012);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.32);
  }

  private chime() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.004);
    g.gain.exponentialRampToValueAtTime(1e-4, t + 0.7);
    g.connect(this.master);
    g.connect(this.reverb);
    for (const f of [1318.5, 1975.5]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(t);
      o.stop(t + 0.75);
    }
  }

  private creak(strain: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 140 + Math.random() * 500 * (1 - 0.5 * strain);
    bp.Q.value = 14;
    const g = ctx.createGain();
    const dur = 0.2 + Math.random() * 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25 + 0.9 * strain, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(1e-4, t + dur);
    src.connect(bp).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    src.start(t, Math.random(), dur);
  }
}

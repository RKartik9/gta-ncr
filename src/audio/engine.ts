// Engine sound made from scratch: individual cylinder firings rendered into short loops at two engine speeds and
// crossfaded between, rather than one recording pitched up until it sounds like a toy. After the combustion synth
// in mrdoob's slop-newyork (https://github.com/mrdoob/slop-newyork, MIT, © mrdoob).

const random = (seed: number) => {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
};

/** Zero mean, then scaled to an RMS level without letting the peak past `ceiling`. */
function normalise(buffer: AudioBuffer, rms: number, ceiling = 0.9) {
  const d = buffer.getChannelData(0);
  let mean = 0;
  for (const v of d) mean += v;
  mean /= d.length;
  let energy = 0, peak = 0;
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean;
    energy += d[i] * d[i];
    peak = Math.max(peak, Math.abs(d[i]));
  }
  const k = Math.min(ceiling / Math.max(peak, 1e-4), rms / Math.max(Math.sqrt(energy / d.length), 1e-4));
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return buffer;
}

export interface Bank {
  low: AudioBuffer;
  high: AudioBuffer;
  /** valve and injector clatter */
  mech: AudioBuffer;
  lowRpm: number;
  highRpm: number;
}

/**
 * Twenty four-stroke cycles of `cylinders` firings, each a sharp pressure pulse plus the exhaust's ring. Every
 * cylinder is a little stronger or later than the next, as a real one is: that unevenness is the engine's voice.
 * The pulse keeps its length in seconds whatever the speed, so the high bank is made at its own speed.
 */
function makeBank(ctx: BaseAudioContext, cylinders: number, diesel: boolean, seed: number): Bank {
  const rate = ctx.sampleRate, cycles = 20, lowRpm = 1200, highRpm = diesel ? 2400 : 3600;
  const mech = ctx.createBuffer(1, Math.round((cycles * 120 / lowRpm) * rate), rate);
  const r = random(seed);
  const strength = Array.from({ length: cylinders }, () => 0.83 + r() * 0.34);
  const late = Array.from({ length: cylinders }, () => (r() - 0.5) * 0.035);
  // big engines ring low; a single-cylinder auto-rickshaw rattles higher
  const ring = (diesel ? 93 : cylinders >= 8 ? 105 : cylinders === 6 ? 118 : cylinders === 1 ? 190 : 145) * (0.97 + r() * 0.06);
  const duration = Math.round(rate * (diesel ? 0.062 : cylinders === 1 ? 0.07 : 0.048));

  const exhaust = (rpm: number, clatter?: Float32Array) => {
    const length = Math.round((cycles * 120 / rpm) * rate);
    const buffer = ctx.createBuffer(1, length, rate);
    const p = buffer.getChannelData(0);
    const interval = length / (cycles * cylinders);
    // the same timing in both banks, so crossfading between them does not smear the beat
    const timing = random(seed), noise = random(seed ^ 0x65786861);
    for (let f = 0; f < cycles * cylinders; f++) {
      const c = f % cylinders;
      let i = (Math.round((f + late[c] + (timing() - 0.5) * 0.012) * interval) + length) % length;
      const s = strength[c] * (0.92 + timing() * 0.16);
      const decay = (diesel ? 0.019 : 0.012) * (0.95 + timing() * 0.1);
      let low = 0;
      for (let k = 0; k < duration; k++) {
        const t = k / rate;
        const white = noise() * 2 - 1;
        low += (white - low) * 0.16;
        const attack = 1 - Math.exp(-t / 0.00065);
        const tail = Math.exp(-t / decay);
        const release = Math.exp(-t / 0.0022) - 0.36 * Math.exp(-t / 0.009);
        p[i] += s * attack * (release + Math.sin(2 * Math.PI * ring * t) * tail * 0.34 + low * tail * (diesel ? 0.5 : 0.28));
        if (clatter) {
          const vt = Math.max(0, t - 0.009);
          const valve = t > 0.009 ? Math.exp(-vt / 0.0016) * (white * 0.65 + Math.sin(vt * 14900) * 0.12) : 0;
          clatter[i] += s * (white * attack * Math.exp(-t / (diesel ? 0.0036 : 0.0022)) + valve * 0.35);
        }
        if (++i === length) i = 0;
      }
    }
    return normalise(buffer, 0.3);
  };
  return { low: exhaust(lowRpm, mech.getChannelData(0)), high: exhaust(highRpm), mech: normalise(mech, diesel ? 0.22 : 0.18, 0.85), lowRpm, highRpm };
}

const banks = new Map<string, Bank>();
/** Banks take a few milliseconds each to render, so each kind of engine is made once. */
export function bank(ctx: BaseAudioContext, cylinders: number, diesel = false) {
  const key = `${cylinders}${diesel ? 'd' : ''}`;
  let b = banks.get(key);
  if (!b) banks.set(key, (b = makeBank(ctx, cylinders, diesel, 0x6d6f746f + cylinders * 7919 + (diesel ? 1 : 0))));
  return b;
}

let serial = 0;

/**
 * One running engine. Its output is mono: connect it to the mix directly, or through a panner to place it.
 * Call set() as often as the game updates.
 */
export class EngineVoice {
  readonly out: GainNode;
  private srcs: AudioBufferSourceNode[];
  private lowGain: GainNode;
  private highGain: GainNode;
  private mechGain: GainNode;
  private filter: BiquadFilterNode;
  private mechFilter: BiquadFilterNode;
  private ctx: AudioContext;
  private b: Bank;

  constructor(ctx: AudioContext, b: Bank, destination: AudioNode) {
    this.ctx = ctx;
    this.b = b;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 0.65;
    this.mechFilter = ctx.createBiquadFilter();
    this.mechFilter.type = 'bandpass';
    this.mechFilter.Q.value = 0.45;
    this.lowGain = ctx.createGain();
    this.highGain = ctx.createGain();
    this.mechGain = ctx.createGain();
    // engines of one kind start at different points of their loops, so two side by side never beat in phase
    const offset = (serial++ * 0.618) % 1;
    this.srcs = [b.low, b.high, b.mech].map((buffer, i) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.connect(i === 0 ? this.lowGain : i === 1 ? this.highGain : this.mechGain);
      s.start(0, offset * buffer.duration);
      return s;
    });
    this.lowGain.connect(this.filter);
    this.highGain.connect(this.filter);
    this.filter.connect(this.out);
    this.mechGain.connect(this.mechFilter).connect(this.out);
    this.out.connect(destination);
  }

  /**
   * `rpm`, `effort` 0..1 (how hard it is working: throttle and load), `pitch` a multiplier for the car's own
   * note and for Doppler, `level` the overall gain. `lag` is the smoothing in seconds.
   */
  set(rpm: number, effort: number, pitch: number, level: number, lag = 0.04) {
    const t = this.ctx.currentTime, b = this.b;
    // equal-power crossfade between the banks over the rev range
    const x = Math.min(1, Math.max(0, (rpm - b.lowRpm) / (b.highRpm - b.lowRpm)));
    const blend = x * x * (3 - 2 * x);
    this.srcs[0].playbackRate.setTargetAtTime((rpm / b.lowRpm) * pitch, t, lag);
    this.srcs[1].playbackRate.setTargetAtTime((rpm / b.highRpm) * pitch, t, lag);
    this.srcs[2].playbackRate.setTargetAtTime((rpm / b.lowRpm) * pitch, t, lag);
    this.lowGain.gain.setTargetAtTime(Math.cos(blend * Math.PI / 2), t, lag);
    this.highGain.gain.setTargetAtTime(Math.sin(blend * Math.PI / 2), t, lag);
    // on the throttle the exhaust opens up and gets louder; off it, it goes dull
    this.filter.frequency.setTargetAtTime((650 + rpm * 0.24 + effort * 1800) * pitch, t, lag);
    this.mechFilter.frequency.setTargetAtTime(1250 + rpm * 0.12, t, lag);
    this.mechGain.gain.setTargetAtTime(0.05 + effort * 0.05, t, lag);
    this.out.gain.setTargetAtTime(level * (0.45 + effort * 0.55), t, lag);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    for (const s of this.srcs) s.stop(t + 0.2);
    setTimeout(() => this.out.disconnect(), 300);
  }
}

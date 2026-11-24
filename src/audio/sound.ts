import type { CarSpec } from '../vehicle/cars.ts';
import { clamp, damp, store, stored } from '../util.ts';

/** Where each gear tops out, as a share of the car's top speed. */
const GEARS = [0.17, 0.3, 0.45, 0.61, 0.79, 1];
const IDLE = 850, REDLINE = 7200;
/** the engine recording's playback rate at idle and at the redline; past ~2.6x a real engine starts to sound like a toy */
const RATE_IDLE = 0.85, RATE_TOP = 2.6;
/** horn.wav: the press, then the held note from here to the end loops for as long as the horn is held */
const HORN_LOOP = 0.4;
const VOLUME_KEY = 'delhi-drive:sfx-volume';
const FILES = ['engine.wav', 'skid.wav', 'horn.wav', 'crash-1.mp3', 'crash-2.mp3', 'crash-3.mp3'] as const;
type Clip = (typeof FILES)[number];

/**
 * Game sounds from real recordings (public/sounds, credits in CREDITS.txt): the engine loop pitched with the revs,
 * a tyre squeal, a held horn and three crashes picked by how hard the hit was. Wind is filtered noise.
 * The browser only allows sound after a click or key press, so nothing starts until the first one.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private clips = new Map<Clip, AudioBuffer>();
  private engine: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private skid: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wind!: { filter: BiquadFilterNode; gain: GainNode };
  private horn: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private hornOn = false;
  /** the street's horns: none before this time */
  private npcHornFree = 0;
  private paused = false;
  private rpm = IDLE;
  private gear = 0;
  private crashCooldown = 0;
  private pitch = 1;
  private topSpeed = 60;
  volume = stored(VOLUME_KEY, 0.8);

  constructor() {
    const start = () => {
      this.start();
      removeEventListener('keydown', start);
      removeEventListener('pointerdown', start);
    };
    addEventListener('keydown', start);
    addEventListener('pointerdown', start);
    // nothing to hear in a background tab
    document.addEventListener('visibilitychange', () => void (document.hidden ? this.ctx?.suspend() : this.ctx?.resume()));
  }

  setCar(spec: CarSpec) {
    this.pitch = spec.enginePitch;
    this.topSpeed = spec.topSpeed;
  }

  setVolume(v: number) {
    this.volume = v;
    store(VOLUME_KEY, v);
    this.applyBus();
  }

  /** The Esc menu and the map silence the car (music carries on). */
  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    this.applyBus();
  }

  private applyBus() {
    if (this.ctx) this.bus.gain.setTargetAtTime(this.paused ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  private start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    const comp = ctx.createDynamicsCompressor(); // keeps a crash on top of a revving engine from clipping
    comp.connect(ctx.destination);
    this.bus = ctx.createGain();
    this.bus.gain.value = this.paused ? 0 : this.volume;
    this.bus.connect(comp);

    // wind and tyre roar: broadband noise is what these really are
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.wind = this.noiseLoop(noise);

    for (const name of FILES) {
      fetch(`${import.meta.env.BASE_URL}sounds/${name}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => {
          this.clips.set(name, buf);
          if (name === 'engine.wav') this.startEngine(buf);
          if (name === 'skid.wav') this.skid = this.loop(buf);
        })
        .catch((err) => console.warn(`sound ${name} failed to load`, err));
    }
  }

  private noiseLoop(buffer: AudioBuffer) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.bus);
    src.start();
    return { filter, gain };
  }

  private loop(buffer: AudioBuffer) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.bus);
    src.start();
    return { src, gain };
  }

  private startEngine(buffer: AudioBuffer) {
    const ctx = this.ctx!;
    const { src, gain } = this.loop(buffer);
    src.disconnect();
    // off the throttle the exhaust note goes dull; on it, the full bark comes through
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    src.connect(filter).connect(gain);
    this.engine = { src, filter, gain };
  }

  /** Held horn: the press, then the steady note for as long as the button is down. */
  setHorn(on: boolean) {
    const buf = this.clips.get('horn.wav');
    if (!this.ctx || !buf || on === this.hornOn) return;
    this.hornOn = on;
    const t = this.ctx.currentTime;
    if (on) {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = HORN_LOOP;
      src.loopEnd = buf.duration;
      const gain = this.ctx.createGain();
      gain.gain.value = 0.9;
      src.connect(gain).connect(this.bus);
      src.start(t);
      this.horn = { src, gain };
    } else if (this.horn) {
      // a real horn stops almost at once, but not with a click
      this.horn.gain.gain.setTargetAtTime(0, t, 0.02);
      this.horn.src.stop(t + 0.15);
      this.horn = null;
    }
  }

  /**
   * Once a frame. `speed` m/s along the nose, `wheels` m/s the driven wheels are turning at (more than the
   * car's speed when they spin), `throttle` -1..1, `skid` 0..1 how hard the tyres are sliding.
   */
  update(dt: number, speed: number, wheels: number, throttle: number, skid: number) {
    this.crashCooldown -= dt;
    if (!this.ctx || this.paused) return;
    const t = this.ctx.currentTime;
    const road = Math.abs(speed);
    // the engine turns with the wheels: spin them and the revs climb though the car has hardly moved
    const v = Math.max(road, Math.abs(wheels));
    const gas = Math.max(0, speed < -0.5 ? -throttle : throttle);

    // Automatic box: shift up near the top of a gear, down well below it, so it does not hunt.
    const top = (g: number) => GEARS[g] * this.topSpeed;
    if (this.gear < GEARS.length - 1 && v > top(this.gear) * 0.97) this.gear++;
    else if (this.gear > 0 && v < top(this.gear - 1) * 0.8) this.gear--;
    let want = (v / top(this.gear)) * REDLINE;
    if (v < 3) want = Math.max(want, IDLE + gas * 2600); // revving when pulling away or standing still
    want = clamp(want, IDLE, REDLINE);
    this.rpm += (want - this.rpm) * damp(want < this.rpm ? 7 : 12, dt);
    const r = (this.rpm - IDLE) / (REDLINE - IDLE);

    const e = this.engine;
    if (e) {
      e.src.playbackRate.setTargetAtTime(this.pitch * (RATE_IDLE + (RATE_TOP - RATE_IDLE) * r), t, 0.03);
      e.filter.frequency.setTargetAtTime(700 + gas * 5000 + r * 2500, t, 0.06);
      e.gain.gain.setTargetAtTime(0.32 + 0.3 * gas + 0.2 * r, t, 0.06);
    }

    this.wind.gain.gain.setTargetAtTime(Math.min(0.12, road * 0.0025), t, 0.15);
    this.wind.filter.frequency.setTargetAtTime(250 + road * 12, t, 0.15);

    // squeal whenever a tyre is sliding: a locked or spinning wheel, a drift
    if (this.skid) {
      this.skid.gain.gain.setTargetAtTime(Math.min(0.9, skid * 1.2), t, 0.06);
      this.skid.src.playbackRate.setTargetAtTime(0.9 + Math.min(0.2, v / 250), t, 0.1);
    }
  }

  /**
   * Another driver's horn, `distance` metres away: a tap, two taps, or a long blast. Played from the steady note
   * (the clip's press is a thump that, cut short, sounded like a bark), shaped so it starts and stops cleanly,
   * and muffled with distance as a real one is. One at a time across the street, so it never turns into a chorus.
   */
  honk(distance: number, kind: 'tap' | 'double' | 'long', pitch: number) {
    const buf = this.clips.get('horn.wav');
    if (!this.ctx || !buf || distance > 150) return;
    const t = this.ctx.currentTime;
    if (t < this.npcHornFree) return;
    const notes = kind === 'tap' ? [[0, 0.22]] : kind === 'double' ? [[0, 0.16], [0.28, 0.2]] : [[0, 1 + Math.random() * 0.5]];
    const end = notes[notes.length - 1][0] + notes[notes.length - 1][1];
    this.npcHornFree = t + end + 1.2;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = HORN_LOOP;
    src.loopEnd = buf.duration;
    src.playbackRate.value = pitch;
    const muffle = this.ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = 9000 / (1 + distance / 30);
    const gain = this.ctx.createGain();
    const level = 0.5 / (1 + distance / 15);
    gain.gain.setValueAtTime(0, t);
    for (const [at, length] of notes) {
      gain.gain.setTargetAtTime(level, t + at, 0.008);
      gain.gain.setTargetAtTime(0, t + at + length, 0.015);
    }
    src.connect(muffle).connect(gain).connect(this.bus);
    src.start(t, HORN_LOOP);
    src.stop(t + end + 0.1);
  }

  /** A hit: `strength` is the speed lost, m/s. Light knocks clank; hard ones crunch, the hardest break glass. */
  crash(strength: number) {
    if (!this.ctx || this.crashCooldown > 0) return;
    const clip: Clip = strength < 5 ? 'crash-1.mp3' : strength < 10 ? 'crash-2.mp3' : 'crash-3.mp3';
    const buf = this.clips.get(clip);
    if (!buf) return;
    this.crashCooldown = 0.3;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16; // no two hits quite the same
    const gain = this.ctx.createGain();
    gain.gain.value = clamp(strength / 10, 0.35, 1.2);
    src.connect(gain).connect(this.bus);
    src.start();
  }
}

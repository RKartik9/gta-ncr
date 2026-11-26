import type { CarSpec } from '../vehicle/cars.ts';
import { clamp, damp, store, stored } from '../util.ts';
import type { Thump } from '../character/combat.ts';
import { EngineVoice, bank } from './engine.ts';

/** Where each gear tops out, as a share of the car's top speed. */
const GEARS = [0.17, 0.3, 0.45, 0.61, 0.79, 1];
const IDLE = 850;
/** how long the throttle is cut while the gearbox changes up: what makes a shift heard */
const SHIFT_CUT = 0.16;
/** other drivers' engines heard at once, nearest first; more is mush and costs */
const NPC_VOICES = 6;
const NPC_RANGE = 70;
/** how many other drivers' horns can sound together */
const NPC_HORNS = 3;
/** horn.wav: the press, then the held note from here to the end loops for as long as the horn is held */
const HORN_LOOP = 0.4;
const VOLUME_KEY = 'delhi-drive:sfx-volume';
const FILES = ['skid.wav', 'horn.wav', 'crash-1.mp3', 'crash-2.mp3', 'crash-3.mp3'] as const;
type Clip = (typeof FILES)[number];
const numbered = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}-${i + 1}`);
/**
 * The recordings of the rifles and of people's voices (public/sounds/guns and voices, credits in CREDITS.txt):
 * for each sound, the takes of it there are, one picked each time so that no two in a row are the same.
 */
const TAKES: Record<string, string[]> = {
  m416: ['guns/m416-shot'],
  akm: ['guns/akm-shot'],
  'reload-m416': ['guns/m416-reload'],
  'reload-akm': ['guns/akm-reload'],
  click: ['guns/dry'],
  draw: ['guns/draw'],
  hit: numbered('guns/flesh', 5),
  headshot: ['guns/headshot'],
  ricochet: numbered('guns/ricochet', 6),
  'man-grunt': numbered('voices/man-grunt', 2),
  'man-pain': numbered('voices/man-hurt', 5),
  'man-death': numbered('voices/man-death', 3),
  'man-scream': ['voices/man-scream-1', 'voices/man-death-1'],
  'woman-grunt': ['voices/woman-grunt-1'],
  'woman-pain': ['voices/woman-hurt-1', 'voices/woman-grunt-1'],
  'woman-death': ['voices/woman-scream-3', 'voices/woman-hurt-1'],
  'woman-scream': numbered('voices/woman-scream', 3),
};
/** how high a voice (combat.ts's `voiceOf`) has to be to be a woman's, and how high hers are on average */
const WOMAN = 1.4, WOMAN_PITCH = 1.75;

/**
 * Game sounds. Engines, the player's and the nearest traffic's, are synthesised (engine.ts); the rest are real
 * recordings (public/sounds, credits in CREDITS.txt): a tyre squeal, a held horn, three crashes picked by how
 * hard the hit was, the rifles, and the voices of people hurt and frightened. Wind and the city's distant rumble are filtered noise. Other cars and horns are placed
 * around the listener (the camera), with Doppler as they pass.
 * The browser only allows sound after a click or key press, so nothing starts until the first one.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private bus!: GainNode;
  private clips = new Map<Clip, AudioBuffer>();
  /** the takes of each recorded sound that have loaded, and which was played last */
  private takes = new Map<string, AudioBuffer[]>();
  private lastTake = new Map<string, AudioBuffer>();
  /** when the last scream started: a street running from gunfire is a few voices, not a choir */
  private screamed = -9;
  private engine: EngineVoice | null = null;
  private cylinders = 4;
  private diesel = false;
  private redline = 7200;
  private shiftCut = 0;
  /** other drivers' engines by car id, each placed by its own panner */
  private npcs = new Map<number, { voice: EngineVoice; panner: PannerNode; kind: string; speed: number; effort: number; gear: number }>();
  private rumble!: { filter: BiquadFilterNode; gain: GainNode };
  private ear = { x: 0, y: 0, z: 0, vx: 0, vz: 0 };
  private skid: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wind!: { filter: BiquadFilterNode; gain: GainNode };
  private noise: AudioBuffer | null = null;
  private horn: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private hornOn = false;
  /** when each of the street's horns now sounding stops */
  private npcHorns: number[] = [];
  private paused = false;
  private rpm = IDLE;
  private gear = 0;
  private lastGear = 0;
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
    this.cylinders = spec.cylinders ?? 4;
    this.diesel = !!spec.diesel;
    this.redline = this.diesel ? 4600 : 7200;
    if (this.ctx) this.startEngine();
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
    // the city past the next block: traffic heard as a low roar more than as cars
    this.rumble = this.noiseLoop(noise);
    this.rumble.filter.frequency.value = 220;
    this.noise = noise;
    this.startEngine();
    // the traffic's engines (an auto's single, a car's four, a bus's diesel), made one at a time in spare moments
    // now rather than in the middle of a frame the first time one drives up
    const later = (fn: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(fn) : setTimeout(fn, 50));
    for (const [cyl, diesel] of [[1, false], [4, false], [6, true]] as const) later(() => bank(ctx, cyl, diesel));

    for (const name of FILES) {
      fetch(`${import.meta.env.BASE_URL}sounds/${name}`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => {
          this.clips.set(name, buf);
          if (name === 'skid.wav') this.skid = this.loop(buf);
        })
        .catch((err) => console.warn(`sound ${name} failed to load`, err));
    }
    const files = new Map<string, Promise<AudioBuffer | null>>();
    for (const [sound, names] of Object.entries(TAKES)) {
      for (const name of names) {
        let file = files.get(name);
        if (!file) files.set(name, (file = fetch(`${import.meta.env.BASE_URL}sounds/${name}.mp3`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((b) => ctx.decodeAudioData(b))
          .catch((err) => (console.warn(`sound ${name} failed to load`, err), null))));
        void file.then((buf) => buf && this.takes.set(sound, [...(this.takes.get(sound) ?? []), buf]));
      }
    }
  }

  /**
   * One of the recordings of `kind`, into `out`: false if there is none (not loaded yet, or never recorded), and
   * the sound is then made up instead. Voices are a man's or a woman's by how high `voice` is, and each person's
   * is played a little faster or slower than the next's.
   */
  private take(kind: Thump, strength: number, voice: number, out: GainNode) {
    const ctx = this.ctx!, t = ctx.currentTime;
    let name: string = kind, level = 1, rate = 0.96 + Math.random() * 0.08, wait = 0;
    switch (kind) {
      case 'grunt': case 'pain': case 'death': case 'scream': {
        const woman = voice > WOMAN;
        name = `${woman ? 'woman' : 'man'}-${kind}`;
        rate = clamp(woman ? voice / WOMAN_PITCH : voice, 0.85, 1.2);
        level = kind === 'grunt' ? 0.4 * clamp(strength, 0.5, 1.3) : kind === 'pain' ? 0.75 * clamp(strength, 0.7, 1.2) : 0.9;
        if (kind === 'scream') {
          if (t - this.screamed < 0.35) return true;
          this.screamed = t;
        }
        break;
      }
      case 'hit':
        if (strength > 1.2) name = 'headshot';
        level = 0.85;
        break;
      case 'ricochet': level = 0.5; rate = 0.85 + Math.random() * 0.3; break;
      case 'click': level = 0.7; break;
      case 'draw': level = 0.6; break;
      // the recordings are not the length the reloads are: each is played at the speed that fits
      case 'reload-m416': level = 0.8; rate = 1.15; break;
      case 'reload-akm': level = 0.8; rate = 0.9; wait = 0.25; break;
      case 'm416': case 'akm': rate = 0.97 + Math.random() * 0.06; break;
      default: return false;
    }
    const takes = this.takes.get(name);
    if (!takes?.length) return false;
    let buf = takes[Math.floor(Math.random() * takes.length)];
    if (takes.length > 1 && buf === this.lastTake.get(name)) buf = takes[(takes.indexOf(buf) + 1) % takes.length];
    this.lastTake.set(name, buf);
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    gain.gain.value = level;
    src.connect(gain).connect(out);
    src.start(t + wait);
    return true;
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

  private startEngine() {
    this.engine?.stop();
    this.engine = new EngineVoice(this.ctx!, bank(this.ctx!, this.cylinders, this.diesel), this.bus);
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
   * car's speed when they spin), `throttle` -1..1, `skid` 0..1 how hard the tyres are sliding. `away` is how far
   * the player has walked from the car, metres: its engine is heard from there.
   */
  update(dt: number, speed: number, wheels: number, throttle: number, skid: number, away = 0) {
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
    if (this.gear > this.lastGear) this.shiftCut = SHIFT_CUT;
    this.lastGear = this.gear;
    this.shiftCut -= dt;
    let want = (v / top(this.gear)) * this.redline;
    if (v < 3) want = Math.max(want, IDLE + gas * 2600); // revving when pulling away or standing still
    want = clamp(want, IDLE, this.redline);
    // the revs drop fast on a shift, as the clutch lets the engine fall to the next gear's speed
    this.rpm += (want - this.rpm) * damp(want < this.rpm ? (this.shiftCut > 0 ? 22 : 7) : 12, dt);
    // load: the throttle, and some just to keep a car rolling at speed; the gearbox cuts it while it shifts
    const effort = this.shiftCut > 0 ? 0.1 : Math.min(1, gas + road * 0.005);
    this.engine?.set(this.rpm, effort, this.pitch, 0.55 / (1 + (away / 7) ** 2), this.shiftCut > 0 ? 0.012 : 0.04);

    this.wind.gain.gain.setTargetAtTime(Math.min(0.12, road * 0.0025), t, 0.15);
    this.wind.filter.frequency.setTargetAtTime(250 + road * 12, t, 0.15);

    // squeal whenever a tyre is sliding: a locked or spinning wheel, a drift
    if (this.skid) {
      this.skid.gain.gain.setTargetAtTime(Math.min(0.9, skid * 1.2), t, 0.06);
      this.skid.src.playbackRate.setTargetAtTime(0.9 + Math.min(0.2, v / 250), t, 0.1);
    }
  }

  /** A panner at (x, z): heard from its side of the listener, quieter with distance as a real source is. */
  private place(x: number, z: number, ref = 4) {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.15;
    p.maxDistance = 500;
    p.positionX.value = x;
    p.positionY.value = 1;
    p.positionZ.value = z;
    p.connect(this.bus);
    return p;
  }

  /** Where the sound is heard from: the camera. `fx, fz` the way it faces. */
  listen(dt: number, x: number, y: number, z: number, fx: number, fz: number) {
    if (!this.ctx) return;
    const l = this.ctx.listener, e = this.ear;
    if (dt > 0) {
      e.vx = (x - e.x) / dt;
      e.vz = (z - e.z) / dt;
    }
    e.x = x; e.y = y; e.z = z;
    l.positionX.value = x;
    l.positionY.value = y;
    l.positionZ.value = z;
    l.forwardX.value = fx;
    l.forwardY.value = 0;
    l.forwardZ.value = fz;
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  }

  /**
   * The traffic heard: the nearest few engines, each placed where its car is and pitched by its speed and by
   * Doppler, and the distant roar of all of it. Call once a frame after listen().
   */
  traffic(dt: number, cars: readonly { x: number; z: number; vx: number; vz: number; id: number; kind: string }[]) {
    const ctx = this.ctx;
    if (!ctx || this.paused || dt <= 0) return;
    const e = this.ear;
    const near = cars
      .map((c) => ({ c, d: Math.hypot(c.x - e.x, c.z - e.z) }))
      .filter((n) => n.d < NPC_RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, NPC_VOICES);
    const keep = new Set(near.map((n) => n.c.id));
    for (const [id, n] of this.npcs) {
      if (keep.has(id) && n.kind === near.find((m) => m.c.id === id)!.c.kind) continue;
      n.voice.stop();
      setTimeout(() => n.panner.disconnect(), 300);
      this.npcs.delete(id);
    }
    for (const { c, d } of near) {
      // an auto-rickshaw's single cylinder, a bus's diesel six, a car's four
      const [cyl, diesel, idle, ratio] = c.kind.startsWith('auto') ? [1, false, 1500, 900] : c.kind.includes('bus') ? [6, true, 620, 160] : [4, false, 780, 500];
      let n = this.npcs.get(c.id);
      if (!n) {
        const panner = this.place(c.x, c.z);
        n = { voice: new EngineVoice(ctx, bank(ctx, cyl, diesel), panner), panner, kind: c.kind, speed: Math.hypot(c.vx, c.vz), effort: 0.2, gear: 0 };
        this.npcs.set(c.id, n);
      }
      const t = ctx.currentTime;
      n.panner.positionX.setTargetAtTime(c.x, t, 0.03);
      n.panner.positionZ.setTargetAtTime(c.z, t, 0.03);
      const speed = Math.hypot(c.vx, c.vz);
      const accel = (speed - n.speed) / dt;
      n.speed = speed;
      n.effort += (clamp(0.15 + accel * 0.35, 0, 1) - n.effort) * damp(3, dt);
      // a lazy automatic: up a gear past ~3000 rpm, down below ~1500
      const gears = [1, 0.65, 0.46, 0.34, 0.26];
      let rpm = idle + speed * ratio * gears[n.gear];
      if (rpm > 2700 + n.effort * 1500 && n.gear < gears.length - 1) n.gear++;
      else if (rpm < 1500 && n.gear > 0) n.gear--;
      rpm = Math.min(idle + speed * ratio * gears[n.gear], 5000);
      // Doppler by hand, from how fast the car and the listener close on each other
      const ux = (c.x - e.x) / Math.max(d, 0.1), uz = (c.z - e.z) / Math.max(d, 0.1);
      const away = (c.vx - e.vx) * ux + (c.vz - e.vz) * uz;
      const doppler = clamp(343 / (343 + away), 0.85, 1.18);
      n.voice.set(rpm, n.effort, doppler, c.kind.includes('bus') ? 0.7 : 0.5);
    }
    // the distant roar: louder the more traffic is about
    const busy = cars.reduce((k, c) => k + (Math.hypot(c.x - e.x, c.z - e.z) < 150 ? 1 : 0), 0);
    this.rumble.gain.gain.setTargetAtTime(Math.min(0.07, 0.012 + busy * 0.003), ctx.currentTime, 0.5);
  }

  /**
   * Another driver's horn at (x, z): a tap, two taps, or a long blast. Played from the steady note (the clip's
   * press is a thump that, cut short, sounded like a bark), shaped so it starts and stops cleanly, placed where
   * the car is and muffled with distance as a real one is. A few at a time across the street, never a chorus.
   */
  honk(x: number, z: number, kind: 'tap' | 'double' | 'long', pitch: number) {
    const buf = this.clips.get('horn.wav');
    const distance = Math.hypot(x - this.ear.x, z - this.ear.z);
    if (!this.ctx || !buf || distance > 150) return;
    const t = this.ctx.currentTime;
    this.npcHorns = this.npcHorns.filter((end) => end > t);
    if (this.npcHorns.length >= NPC_HORNS) return;
    const notes = kind === 'tap' ? [[0, 0.22]] : kind === 'double' ? [[0, 0.16], [0.28, 0.2]] : [[0, 1 + Math.random() * 0.5]];
    const end = notes[notes.length - 1][0] + notes[notes.length - 1][1];
    this.npcHorns.push(t + end + 0.3);
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
    gain.gain.setValueAtTime(0, t);
    for (const [at, length] of notes) {
      gain.gain.setTargetAtTime(0.9, t + at, 0.008);
      gain.gain.setTargetAtTime(0, t + at + length, 0.015);
    }
    const panner = this.place(x, z, 8);
    src.connect(muffle).connect(gain).connect(panner);
    src.start(t, HORN_LOOP);
    src.stop(t + end + 0.1);
    src.onended = () => panner.disconnect();
  }

  /**
   * The sounds of a fight, `distance` metres off: a blow thrown, a fist, a boot or a stick landing, one taken on
   * a guard, a body hitting the ground; the rifles, their rounds landing and their magazines changed; and the
   * voices: the grunt of a heavy blow thrown, the cry of one taken, a scream, a death. The rifles and the voices
   * are recordings (`take`); the blows are made up, a falling low tone for the weight, a burst of noise for the
   * smack of it and, on a hard one, a crack on top. Until the recordings have loaded the rest is made up too.
   * `voice` is how high the voice is (a man's is 1).
   */
  thump(kind: Thump, strength: number, distance: number, voice = 1) {
    const ctx = this.ctx, noise = this.noise;
    if (!ctx || !noise || distance > 60) return;
    const t = ctx.currentTime, near = 1 / (1 + distance / 6), out = ctx.createGain();
    // further off, the high end goes first
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 12000 / (1 + distance / 12);
    out.gain.value = near;
    out.connect(air).connect(this.bus);
    const vary = () => 0.9 + Math.random() * 0.2;
    const burst = (type: BiquadFilterType, hz: number, q: number, level: number, seconds: number, to?: number, at = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(hz * vary(), t + at);
      if (to) filter.frequency.exponentialRampToValueAtTime(to, t + at + seconds);
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(level, t + at + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + seconds);
      src.connect(filter).connect(gain).connect(out);
      src.start(t + at, Math.random() * (noise.duration - seconds - 0.1));
      src.stop(t + at + seconds + 0.05);
    };
    const tone = (from: number, to: number, level: number, seconds: number, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(from * vary(), t);
      osc.frequency.exponentialRampToValueAtTime(to, t + seconds);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(level, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      osc.connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + seconds + 0.05);
    };
    const k = clamp(strength / 35, 0.3, 1.5);
    // a rifle carries: it is heard down the street long after a voice is not
    const loud = kind === 'm416' || kind === 'akm';
    if (loud) out.gain.value = 1 / (1 + distance / 40);
    if (this.take(kind, strength, voice, out)) {
      // under the recording, the thump of it in the chest
      if (loud) tone(kind === 'akm' ? 80 : 100, 38, 0.5, 0.12);
      return;
    }
    switch (kind) {
      case 'swing':
        burst('bandpass', 420 / Math.max(0.5, strength), 1.4, 0.35 * strength, 0.18, 1600);
        break;
      case 'punch':
        // the weight of it, the slap of knuckle on skin, and the crack of bone under it on a hard one
        tone(130, 48, 1.3 * k, 0.13);
        burst('lowpass', 900, 0.8, 1.4 * k, 0.07);
        burst('bandpass', 1400, 1.2, 1.1 * k, 0.035);
        burst('highpass', 2600, 0.7, 0.55 * k, 0.02);
        if (strength > 30) burst('bandpass', 3800, 3, 0.6 * k, 0.025, undefined, 0.004);
        break;
      case 'kick':
        tone(95, 38, 1.6 * k, 0.18);
        burst('lowpass', 600, 0.9, 1.6 * k, 0.1);
        burst('highpass', 2000, 0.7, 0.4 * k, 0.04);
        break;
      case 'stick':
        burst('bandpass', 1900, 6, 1.6 * k, 0.05);
        tone(240, 120, 0.7 * k, 0.09, 'triangle');
        tone(110, 45, 1.1 * k, 0.12);
        break;
      case 'block':
        tone(160, 90, 0.8 * k, 0.08);
        burst('lowpass', 500, 1, 1 * k, 0.06);
        break;
      case 'thud':
        tone(110, 50, 0.9 * k, 0.12);
        burst('lowpass', 260, 1, 1.2 * k, 0.12);
        break;
      case 'body': {
        const b = clamp(strength / 8, 0.4, 1.5);
        tone(70, 32, 1.6 * b, 0.3);
        burst('lowpass', 180, 1, 1.8 * b, 0.25);
        burst('lowpass', 700, 0.8, 0.5 * b, 0.12, undefined, 0.06);
        break;
      }
      case 'm416':
      case 'akm': {
        // the supersonic crack, the boom of the charge, the bolt, and the street throwing it back a beat later
        const ak = kind === 'akm';
        burst('highpass', ak ? 1400 : 1900, 0.7, 1.6, 0.045);
        burst('bandpass', ak ? 900 : 1300, 0.9, 1.3, 0.08);
        tone(ak ? 85 : 110, 35, ak ? 2 : 1.6, ak ? 0.22 : 0.17);
        burst('lowpass', ak ? 380 : 520, 0.8, ak ? 1.9 : 1.5, ak ? 0.2 : 0.15);
        burst('bandpass', 3200, 4, 0.25, 0.02, undefined, 0.035);
        for (const [at, level] of [[0.09, 0.32], [0.21, 0.18], [0.38, 0.1]]) burst('bandpass', 700 + Math.random() * 400, 0.8, level * (ak ? 1.2 : 1), 0.28, 300, at);
        break;
      }
      case 'hit':
        // a round going into someone
        tone(160, 60, 0.9 * strength, 0.07);
        burst('bandpass', 1100, 1.5, 1.1 * strength, 0.05);
        burst('lowpass', 500, 1, 0.8 * strength, 0.09);
        break;
      case 'ricochet':
        burst('highpass', 2500, 0.8, 0.5, 0.03);
        tone(2600 + Math.random() * 1800, 1200, 0.08, 0.22, 'sine');
        burst('lowpass', 700, 1, 0.4, 0.05);
        break;
      case 'click':
        burst('bandpass', 3500, 6, 0.5, 0.015);
        break;
      case 'draw':
      case 'reload-m416':
      case 'reload-akm':
        // the magazine out, in, and the charging handle
        burst('bandpass', 1800, 4, 0.5 * strength, 0.04);
        burst('bandpass', 1200, 5, 0.6 * strength, 0.05, undefined, 0.45 * strength);
        burst('bandpass', 2400, 6, 0.7 * strength, 0.04, undefined, 0.9 * strength);
        tone(180, 120, 0.2 * strength, 0.06);
        break;
      default:
        this.voice(kind !== 'grunt', strength, voice, out, burst);
    }
  }

  /**
   * A voice: the effort of a blow thrown ("hff", "hup") or the noise of one taken ("oof", "ugh", and on a bad one
   * a strangled "argh"). Mostly breath: a short burst of air through the mouth's shape, with the voice coming in
   * under it only briefly, unsteady and creaking as a real throat does when it is hit. Never quite the same twice.
   */
  private voice(pain: boolean, strength: number, pitch: number, out: AudioNode, burst: (type: BiquadFilterType, hz: number, q: number, level: number, seconds: number, to?: number, at?: number) => void) {
    const ctx = this.ctx!, t = ctx.currentTime, r = Math.random;
    const hard = pain && strength > 0.9;
    const seconds = pain ? (hard ? 0.32 : 0.16) + r() * 0.12 : 0.09 + r() * 0.07;
    const level = (pain ? 0.42 : 0.26) * clamp(strength, 0.4, 1.3);
    // vowels as the mouth makes them, formant pairs in Hz: "uh", "oh", "ah", "eh", "oo"
    const vowels: [number, number][] = pain ? (hard ? [[750, 1200], [680, 1100], [600, 1050]] : [[520, 950], [450, 850], [380, 800], [640, 1150]]) : [[500, 1000], [420, 900], [550, 1400]];
    const [f1, f2] = vowels[Math.floor(r() * vowels.length)];
    const lift = Math.sqrt(pitch);
    const f0 = (pain ? 125 + strength * 30 : 105) * pitch * (0.92 + r() * 0.16);

    // the throat: a buzz whose pitch wavers and drops as the air runs out, gated short
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * (pain ? 1.15 : 1), t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + seconds);
    const wobble = ctx.createOscillator(), wobbleDepth = ctx.createGain();
    wobble.frequency.value = 5 + r() * 9;
    wobbleDepth.gain.value = f0 * (hard ? 0.09 : 0.04);
    wobble.connect(wobbleDepth).connect(osc.frequency);
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 1800 * lift;
    const throat = ctx.createGain();
    // the voice comes in a beat after the air and is gone before it
    throat.gain.setValueAtTime(0.0001, t);
    throat.gain.exponentialRampToValueAtTime(level * (pain ? 0.8 : 0.45), t + 0.015 + r() * 0.02);
    throat.gain.exponentialRampToValueAtTime(0.0001, t + seconds * (pain ? 0.85 : 0.6));
    osc.connect(soft).connect(throat);
    let src: AudioNode = throat;
    if (hard) {
      // a creak: the voice breaking up as it is forced out
      const creak = ctx.createGain(), rattle = ctx.createOscillator(), depth = ctx.createGain();
      rattle.type = 'square';
      rattle.frequency.value = 28 + r() * 25;
      depth.gain.value = 0.5;
      creak.gain.value = 0.5;
      rattle.connect(depth).connect(creak.gain);
      throat.connect(creak);
      src = creak;
      rattle.start(t);
      rattle.stop(t + seconds + 0.05);
    }
    // the mouth: two resonances, the second sliding as the jaw closes
    for (const [hz, q, share, slide] of [[f1, 4, 1, 0.85], [f2, 6, 0.55, 0.8], [2600, 8, 0.15, 1]] as const) {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(hz * lift, t);
      f.frequency.linearRampToValueAtTime(hz * lift * slide, t + seconds);
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = share * 2.4;
      src.connect(f).connect(g).connect(out);
    }
    for (const o of [osc, wobble]) {
      o.start(t);
      o.stop(t + seconds + 0.05);
    }
    // the breath: most of what is heard, forced out through the same mouth shape
    burst('bandpass', f2 * lift, 1.2, level * (pain ? 0.55 : 0.9), seconds, f1 * lift);
    burst('highpass', 3000, 0.6, level * 0.25, seconds * 0.5);
    // a gasp in after a bad one
    if (hard && r() < 0.6) burst('bandpass', 2200 * lift, 2, level * 0.3, 0.2, 1500, seconds + 0.12);
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

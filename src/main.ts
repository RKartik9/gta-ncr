import * as THREE from 'three/webgpu';
import { pickQuality, query } from './config.ts';
import { backendName, createPipeline, createRenderer, setupShadows } from './render/renderer.ts';
import { DayNight, onNight } from './render/sky.ts';
import { setAnisotropy } from './render/textures.ts';
import { type Grid, loadJson, nearestRoad } from './world/tile.ts';
import { buildBasePlane, isMajor, isStreet } from './world/ground.ts';
import { LampLights } from './world/props.ts';
import { STEP, createPhysics } from './world/physics.ts';
import { Streamer } from './world/streamer.ts';
import { buildLandmarks, neighbourhood } from './world/landmarks.ts';
import { CARS, type CarSpec, axleHeight, restLength } from './vehicle/cars.ts';
import { type CarModel, addLamps, buildHatchback } from './vehicle/carModel.ts';
import { loadGltfCar } from './vehicle/gltfCar.ts';
import { Vehicle } from './vehicle/vehicle.ts';
import { Keyboard } from './vehicle/input.ts';
import { CAMERA_MODES, CameraDirector, type CameraMode } from './camera/director.ts';
import { Hud, hideLoading, setLoading } from './hud/hud.ts';

async function boot() {
  const quality = pickQuality();
  const canvas = document.getElementById('view') as HTMLCanvasElement;

  setLoading('Starting the renderer…', false, 0.05);
  const renderer = await createRenderer(canvas, quality, query.has('gl'));
  setAnisotropy(Math.min(quality.anisotropy, renderer.getMaxAnisotropy()));

  setLoading('Loading the map of central Delhi…', false, 0.12);
  const area = 'central';
  const grid = await loadJson<Grid>(`${area}/index`);
  const plaza = grid.plaza;

  const scene = new THREE.Scene();
  const director = new CameraDirector(canvas);
  const camera = director.camera;
  // ?time=22 starts at night; ?speed= is game hours per real second (0 freezes the clock)
  const daynight = new DayNight(scene, renderer, Number(query.get('time') ?? 16), Number(query.get('speed') ?? 1 / 60));
  const sun = daynight.sun;
  scene.add(buildBasePlane(grid.bounds));
  const world = await createPhysics(grid.bounds);
  buildLandmarks(scene, world);

  // Cars load once and are kept, so switching back is instant.
  const models = new Map<string, Promise<CarModel>>();
  const hud = new Hud(grid.attribution, (mode) => setCamera(mode), () => void switchCar());
  const lampLights = new LampLights(scene, [], quality.lampLights);
  const streamer = new Streamer(grid, area, scene, world, quality.treeDensity);
  let booting = true, built = 0;
  streamer.onChange = (added, removed) => {
    if (added && booting) setLoading(`Building the city… ${++built} blocks of Delhi`, false, 0.18 + Math.min(0.7, built * 0.07));
    if (added) hud.addCell(added.key, added.tile);
    if (removed) hud.removeCell(removed);
    lampLights.heads = streamer.lampHeads;
  };
  const getModel = (spec: CarSpec) => {
    let p = models.get(spec.id);
    if (!p) {
      p = loadGltfCar(spec).catch((err) => {
        console.warn(`Could not load the ${spec.name} model, using the stand-in hatchback`, err);
        hud.say(`${spec.name} model missing: using the stand-in`);
        return buildHatchback();
      });
      models.set(spec.id, p);
    }
    return p;
  };

  // Start on the Inner Circle, facing the way its one-way traffic runs; ?x=&z= starts anywhere on the map.
  const startX = Number(query.get('x') ?? plaza[0] + 120), startZ = Number(query.get('z') ?? plaza[1] + 150);
  setLoading('Building the city…');
  await streamer.update(startX, startZ);
  const spawnAt = (x: number, z: number) => {
    const tiles = streamer.tiles;
    const hit = nearestRoad(tiles, x, z, (r) => r.name === 'Inner Circle' && query.get('x') === null) ?? nearestRoad(tiles, x, z, isStreet) ?? nearestRoad(tiles, x, z);
    return hit ? { x: hit.x, z: hit.z, heading: hit.heading } : { x, z, heading: 0 };
  };
  const start = spawnAt(startX, startZ);
  booting = false;
  if (query.has('h')) start.heading = THREE.MathUtils.degToRad(Number(query.get('h')));

  setLoading('Bringing the car round…', false, 0.92);
  let carIndex = Math.max(0, CARS.findIndex((c) => c.id === query.get('car')));
  let model = await getModel(CARS[carIndex]);
  let vehicle = new Vehicle(world, model.spec, start.x, start.z, start.heading);
  scene.add(model.group);
  hud.setCar(model.spec.name, model.spec.credit ?? '');
  for (const spec of CARS) void getModel(spec);

  let switching = false;
  async function switchCar() {
    if (switching) return;
    switching = true;
    const next = (carIndex + 1) % CARS.length;
    const incoming = await getModel(CARS[next]);
    const p = vehicle.body.translation();
    const heading = vehicle.heading;
    vehicle.dispose();
    scene.remove(model.group);
    carIndex = next;
    model = incoming;
    vehicle = new Vehicle(world, model.spec, p.x, p.z, heading);
    scene.add(model.group);
    readPose(current);
    previous.p.copy(current.p);
    previous.q.copy(current.q);
    director.cut();
    hud.setCar(model.spec.name, model.spec.credit ?? '');
    hud.say(model.spec.name);
    switching = false;
  }

  const shadows = setupShadows(sun, daynight.lightDir, quality);
  director.onLensChange = shadows.refit;
  const { pipeline, setNight } = createPipeline(renderer, scene, camera, quality);
  onNight(setNight);

  // Headlights: on by themselves after dusk; L overrides until the next dusk or dawn.
  const carLamps = new Map<CarModel, ReturnType<typeof addLamps>>();
  const lampsOf = (m: CarModel) => {
    let l = carLamps.get(m);
    if (!l) carLamps.set(m, (l = addLamps(m, quality.headlightShadow)));
    return l;
  };
  let headlights: boolean | null = null;
  let wasDark = false;

  function setCamera(mode: CameraMode) {
    director.setMode(mode);
    hud.setCamera(mode);
  }
  const wanted = query.get('cam') as CameraMode | null;
  setCamera(wanted && CAMERA_MODES.includes(wanted) ? wanted : 'chase');

  function resetCar() {
    const p = vehicle.body.translation();
    const hit = nearestRoad(streamer.tiles, p.x, p.z, isStreet) ?? nearestRoad(streamer.tiles, p.x, p.z);
    if (!hit) return;
    // keep the way the car was facing rather than snapping it round to the way the road was drawn
    const along = Math.cos(hit.heading - vehicle.heading) >= 0 ? hit.heading : hit.heading + Math.PI;
    vehicle.place(hit.x, hit.z, along);
    readPose(current);
    previous.p.copy(current.p);
    previous.q.copy(current.q);
    director.cut();
  }

  let audio: AudioContext | null = null;
  function horn() {
    audio ??= new AudioContext();
    const gain = audio.createGain();
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, audio.currentTime + 0.02);
    gain.gain.setValueAtTime(0.16, audio.currentTime + 0.32);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.42);
    gain.connect(audio.destination);
    for (const f of [415, 520]) {
      const osc = audio.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(gain);
      osc.start();
      osc.stop(audio.currentTime + 0.45);
    }
  }

  const keys = new Keyboard();
  keys.on('KeyC', () => {
    director.next();
    hud.setCamera(director.mode);
  });
  CAMERA_MODES.forEach((mode, i) => keys.on(`Digit${i + 1}`, () => setCamera(mode)));
  keys.on('KeyV', () => void switchCar());
  keys.on('KeyR', resetCar);
  keys.on('KeyH', horn);
  keys.on('KeyN', () => {
    daynight.toggle();
    headlights = null;
    hud.say(daynight.night > 0.5 ? 'Night' : 'Day');
  });
  keys.on('KeyT', () => {
    daynight.running = !daynight.running;
    hud.say(daynight.running ? 'Time running' : 'Time paused');
  });
  keys.on('Escape', () => hud.toggleMenu());
  keys.onPadChange = (name) => hud.say(name ? `Controller connected: ${name}` : 'Controller disconnected');
  const padReport = document.getElementById('pad-report')!;
  setInterval(() => {
    if (hud.menuOpen) padReport.textContent = keys.padReport();
  }, 100);
  hud.bindTime(() => daynight.hour, (h) => {
    daynight.hour = h;
    headlights = null;
  });
  keys.on('KeyL', () => {
    headlights = !lampsOf(model).on;
    hud.say(headlights ? 'Headlights on' : 'Headlights off');
  });

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    director.resize();
  });

  // Physics runs at a fixed 60 Hz; the picture blends between the last two steps, so it stays smooth at any refresh rate.
  const previous = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const current = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  function readPose(into: typeof current) {
    const t = vehicle.body.translation(), r = vehicle.body.rotation();
    into.p.set(t.x, t.y, t.z);
    into.q.set(r.x, r.y, r.z, r.w);
  }
  readPose(current);
  readPose(previous);

  const axle = new THREE.Vector3(-1, 0, 0);
  const perf = { fps: 0, ms: 0, worst: 0, frames: 0, time: 0, peak: 0, drawCalls: 0, triangles: 0 };
  let last = performance.now();
  let lag = 0;
  let roadTimer = 0;
  let firstFrame = true;

  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    keys.poll();
    // right stick looks round, at about the speed of a brisk mouse drag
    if (keys.look.x || keys.look.y) director.turn(keys.look.x * dt * 700, keys.look.y * dt * 500);
    const speedBefore = vehicle.speed;
    lag += hud.menuOpen ? 0 : dt; // the Esc menu pauses the game
    let steps = 0;
    while (lag >= STEP && steps < 5) {
      previous.p.copy(current.p);
      previous.q.copy(current.q);
      vehicle.update(keys.drive(), STEP);
      world.step();
      readPose(current);
      lag -= STEP;
      steps++;
    }
    if (steps === 5) lag = 0;
    // a sudden loss of speed is a hit: shake the controller in proportion
    const jolt = Math.abs(vehicle.speed - speedBefore);
    if (steps && jolt > 2.5) keys.rumble(jolt / 12, 120 + jolt * 15);
    streamer.sync();
    const blend = lag / STEP;
    model.group.position.lerpVectors(previous.p, current.p, blend);
    model.group.quaternion.slerpQuaternions(previous.q, current.q, blend);

    const spec = model.spec;
    model.wheels.forEach((w, i) => {
      const length = vehicle.controller.wheelSuspensionLength(i) ?? restLength(spec);
      w.pivot.position.y = axleHeight(spec) - length + w.lift;
      w.pivot.rotation.y = vehicle.controller.wheelSteering(i) ?? 0;
      w.spin.quaternion.setFromAxisAngle(axle, vehicle.controller.wheelRotation(i) ?? 0);
    });
    model.setBraking(vehicle.braking);

    daynight.update(hud.menuOpen ? 0 : dt);
    const dark = daynight.night > 0.5;
    if (dark !== wasDark) {
      wasDark = dark;
      headlights = null;
    }
    lampsOf(model).set(headlights ?? dark, vehicle.braking);
    lampLights.update(dt, model.group.position);

    director.update(dt, model.group, vehicle, spec);
    shadows.follow(model.group.position);
    hud.update(vehicle.speed, model.group.position.x, model.group.position.z, vehicle.heading);

    roadTimer -= dt;
    if (roadTimer <= 0) {
      roadTimer = 0.3;
      const p = model.group.position;
      const hit = nearestRoad(streamer.tiles, p.x, p.z, (r) => !!r.name && (isMajor(r) || isStreet(r)));
      void streamer.update(p.x, p.z);
      hud.setRegion(neighbourhood(p.x, p.z));
      hud.setRoad(hit && hit.distance < 25 ? hit.road.name! : '');
    }

    pipeline.render();

    if (firstFrame) {
      firstFrame = false;
      hideLoading();
    }
    perf.frames++;
    perf.time += dt;
    perf.peak = Math.max(perf.peak, dt);
    if (perf.time >= 0.5) {
      perf.fps = perf.frames / perf.time;
      perf.ms = (perf.time / perf.frames) * 1000;
      perf.worst = perf.peak * 1000;
      perf.frames = perf.time = perf.peak = 0;
      perf.drawCalls = renderer.info.render.drawCalls;
      perf.triangles = renderer.info.render.triangles;
      hud.setStats(
        `<b>${perf.fps.toFixed(0)}</b> fps  ${perf.ms.toFixed(1)} ms  worst ${perf.worst.toFixed(0)} ms\n` +
          `${backendName(renderer)} · ${quality.name} · ${renderer.domElement.width}×${renderer.domElement.height}\n` +
          `${perf.drawCalls} draws · ${(perf.triangles / 1000).toFixed(0)}k tris`,
      );
    }
  });

  // Handles for the browser console and for automated checks.
  Object.assign(window, {
    game: {
      perf,
      grid,
      streamer,
      debug: { THREE, scene, sun, renderer, camera },
      get vehicle() {
        return vehicle;
      },
      get car() {
        return model.spec.id;
      },
      setCamera,
      daynight,
      switchCar,
      place: (x: number, z: number, headingDeg: number) => {
        void streamer.update(x, z);
        vehicle.place(x, z, THREE.MathUtils.degToRad(headingDeg));
        readPose(current);
        readPose(previous);
        director.cut();
      },
      state: () => {
        const p = vehicle.body.translation();
        return {
          car: model.spec.id, camera: director.mode, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
          hour: +daynight.hour.toFixed(2), night: +daynight.night.toFixed(2),
          heading: +THREE.MathUtils.radToDeg(vehicle.heading).toFixed(1), kmh: +(vehicle.speed * 3.6).toFixed(1), flipped: vehicle.isFlipped,
          fps: +perf.fps.toFixed(1), ms: +perf.ms.toFixed(2), backend: backendName(renderer), quality: quality.name,
          drawCalls: perf.drawCalls, triangles: perf.triangles, cells: streamer.cells.size, buildings: streamer.tiles.reduce((n, t) => n + t.buildings.length, 0), knocked: streamer.awake,
        };
      },
    },
  });
}

boot().catch((err) => {
  console.error(err);
  setLoading(`Could not start: ${err instanceof Error ? err.message : String(err)}`, true);
});

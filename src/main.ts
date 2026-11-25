import * as THREE from 'three/webgpu';
import { CITY, QUALITY_NAMES, type QualityName, detectGpu, pickQuality, query, saveQuality, savedQuality } from './config.ts';
import { type Progress, clearProgress, loadProgress, saveProgress } from './save.ts';
import { backendName, createPipeline, createRenderer, resolutionGovernor, setupShadows } from './render/renderer.ts';
import { DayNight, onNight } from './render/sky.ts';
import { TyreFx } from './render/tyreFx.ts';
import { setAnisotropy } from './render/textures.ts';
import { type Grid, type Tile, deckHeight, loadJson, nearestRoad, offRoadInWater } from './world/tile.ts';
import { RoadGraph } from './world/route.ts';
import { Gps } from './world/gps.ts';
import { BigMap } from './hud/bigmap.ts';
import { ROAD_HEIGHT, buildBasePlane, hasPavement, isMajor, isStreet } from './world/ground.ts';
import { LampLights } from './world/props.ts';
import { STEP, createPhysics, stepWorld } from './world/physics.ts';
import { Streamer } from './world/streamer.ts';
import { Traffic } from './world/traffic.ts';
import { Pedestrians } from './world/pedestrians.ts';
import { buildLandmarks, neighbourhood } from './world/landmarks.ts';
import { CARS, type CarSpec, axleHeight, restLength, rideHeight } from './vehicle/cars.ts';
import { loadGarage, loadImported, setupImporter } from './vehicle/garage.ts';
import { seatRider } from './vehicle/rider.ts';
import { CarLamps, type CarModel, buildCodedCar, buildHatchback } from './vehicle/carModel.ts';
import { loadGltfCar } from './vehicle/gltfCar.ts';
import { Vehicle } from './vehicle/vehicle.ts';
import { Keyboard } from './vehicle/input.ts';
import { CAMERA_MODES, CameraDirector, type CameraMode } from './camera/director.ts';
import { Hud, chooseStart, hideLoading, setLoading } from './hud/hud.ts';
import { Sound } from './audio/sound.ts';
import { Music } from './audio/music.ts';
import { type CarRef, Combat } from './character/combat.ts';

const RESUME = 'delhi-drive:resume';

async function boot() {
  const gpu = detectGpu();
  const quality = pickQuality(gpu);
  if (CITY === 'mumbai') {
    // its own title and pictures: the Sea Link, Marine Drive and the Gateway, taken in the game
    document.title = 'Namaste Bombay · drive from Bandra to Colaba in your browser';
    document.querySelector('#loading h1')!.innerHTML = 'Namaste<br><span>Bombay</span>';
    document.getElementById('brand')!.textContent = 'Namaste Bombay';
    for (const a of document.querySelectorAll('#loading .cities a')) a.classList.toggle('active', (a as HTMLElement).dataset.city === CITY);
    document.querySelectorAll<HTMLElement>('#loading .panel i').forEach((el, k) => {
      el.style.backgroundImage = `url(loading/mumbai-${['sealink', 'marine-drive', 'gateway'][k]}.jpg)`;
    });
  }
  // Saved progress, unless the address asks for a particular start (?x=&z=) or a clean one (?fresh).
  const stored = query.has('x') || query.has('fresh') ? null : loadProgress();
  // The title screen asks: carry on, or a new game. An address that says how to start (any ?option, as the dev
  // tools use) is not asked, nor is the reload that only changes the graphics preset.
  let resuming = false;
  try {
    resuming = !!sessionStorage.getItem(RESUME);
    sessionStorage.removeItem(RESUME);
  } catch {
    // storage blocked: there is nothing saved to resume either
  }
  // ?city= only says which map: the title screen still asks
  const asked = [...query.keys()].every((k) => k === 'city') && !resuming;
  const saved = !asked || (await chooseStart(!!stored)) ? stored : null;
  const canvas = document.getElementById('view') as HTMLCanvasElement;

  // every road in the city: the GPS, the big map and the traffic need it, and so does each map cell, to keep
  // its trees and poles off roads that belong to the cell next door. Fetched while the renderer starts.
  const area = CITY === 'mumbai' ? 'mumbai' : 'central';
  const overviewLoad = loadJson<Tile>(`${area}/overview`);
  // which car to start in; its model is fetched while the city is built
  const garageLoad = loadGarage().then(() => Math.max(0, CARS.findIndex((c) => c.id === (query.get('car') ?? saved?.car))));
  setLoading('Starting the renderer…', false, 0.05);
  const renderer = await createRenderer(canvas, quality, query.has('gl'));
  setAnisotropy(Math.min(quality.anisotropy, renderer.getMaxAnisotropy()));

  setLoading(`Loading the map of ${CITY === 'mumbai' ? 'South Bombay' : 'central Delhi'}…`, false, 0.12);
  const grid = await loadJson<Grid>(`${area}/index`);
  const all = await overviewLoad;
  // no Connaught Place here: nothing is a Georgian block and no flag flies
  if (!grid.plaza) grid.plaza = [Infinity, Infinity];
  const plaza = grid.plaza;

  const scene = new THREE.Scene();
  const director = new CameraDirector(canvas);
  const camera = director.camera;
  // ?time=22 starts at night; ?speed= is game hours per real second (0 freezes the clock)
  const daynight = new DayNight(scene, renderer, Number(query.get('time') ?? saved?.hour ?? 16), Number(query.get('speed') ?? 1 / 60), quality.fog);
  if (saved && !query.has('time')) daynight.running = saved.clockRunning;
  const sun = daynight.sun;
  scene.add(buildBasePlane(grid.bounds));
  const world = await createPhysics(grid.bounds);
  buildLandmarks(scene, world, all.roads);

  // Cars load once and are kept, so switching back is instant.
  const models = new Map<string, Promise<CarModel>>();
  const hud = new Hud(grid.attribution, (mode) => setCamera(mode), () => void switchCar());
  const lampLights = new LampLights(scene, [], quality.lampLights);
  // in the scene from the start, so its shaders are built behind the loading screen
  const traffic = new Traffic(scene, world, quality.traffic, quality.drawDistance);
  const tyreFx = new TyreFx(scene, quality.name === 'low' ? 80 : 160);
  // Bombay's pavements are far busier than Delhi's
  const pedestrians = new Pedestrians(scene, world, Math.round(quality.pedestrians * (CITY === 'mumbai' ? 1.8 : 1)));
  // everything on foot: getting out of the car, the fights, the stick on the boot
  const combat = new Combat(scene, world, pedestrians, traffic, quality.fighters, {
    sound: (kind, strength, distance, voice) => sound.thump(kind, strength, distance, voice),
    shake: (amount) => director.shake(amount),
    hurt: (amount) => hud.flash(amount),
    pulledOut: () => setFoot(true),
    say: (text) => hud.say(text),
    rumble: (strength, ms) => keys.rumble(strength, ms),
    fade: (on) => hud.fade(on),
  });
  const streamer = new Streamer(grid, area, all.roads, scene, world, quality.treeDensity, quality.drawDistance, quality.detailDistance);
  let booting = true, built = 0;
  streamer.onChange = (added, removed) => {
    if (added && booting) setLoading(`Building the city… ${++built} blocks of ${CITY === 'mumbai' ? 'Bombay' : 'Delhi'}`, false, 0.18 + Math.min(0.7, built * 0.07));
    if (added) hud.addCell(added.key, added.tile);
    if (removed) hud.removeCell(removed);
    lampLights.heads = streamer.lampHeads;
  };
  const getModel = (spec: CarSpec) => {
    let p = models.get(spec.id);
    if (!p) {
      p = !spec.model && !spec.imported ? Promise.resolve(buildCodedCar(spec)) : (spec.imported ? loadImported(spec) : loadGltfCar(spec)).catch((err) => {
        console.warn(`Could not load the ${spec.name} model, using the stand-in hatchback`, err);
        hud.say(`${spec.name} model missing: using the stand-in`);
        return spec.imported ? buildCodedCar(spec) : buildHatchback();
      });
      p = p.then(seatRider);
      models.set(spec.id, p);
    }
    return p;
  };
  void garageLoad.then((i) => getModel(CARS[i]));
  // ponytail: only the next car in the V cycle is fetched ahead; the rest load when asked for
  const prefetchNext = () => void getModel(CARS[(carIndex + 1) % CARS.length]);

  // Start on the Inner Circle, facing the way its one-way traffic runs; ?x=&z= starts anywhere on the map.
  // (in Mumbai: on the Sea Link out of Bandra, heading for Worli)
  const [homeX, homeZ] = CITY === 'delhi' ? [plaza[0] + 120, plaza[1] + 150] : grid.spawn;
  const startX = Number(query.get('x') ?? saved?.x ?? homeX), startZ = Number(query.get('z') ?? saved?.z ?? homeZ);
  setLoading('Building the city…');
  await streamer.update(startX, startZ);
  const spawnAt = (x: number, z: number) => {
    const tiles = streamer.tiles;
    const hit = nearestRoad(tiles, x, z, (r) => r.name === 'Inner Circle' && query.get('x') === null) ?? nearestRoad(tiles, x, z, isStreet) ?? nearestRoad(tiles, x, z);
    return hit ? { x: hit.x, z: hit.z, heading: hit.heading } : { x, z, heading: 0 };
  };
  // back exactly where the car was left, or on a road near the asked-for spot
  const start = saved ? { x: saved.x, z: saved.z, heading: saved.heading } : spawnAt(startX, startZ);
  booting = false;
  streamer.budget.ms = 4; // from here on the car is being driven: building takes only a sliver of each frame
  streamer.budget.worst = 0;
  streamer.cull(start.x, start.z);
  if (query.has('h')) start.heading = THREE.MathUtils.degToRad(Number(query.get('h')));

  setLoading('Bringing the car round…', false, 0.92);
  let carIndex = await garageLoad;
  setupImporter(() => model.spec);
  let model = await getModel(CARS[carIndex]);
  // a car saved (or started) on a flyover or the Sea Link is set down on its deck
  let vehicle = new Vehicle(world, model.spec, start.x, start.z, start.heading, deckHeight(streamer.tiles, start.x, start.z));
  scene.add(model.group);
  hud.setCar(model.spec.name, model.spec.credit ?? '');
  /** The car as the people on foot know it: where its doors and its boot are, and the road it stands on. */
  const carRef = (): CarRef => {
    const v = vehicle, m = model;
    return {
      group: m.group, spec: m.spec, body: v.body, bike: !!m.lean,
      get ground() {
        return Math.max(0, v.body.translation().y - rideHeight(m.spec) - 0.02);
      },
      get heading() {
        return v.heading;
      },
    };
  };
  combat.setCar(carRef());

  let switching = false;
  async function switchCar() {
    if (switching) return;
    if (combat.onFoot) {
      // on foot the same button ducks out of the way
      combat.dodge(keys.foot(), director.facing);
      return;
    }
    switching = true;
    const next = (carIndex + 1) % CARS.length;
    // Say so straight away: the model may still be loading, and its shaders are readied before the swap, so the
    // game keeps running (and the toast shows) instead of stalling on the first frame with the new car.
    hud.say(`Bringing the ${CARS[next].name} round…`);
    const incoming = await getModel(CARS[next]);
    await renderer.compileAsync(incoming.group, camera, scene);
    const p = vehicle.body.translation();
    const heading = vehicle.heading;
    // the road under the old car (a flyover deck, or the ground below one), for the new one to stand on
    const ground = Math.max(0, p.y - rideHeight(model.spec) - 0.3);
    vehicle.dispose();
    scene.remove(model.group);
    carIndex = next;
    model = incoming;
    vehicle = new Vehicle(world, model.spec, p.x, p.z, heading, ground);
    combat.setCar(carRef());
    tyreFx.reset();
    scene.add(model.group);
    carLamps.attach(model);
    readPose(current);
    previous.p.copy(current.p);
    previous.q.copy(current.q);
    director.cut();
    hud.setCar(model.spec.name, model.spec.credit ?? '');
    hud.say(model.spec.name);
    sound.setCar(model.spec);
    switching = false;
    prefetchNext();
  }

  const shadows = setupShadows(sun, daynight.lightDir, quality);
  director.onLensChange = shadows.refit;
  const { pipeline, setNight } = createPipeline(renderer, scene, camera, quality);
  onNight(setNight);

  // Headlights: on by themselves after dusk; L overrides until the next dusk or dawn.
  const carLamps = new CarLamps(quality.headlightShadow);
  carLamps.attach(model);
  let headlights: boolean | null = saved?.headlights ?? null;
  let wasDark = false;
  /** seconds the car has lain on its side or roof; the way back is told once it has come to rest there */
  let overTime = 0;

  function setCamera(mode: CameraMode) {
    director.setMode(mode);
    hud.setCamera(mode);
  }
  const wanted = (query.get('cam') ?? saved?.camera ?? null) as CameraMode | null;
  setCamera(wanted && CAMERA_MODES.includes(wanted) ? wanted : 'chase');

  function resetCar() {
    if (combat.onFoot) return;
    const p = vehicle.body.translation();
    const hit = nearestRoad(streamer.tiles, p.x, p.z, (r) => isStreet(r) && !r.elev) ?? nearestRoad(streamer.tiles, p.x, p.z, (r) => !r.elev);
    if (!hit) return;
    // keep the way the car was facing rather than snapping it round to the way the road was drawn
    const along = Math.cos(hit.heading - vehicle.heading) >= 0 ? hit.heading : hit.heading + Math.PI;
    vehicle.place(hit.x, hit.z, along);
    tyreFx.reset();
    readPose(current);
    previous.p.copy(current.p);
    previous.q.copy(current.q);
    director.cut();
  }

  const sound = new Sound();
  sound.setCar(model.spec);
  const music = new Music();
  music.resumeOnGesture();

  const keys = new Keyboard();
  keys.on('KeyC', () => {
    if (combat.onFoot) return;
    director.next();
    hud.setCamera(director.mode);
  });
  CAMERA_MODES.forEach((mode, i) => keys.on(`Digit${i + 1}`, () => !combat.onFoot && setCamera(mode)));
  // Out of the car and back in. On foot the camera goes over the player's shoulder and the mouse is theirs to look and hit with.
  const setFoot = (on: boolean) => {
    director.setOnFoot(on, vehicle.heading);
    hud.setOnFoot(on);
  };
  keys.on('KeyF', () => {
    if (hud.menuOpen || bigmap.open) return;
    if (combat.onFoot) {
      if (combat.enter()) setFoot(false);
    } else if (Math.abs(vehicle.speed) > 2) hud.say('Stop first');
    else if (combat.exit()) setFoot(true);
  });
  keys.on('KeyE', () => combat.interact());
  keys.on('KeyJ', () => combat.attack());
  keys.on('KeyQ', () => combat.kick());
  keys.on('Mouse1', () => combat.kick());
  keys.on('Space', () => combat.dodge(keys.foot(), director.facing));
  keys.on('Mouse0', () => !hud.menuOpen && !bigmap.open && combat.attack());
  // Esc gives the mouse back (the browser sees to that), and the game pauses as it does for Esc at the wheel.
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && combat.onFoot && !hud.menuOpen && !bigmap.open) hud.toggleMenu(true);
  });
  keys.on('KeyV', () => void switchCar());
  // GPS: the big map (M) sets a waypoint; the route is worked out over every road once the overview is in.
  const gps = new Gps(scene);
  if (saved?.waypoint) gps.waypoint = saved.waypoint; // routed as soon as the road graph is in
  const bigmap = new BigMap(grid);
  /** where the player is: at the wheel, or wherever they have walked to */
  const carPos = () => (combat.onFoot ? combat.player.pos : model.group.position);
  bigmap.onWaypoint = (p) => {
    gps.set(p, carPos());
    hud.say(p ? (gps.ready ? 'Waypoint set' : 'Waypoint set: working out the route…') : 'Waypoint cleared');
  };
  gps.setGraph(new RoadGraph(all.roads), carPos());
  traffic.setRoads(all.roads.filter((r) => isStreet(r) && !r.elev), all.signals, carPos().x, carPos().z);
  pedestrians.setRoads(all.roads.filter(hasPavement));
  traffic.walkers = pedestrians.positions;
  pedestrians.vehicles = traffic.positions;
  traffic.onHonk = (x, z, kind, pitch) => sound.honk(Math.hypot(x - carPos().x, z - carPos().z), kind, pitch);
  bigmap.setTiles([all]);
  const toggleMap = (open = !bigmap.open) => {
    if (open) hud.toggleMenu(false);
    bigmap.toggle(open, carPos());
    if (open && document.pointerLockElement) document.exitPointerLock();
  };
  keys.on('KeyM', () => toggleMap());
  // on the map, the controller's face buttons work the waypoint instead of the car
  keys.on('PadA', () => bigmap.open && bigmap.pickCentre());
  keys.on('KeyR', () => (bigmap.open ? toggleMap(false) : combat.onFoot ? combat.kick() : resetCar()));
  // held: the horn, read each frame. On foot it is the controller's X, which takes the stick and puts it back.
  keys.on('KeyH', () => (bigmap.open ? bigmap.onWaypoint(null) : combat.interact()));
  keys.on('KeyN', () => {
    daynight.toggle();
    headlights = null;
    hud.say(daynight.night > 0.5 ? 'Night' : 'Day');
  });
  keys.on('KeyT', () => {
    daynight.running = !daynight.running;
    hud.say(daynight.running ? 'Time running' : 'Time paused');
  });
  keys.on('Escape', () => (bigmap.open ? toggleMap(false) : hud.toggleMenu()));
  keys.onPadChange = (name) => {
    console.info(name ? `[controller] connected: ${name}` : '[controller] disconnected');
    hud.say(name ? `Controller connected: ${name}` : 'Controller disconnected');
  };
  // Browsers hide controllers from plain-http pages other than localhost (a phone or PC opening the dev server by IP).
  if (!window.isSecureContext) {
    console.warn(`[controller] blocked: ${location.origin} is not a secure page; controllers need https:// or localhost`);
    document.getElementById('hint')!.classList.add('warn');
    document.getElementById('hint')!.innerHTML = `<b>Controllers are blocked on this address</b> (${location.host}). Open the game over https:// or on localhost to use one.`;
  }
  document.getElementById('build')!.textContent = `Build ${__BUILD__}`;
  const padReport = document.getElementById('pad-report')!;
  setInterval(() => {
    if (hud.menuOpen) padReport.textContent = keys.padReport();
  }, 100);
  hud.bindTime(() => daynight.hour, (h) => {
    daynight.hour = h;
    headlights = null;
  });
  keys.on('KeyL', () => {
    headlights = !carLamps.on;
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
  // `cpu` is the part of each frame this page's own code takes (physics, and telling the graphics card what to
  // draw); the rest of the frame is the graphics card drawing it, or waiting for the screen.
  const perf = { fps: 0, ms: 0, worst: 0, frames: 0, time: 0, peak: 0, drawCalls: 0, triangles: 0, cpu: 0, busy: 0 };
  let last = performance.now();
  let lag = 0;
  /** the last place the car stood on land or road, where it is held if it runs into the water */
  const dry = new THREE.Vector2(start.x, start.z);
  /** the same for the player on foot */
  const dryFoot = new THREE.Vector3(start.x, 0, start.z);
  /** the car while the player is out of it: left where it stands with the handbrake on */
  const PARKED = { throttle: 0, steer: 0, handbrake: true };
  let roadTimer = 0;
  let firstFrame = true;
  let wasHonking = false;

  const governor = resolutionGovernor(renderer, quality);

  // Save progress every few seconds, and whenever the tab is hidden or closed.
  const snapshot = (): Progress => {
    const p = model.group.position;
    return {
      car: model.spec.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), heading: vehicle.heading, camera: director.mode,
      hour: daynight.hour, clockRunning: daynight.running, waypoint: gps.waypoint, headlights,
    };
  };
  let saving = true;
  const save = () => saving && saveProgress(snapshot());
  setInterval(save, 5000);
  document.addEventListener('visibilitychange', () => document.hidden && save());
  window.addEventListener('pagehide', save);

  // Menu: graphics quality (applied by reloading, which keeps your place) and starting over.
  const qualityRow = document.getElementById('quality-row')!;
  const chosen = savedQuality();
  for (const q of ['auto', ...QUALITY_NAMES] as (QualityName | 'auto')[]) {
    const b = document.createElement('button');
    b.textContent = q === 'auto' ? `Auto (${quality.name})` : q[0].toUpperCase() + q.slice(1);
    b.classList.toggle('active', q === chosen);
    b.addEventListener('click', () => {
      saveQuality(q);
      save();
      try {
        sessionStorage.setItem(RESUME, '1');
      } catch {
        // storage blocked: the title screen will ask
      }
      const url = new URL(location.href);
      url.searchParams.delete('q');
      location.replace(url);
    });
    qualityRow.append(b);
  }
  // Menu: which graphics card the browser is drawing on, and what to do when it is the wrong one.
  const otherCard = gpu.kind === 'integrated' && /Windows/.test(navigator.userAgent);
  const gpuAdvice =
    gpu.kind === 'software' ? 'No graphics card is in use: the browser is drawing on the processor, which is very slow. Turn on hardware (graphics) acceleration in the browser settings and restart it.'
    : otherCard ? 'This is the small graphics chip built into the processor. If this computer also has an NVIDIA or AMD card, Windows is keeping the browser off it: follow the steps below. A web page cannot make that choice itself.'
    : gpu.kind === 'integrated' ? 'This is the small graphics chip built into the processor, so the game starts on the Low preset.'
    : 'The game asks the browser for the fastest graphics card, and this is the one it was given.';
  document.getElementById('gpu-name')!.textContent = gpu.name || 'The browser will not say';
  document.getElementById('gpu-hint')!.textContent = gpuAdvice;
  // The steps themselves, for anyone on a computer: they are the same whichever card is in use now.
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'windows' : /Mac OS X/.test(ua) && !matchMedia('(pointer: coarse)').matches ? 'mac' : /Linux/.test(ua) && !/Android/.test(ua) ? 'linux' : null;
  if (os) {
    const [browser, exe] =
      'brave' in navigator ? ['Brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']
      : /Edg\//.test(ua) ? ['Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : /OPR\//.test(ua) ? ['Opera', '%LocalAppData%\\Programs\\Opera\\opera.exe']
      : /Firefox\//.test(ua) ? ['Firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe']
      : ['Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
    const intro: Record<string, string> = {
      windows: 'For laptops and PCs with two graphics cards (a built-in one and an NVIDIA or AMD one). Windows gives browsers the slow one unless told otherwise. With only one card there is nothing to change.',
      mac: 'For MacBooks with two graphics cards (older Intel models). Macs with Apple chips have one, and there is nothing to change.',
      linux: 'For laptops with two graphics cards (a built-in one and an NVIDIA or AMD one).',
    };
    const steps: Record<string, string[]> = {
      windows: [
        'Open Windows <b>Settings › System › Display › Graphics</b>.',
        `If ${browser} is not in the list of apps, choose <b>Add desktop app</b> (or <b>Browse</b>) and pick <code>${exe}</code>`,
        `Click ${browser} in the list, then <b>Options</b> (or the <b>GPU preference</b> menu), choose <b>High performance</b> and save.`,
        `Close every ${browser} window and open it again. The change only takes effect on a fresh start.`,
        'Come back to this menu: the card named above should now be the NVIDIA or AMD one. Then set the preset to Auto.',
        'On a laptop, plug in the charger: many slow the graphics card down on battery.',
      ],
      mac: [
        'Open <b>System Settings › Battery › Options</b> (older macOS: System Preferences › Battery).',
        'Turn <b>Automatic graphics switching</b> off.',
        `Quit ${browser} completely (Cmd+Q) and open it again.`,
        'Come back to this menu and check the card named above.',
      ],
      linux: [
        `Close every ${browser} window.`,
        `Start ${browser} on the fast card. NVIDIA: <code>__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia ${browser.toLowerCase()}</code> · AMD: <code>DRI_PRIME=1 ${browser.toLowerCase()}</code> (the command name may differ on your system).`,
        'Come back to this menu and check the card named above.',
      ],
    };
    const box = document.getElementById('gpu-steps') as HTMLDetailsElement;
    document.getElementById('gpu-steps-intro')!.textContent = intro[os];
    document.getElementById('gpu-steps-list')!.innerHTML = steps[os].map((t) => `<li>${t}</li>`).join('');
    box.hidden = false;
    box.open = otherCard; // already open for the people who most likely need it
  }

  document.getElementById('start-over')!.addEventListener('click', () => {
    saving = false;
    clearProgress();
    location.replace(location.pathname);
  });

  // Menu: music from a YouTube link, and the effects volume.
  const musicUrl = document.getElementById('music-url') as HTMLInputElement;
  const musicStatus = document.getElementById('music-status')!;
  const musicVolume = document.getElementById('music-volume') as HTMLInputElement;
  const sfxVolume = document.getElementById('sfx-volume') as HTMLInputElement;
  musicUrl.value = music.url;
  musicVolume.value = String(music.volume);
  sfxVolume.value = String(Math.round(sound.volume * 100));
  music.onStatus = (t) => (musicStatus.textContent = t);
  document.getElementById('music-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    musicUrl.blur();
    void music.play(musicUrl.value);
  });
  document.getElementById('music-stop')!.addEventListener('click', () => music.stop());
  musicVolume.addEventListener('input', () => music.setVolume(Number(musicVolume.value)));
  sfxVolume.addEventListener('input', () => sound.setVolume(Number(sfxVolume.value) / 100));

  // The car drawn once with its lights off and once with them on, behind the loading screen: the first draw builds
  // its shaders (half a second or more). Other cars are fetched later and readied in switchCar.
  setLoading('Getting the cars ready…', false, 0.96);
  {
    const here = model;
    const ahead = new THREE.Vector3();
    camera.getWorldDirection(ahead);
    for (const spec of CARS) {
      if (spec.id !== here.spec.id) continue;
      const m = await getModel(spec);
      scene.remove(model.group);
      scene.add(m.group);
      m.group.position.copy(camera.position).addScaledVector(ahead, 10);
      const culled: THREE.Object3D[] = [];
      m.group.traverse((o) => o.frustumCulled && culled.push(o));
      for (const o of culled) o.frustumCulled = false; // drawn in every pass, shadows included, wherever it is
      model = m;
      carLamps.attach(m);
      for (const on of [false, true]) {
        carLamps.set(on, on);
        pipeline.render();
        await new Promise(requestAnimationFrame);
      }
      for (const o of culled) o.frustumCulled = true;
    }
    scene.remove(model.group);
    model = here;
    scene.add(model.group);
    carLamps.attach(model);
    carLamps.set(false, false);
  }

  renderer.setAnimationLoop((now: number) => {
    const began = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    keys.poll();
    // right stick looks round, at about the speed of a brisk mouse drag
    if (keys.look.x || keys.look.y) director.turn(keys.look.x * dt * 700, keys.look.y * dt * 500);
    const speedBefore = vehicle.speed;
    const paused = hud.menuOpen || bigmap.open;
    lag += paused ? 0 : dt; // the Esc menu and the map pause the game
    if (bigmap.open) bigmap.steer(dt, keys.raw.x, keys.raw.y, keys.raw.rt, keys.raw.lt);
    const foot = combat.onFoot;
    const input = foot ? PARKED : keys.drive();
    let steps = 0;
    while (lag >= STEP && steps < 5) {
      previous.p.copy(current.p);
      previous.q.copy(current.q);
      vehicle.update(input, STEP);
      // the traffic keeps clear of the player, wherever they are
      const pv = foot ? combat.velocity : vehicle.body.linvel(), at = foot ? combat.player.pos : current.p;
      traffic.step(STEP, at.x, at.z, pv.x, pv.z);
      combat.step(STEP);
      stepWorld(world);
      combat.afterStep();
      readPose(current);
      // the sea is not a road: a car that runs off the land (or off the Sea Link) is stopped at the water's edge
      if (offRoadInWater(streamer.tiles, current.p.x, current.p.z)) {
        vehicle.place(dry.x, dry.y, vehicle.heading, deckHeight(streamer.tiles, dry.x, dry.y));
        tyreFx.reset();
        readPose(current);
        previous.p.copy(current.p);
      } else dry.set(current.p.x, current.p.z);
      lag -= STEP;
      steps++;
    }
    if (steps === 5) lag = 0;
    if (foot) {
      // nobody walks into the sea either
      const p = combat.player.pos;
      if (offRoadInWater(streamer.tiles, p.x, p.z)) combat.putPlayer(dryFoot.x, dryFoot.y, dryFoot.z);
      else if (combat.player.standing) dryFoot.copy(p);
    }
    // a sudden loss of speed is a hit: shake the controller in proportion
    const jolt = Math.abs(vehicle.speed - speedBefore);
    if (steps && jolt > 2.5) {
      keys.rumble(jolt / 12, 120 + jolt * 15);
      sound.crash(jolt);
    }
    sound.setPaused(paused);
    const honking = !bigmap.open && !foot && keys.held('KeyH');
    sound.setHorn(honking);
    if (honking && !wasHonking) {
      // the car in front makes way, people in the road hurry out of it
      const fx = Math.sin(vehicle.heading), fz = Math.cos(vehicle.heading);
      traffic.hornFrom(current.p.x, current.p.z, fx, fz);
      pedestrians.hornFrom(current.p.x, current.p.z, fx, fz);
    }
    wasHonking = honking;
    // tyres at their limit come through the controller as a light buzz, the anti-lock as a harder one
    if (steps && (vehicle.skid > 0.2 || vehicle.abs)) keys.rumble(Math.max(vehicle.skid * 0.35, vehicle.abs ? 0.3 : 0), 60);
    sound.update(dt, vehicle.speed, vehicle.wheelSpeed, input.throttle, vehicle.skid, foot ? combat.player.pos.distanceTo(current.p) : 0);
    tyreFx.update(paused ? 0 : dt, vehicle, !!model.lean);
    streamer.sync();
    {
      // the people on the pavement: a car that runs one down feels it
      const lv = vehicle.body.linvel(), p = current.p;
      const struck = pedestrians.update(paused ? 0 : dt, p.x, p.z, lv.x, lv.z, carPos().x, carPos().z);
      if (struck) {
        sound.crash(struck * 0.4);
        keys.rumble(0.4, 150);
      }
    }
    const blend = lag / STEP;
    model.group.position.lerpVectors(previous.p, current.p, blend);
    model.group.position.y += ROAD_HEIGHT;
    model.group.quaternion.slerpQuaternions(previous.q, current.q, blend);
    combat.update(paused ? 0 : dt, blend, keys.foot(), director.facing);
    // cars stop for anyone on foot in their lane: the people on the pavement, and whoever is out here fighting
    traffic.walkers = combat.obstacles.length ? [...pedestrians.positions, ...combat.obstacles] : pedestrians.positions;
    const here = carPos(), facing = foot ? director.facing : vehicle.heading;
    hud.setPrompt(paused ? '' : combat.prompt);
    if (foot) {
      hud.setHealth(combat.player.health / 100);
      hud.setHurt(paused ? 0 : dt, combat.player.health / 100);
    } else hud.setHurt(dt, 1);
    // where the car was left, for the maps
    const parked = foot ? { x: current.p.x, z: current.p.z, heading: vehicle.heading } : null;
    hud.setCarDistance(parked && Math.hypot(parked.x - here.x, parked.z - here.z));
    streamer.cull(here.x, here.z);

    const spec = model.spec;
    model.wheels.forEach((w, i) => {
      const n = w.follows ?? i;
      const length = vehicle.controller.wheelSuspensionLength(n) ?? restLength(spec);
      w.pivot.position.y = axleHeight(spec) - length + w.lift;
      // a bike's front wheel is held by a fork that is part of the body: it leans, and does not turn on its own
      w.pivot.rotation.y = model.lean ? 0 : (vehicle.controller.wheelSteering(n) ?? 0);
      w.spin.quaternion.setFromAxisAngle(axle, vehicle.wheelAngle[n]);
    });
    if (model.lean) {
      // a bike is leant into the corner by as much as would balance it
      // and laid over into a donut, where it is turning fast but hardly moving
      const turning = vehicle.body.angvel().y, sliding = Math.max(vehicle.wheelSlide[2], vehicle.wheelSlide[3]);
      const into = THREE.MathUtils.clamp(-Math.atan((vehicle.speed * turning) / 9.81) - THREE.MathUtils.clamp(turning * 0.18, -0.5, 0.5) * sliding, -0.8, 0.8);
      model.lean.rotation.z += (into - model.lean.rotation.z) * Math.min(1, dt * 6);
    }
    if (model.rider) model.rider.visible = !foot && director.mode !== 'cockpit';
    model.setBraking(vehicle.braking);
    if (!paused && vehicle.isFlipped && Math.abs(vehicle.speed) < 2) {
      const before = overTime;
      overTime += dt;
      if (before < 1.5 && overTime >= 1.5) hud.say('Rolled it. Press R (B on a controller) to get back on the road', 5000);
    } else if (!vehicle.isFlipped) overTime = 0;

    daynight.update(paused ? 0 : dt);
    if (gps.update(paused ? 0 : dt, here)) hud.say('You have arrived');
    hud.setWaypointDistance(gps.waypoint ? gps.length : null);
    if (bigmap.open) bigmap.render(here, facing, gps.route, gps.waypoint, gps.length, parked);
    const dark = daynight.night > 0.5;
    if (dark !== wasDark) {
      wasDark = dark;
      headlights = null;
    }
    carLamps.set(headlights ?? dark, vehicle.braking);
    traffic.setLights(dark);
    lampLights.update(dt, here);

    if (foot) director.updateOnFoot(dt, here, 1.75, (from, dir, reach) => combat.sight(from, dir, reach));
    else director.update(dt, model.group, vehicle, spec);
    shadows.follow(here);
    daynight.follow(camera.position);
    hud.update(vehicle.speed, here.x, here.z, facing, gps.route, gps.waypoint, parked);

    roadTimer -= dt;
    if (roadTimer <= 0) {
      roadTimer = 0.6;
      const p = here;
      const hit = nearestRoad(streamer.tiles, p.x, p.z, (r) => !!r.name && (isMajor(r) || isStreet(r)));
      void streamer.update(p.x, p.z);
      hud.setRegion(neighbourhood(p.x, p.z));
      hud.setRoad(hit && hit.distance < 25 ? hit.road.name! : '');
    }

    pipeline.render();
    governor(dt, performance.now() - began);

    if (firstFrame) {
      firstFrame = false;
      hideLoading();
      prefetchNext();
      // the people who can be fought, drawn once out of sight: nobody waits for shaders at the first punch
      void combat.ready.then(() => renderer.compileAsync(combat.warm, camera, scene)).catch((err) => console.warn('Figures not readied', err));
      if (gpu.kind === 'software' || otherCard) hud.say(`Drawing on ${gpu.name}: slow graphics. Esc › Graphics says how to use a faster card.`, 9000);
    }
    perf.frames++;
    perf.time += dt;
    perf.peak = Math.max(perf.peak, dt);
    perf.busy += performance.now() - began;
    if (perf.time >= 0.5) {
      perf.fps = perf.frames / perf.time;
      perf.ms = (perf.time / perf.frames) * 1000;
      perf.worst = perf.peak * 1000;
      perf.cpu = perf.busy / perf.frames;
      perf.frames = perf.time = perf.peak = perf.busy = 0;
      perf.drawCalls = renderer.info.render.drawCalls;
      perf.triangles = renderer.info.render.triangles;
      hud.setStats(
        `<b>${perf.fps.toFixed(0)}</b> fps  ${perf.ms.toFixed(1)} ms  worst ${perf.worst.toFixed(0)} ms  (game code ${perf.cpu.toFixed(1)} ms)\n` +
          `${gpu.name || 'unknown graphics card'}\n` +
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
      traffic,
      pedestrians,
      combat,
      debug: { THREE, scene, sun, renderer, camera, director },
      get vehicle() {
        return vehicle;
      },
      get car() {
        return model.spec.id;
      },
      setCamera,
      daynight,
      gps,
      waypoint: (x: number, z: number) => bigmap.onWaypoint([x, z]),
      toggleMap,
      switchCar,
      place: (x: number, z: number, headingDeg: number) => {
        void streamer.update(x, z);
        vehicle.place(x, z, THREE.MathUtils.degToRad(headingDeg), deckHeight(streamer.tiles, x, z));
        readPose(current);
        readPose(previous);
        director.cut();
      },
      state: () => {
        const p = vehicle.body.translation();
        return {
          onFoot: combat.onFoot, health: Math.round(combat.player.health),
          car: model.spec.id, camera: director.mode, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
          hour: +daynight.hour.toFixed(2), night: +daynight.night.toFixed(2),
          heading: +THREE.MathUtils.radToDeg(vehicle.heading).toFixed(1), kmh: +(vehicle.speed * 3.6).toFixed(1), flipped: vehicle.isFlipped,
          fps: +perf.fps.toFixed(1), ms: +perf.ms.toFixed(2), cpuMs: +perf.cpu.toFixed(2), backend: backendName(renderer), gpu: gpu.name, quality: quality.name,
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

import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from '../camera/director.ts';
import type { Tile } from '../world/tile.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Metres of map across the minimap. */
const MINIMAP_SPAN = 320;
/** Pixels per metre in the pre-drawn map. */
const MAP_SCALE = 1.25;
/** A cell's roads and parks run past its edge; its map piece is drawn that much bigger so they are not cut off. */
const MAP_PAD = 300;

interface MapPiece {
  canvas: HTMLCanvasElement;
  minX: number;
  minZ: number;
}

function drawMap(tile: Tile): MapPiece {
  const { maxX, maxZ } = tile.bounds;
  const minX = tile.bounds.minX - MAP_PAD, minZ = tile.bounds.minZ - MAP_PAD;
  const c = document.createElement('canvas');
  c.width = Math.ceil((maxX + MAP_PAD - minX) * MAP_SCALE);
  c.height = Math.ceil((maxZ + MAP_PAD - minZ) * MAP_SCALE);
  const g = c.getContext('2d')!;
  g.scale(MAP_SCALE, MAP_SCALE);
  g.translate(-minX, -minZ);
  // background only under the cell itself, so the padding never paints over a neighbour
  g.fillStyle = '#2a2d2f';
  g.fillRect(tile.bounds.minX, tile.bounds.minZ, maxX - tile.bounds.minX, maxZ - tile.bounds.minZ);
  const fill = (ring: number[], colour: string) => {
    g.beginPath();
    for (let i = 0; i < ring.length; i += 2) g.lineTo(ring[i], ring[i + 1]);
    g.closePath();
    g.fillStyle = colour;
    g.fill();
  };
  for (const a of tile.areas) fill(a.outer, a.kind === 'water' ? '#3f6f8f' : '#35553a');
  for (const b of tile.buildings) fill(b.outer, '#43474a');
  g.lineCap = g.lineJoin = 'round';
  // minor roads first, so the main roads read on top
  for (const major of [false, true]) {
    for (const r of tile.roads) {
      if ((r.width >= 8) !== major) continue;
      g.beginPath();
      for (let i = 0; i < r.pts.length; i += 2) g.lineTo(r.pts[i], r.pts[i + 1]);
      g.strokeStyle = major ? '#e6e2d6' : '#8d9093';
      g.lineWidth = Math.max(r.width, 4);
      g.stroke();
    }
  }
  return { canvas: c, minX, minZ };
}

export class Hud {
  private speed = $('speed');
  private gear = $('gear');
  private road = $('road');
  private stats = $('stats');
  private carSwitch = $('car-switch');
  private credit = $('credit');
  private toast = $('toast');
  private buttons = new Map<CameraMode, HTMLButtonElement>();
  private maps = new Map<string, MapPiece>();
  private mini: CanvasRenderingContext2D;
  private attribution: string;
  private toastTimer = 0;
  private lastRoad = '';

  constructor(attribution: string, onCamera: (mode: CameraMode) => void, onSwitchCar: () => void) {
    this.attribution = attribution;
    this.mini = (document.querySelector('#minimap canvas') as HTMLCanvasElement).getContext('2d')!;
    const bar = $('cameras');
    CAMERA_MODES.forEach((mode, i) => {
      const b = document.createElement('button');
      b.innerHTML = `<kbd>${i + 1}</kbd>${CAMERA_LABELS[mode]}`;
      b.addEventListener('click', () => {
        onCamera(mode);
        b.blur(); // keep the arrow keys driving the car, not the button row
      });
      bar.append(b);
      this.buttons.set(mode, b);
    });
    this.carSwitch.addEventListener('click', () => {
      onSwitchCar();
      this.carSwitch.blur();
    });
    setTimeout(() => $('hint').classList.add('faded'), 12000);
    $('resume').addEventListener('click', () => this.toggleMenu(false));
  }

  private menu = $('menu');
  /** Esc: controls, camera, car, clock and frame rate, all off the driving screen. The game pauses while it is open. */
  get menuOpen() {
    return this.menu.classList.contains('open');
  }

  toggleMenu(open = !this.menuOpen) {
    this.menu.classList.toggle('open', open);
    this.menu.setAttribute('aria-hidden', String(!open));
    if (!open) (document.getElementById('view') as HTMLCanvasElement).focus();
  }

  /** The menu's time-of-day slider drives the clock, and follows it. */
  bindTime(get: () => number, set: (hour: number) => void) {
    const slider = $<HTMLInputElement>('time-slider');
    slider.addEventListener('input', () => set(Number(slider.value)));
    const label = $('time-label');
    const show = () => {
      const h = get();
      if (document.activeElement !== slider) slider.value = String(h);
      label.textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
    };
    show();
    setInterval(() => this.menuOpen && show(), 200);
  }

  setCamera(mode: CameraMode) {
    for (const [m, b] of this.buttons) b.classList.toggle('active', m === mode);
    document.body.classList.toggle('cinematic', mode === 'cinematic');
  }

  setCar(name: string, credit: string) {
    this.carSwitch.innerHTML = `<kbd>V</kbd>${name}`;
    this.credit.textContent = `Map data ${this.attribution}. ${credit ? `Car model: ${credit}.` : ''}`;
  }

  private region = $('region');
  setRegion(name: string) {
    const text = name === 'Central Delhi' ? 'Central Delhi' : `${name} · Central Delhi`;
    if (this.region.textContent !== text) this.region.textContent = text;
  }

  setRoad(name: string) {
    if (name === this.lastRoad) return;
    this.lastRoad = name;
    this.road.textContent = name || '\u00a0';
  }

  say(text: string) {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 2200);
  }

  /** The minimap holds a piece for each map cell that is loaded. */
  addCell(key: string, tile: Tile) {
    this.maps.set(key, drawMap(tile));
  }

  removeCell(key: string) {
    this.maps.delete(key);
  }

  setStats(html: string) {
    this.stats.innerHTML = html;
  }

  update(speed: number, x: number, z: number, heading: number) {
    const kmh = Math.abs(speed) * 3.6;
    this.speed.textContent = String(Math.round(kmh));
    this.gear.textContent = kmh < 1 ? 'N' : speed < 0 ? 'R' : 'D';

    const g = this.mini;
    const size = g.canvas.width;
    const scale = size / MINIMAP_SPAN;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#202224';
    g.fillRect(0, 0, size, size);
    // The car sits a little below centre and always points up; the map turns under it.
    g.translate(size / 2, size * 0.6);
    g.rotate(heading - Math.PI);
    g.scale(scale / MAP_SCALE, scale / MAP_SCALE);
    for (const m of this.maps.values()) {
      // only the pieces near enough to show
      if (Math.abs(m.minX + m.canvas.width / MAP_SCALE / 2 - x) > 1200 || Math.abs(m.minZ + m.canvas.height / MAP_SCALE / 2 - z) > 1200) continue;
      g.drawImage(m.canvas, (m.minX - x) * MAP_SCALE, (m.minZ - z) * MAP_SCALE);
    }
    g.setTransform(1, 0, 0, 1, size / 2, size * 0.6);
    g.beginPath();
    g.moveTo(0, -15);
    g.lineTo(10, 11);
    g.lineTo(0, 5);
    g.lineTo(-10, 11);
    g.closePath();
    g.fillStyle = '#ffb347';
    g.strokeStyle = '#111';
    g.lineWidth = 2.5;
    g.stroke();
    g.fill();
  }
}

const TIPS = [
  'Connaught Place is two rings of white Georgian colonnades round a park, built in the 1930s.',
  'The tricolour over Central Park flies on a 63 m mast. You can see it from every radial road.',
  'Press N for night: the sodium lamps, shop signs and office windows all come on.',
  'Drag with the mouse to look round, and use the wheel to pull the chase camera back.',
  'Bins, barricades and parked autos all move when you hit them. Trees and lamp posts do not.',
  'India Gate stands 42 m tall at the east end of Kartavya Path.',
  'Lutyens\' Delhi: white bungalows behind deep lawns, and red and buff sandstone ministries.',
  'Esc pauses the game and opens the controls, the clock and the frame rate.',
];

/** A strip of Delhi roofline for the loading screen: walk-ups, water tanks, a dome, a tower or two. */
function skyline(seed: number, colour: string, height: number) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const w = 1200;
  let x = 0, d = '';
  while (x < w) {
    const bw = 30 + rnd() * 70, bh = height * (0.25 + rnd() * 0.55);
    d += `M${x} ${height}V${height - bh}H${x + bw}V${height}Z`;
    if (rnd() < 0.35) d += `M${x + bw * 0.3} ${height - bh}v-9h10v9Z`; // water tank
    if (rnd() < 0.08) d += `M${x + bw / 2 - 18} ${height - bh}a18 18 0 0 1 36 0Z`; // dome
    if (rnd() < 0.06) d += `M${x + bw * 0.4} ${height - bh}V${height - bh - height * 0.3}h${bw * 0.25}V${height - bh}Z`; // tower
    x += bw + rnd() * 6;
  }
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${height}' preserveAspectRatio='none'><path fill='${colour}' d='${d}'/></svg>`)}")`;
}

let tipTimer = 0;
function startLoadingScreen() {
  $('skyline-far').style.backgroundImage = skyline(7, '#3a2236', 200);
  $('skyline-near').style.backgroundImage = skyline(91, '#1b1220', 160);
  const tip = $('loading-tip');
  let i = Math.floor(Math.random() * TIPS.length);
  const next = () => {
    tip.style.opacity = '0';
    setTimeout(() => {
      tip.textContent = TIPS[i++ % TIPS.length];
      tip.style.opacity = '1';
    }, 400);
  };
  next();
  tipTimer = window.setInterval(next, 4500);
}
startLoadingScreen();

/** `progress` is 0 to 1; left out, the bar stays where it is. */
export function setLoading(text: string, error = false, progress?: number) {
  const el = $('loading-text');
  el.textContent = text;
  el.classList.toggle('error', error);
  if (progress !== undefined) $('loading-bar').style.width = `${Math.round(Math.max(0.04, progress) * 100)}%`;
}

export function hideLoading() {
  $('loading-bar').style.width = '100%';
  setTimeout(() => {
    $('loading').classList.add('done');
    clearInterval(tipTimer);
  }, 350);
}

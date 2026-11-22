import type { Grid, Tile } from '../world/tile.ts';
import { NEIGHBOURHOODS } from '../world/landmarks.ts';
import { ROUTE_COLOUR, drawTiles } from './hud.ts';

/** Pixels per metre of the pre-drawn whole-city image; zooming in past it just enlarges. */
const BAKED = 0.6;

/**
 * The pause map (M): the whole of central Delhi, where a click (or the controller's A on the crosshair)
 * drops a waypoint for the GPS. Drag or left stick to pan, wheel or triggers to zoom, right-click or X to clear.
 */
export class BigMap {
  /** called with the new waypoint, or null when it is cleared */
  onWaypoint: (p: [number, number] | null) => void = () => {};
  private root: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private image: HTMLCanvasElement | null = null;
  private grid: Grid;
  private cx = 0;
  private cz = 0;
  /** screen pixels per metre */
  private zoom = 0.3;
  private mouse: [number, number] | null = null;

  constructor(grid: Grid) {
    this.grid = grid;
    this.root = document.getElementById('bigmap')!;
    const canvas = this.root.querySelector('canvas')!;
    this.ctx = canvas.getContext('2d')!;

    const list = document.getElementById('bigmap-places')!;
    for (const [name, x, z] of NEIGHBOURHOODS) {
      const b = document.createElement('button');
      b.textContent = name;
      b.addEventListener('click', () => {
        this.cx = x;
        this.cz = z;
        this.onWaypoint([x, z]);
      });
      list.append(b);
    }

    let drag: { x: number; y: number; moved: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      this.mouse = [e.clientX, e.clientY];
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      this.cx -= dx / this.zoom;
      this.cz -= dy / this.zoom;
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.onWaypoint(this.toWorld(e.clientX, e.clientY));
      drag = null;
    });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onWaypoint(null);
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
    window.addEventListener('resize', () => this.fit());
  }

  /** The whole map's roads and parks, drawn once the GPS has them. */
  setTiles(tiles: Tile[]) {
    const b = this.grid.bounds;
    // browsers refuse canvases much past 4096 px a side
    this.image = drawTiles(tiles, b, Math.min(BAKED, 4096 / Math.max(b.maxX - b.minX, b.maxZ - b.minZ)));
  }

  get open() {
    return this.root.classList.contains('open');
  }

  toggle(open: boolean, car?: { x: number; z: number }) {
    this.root.classList.toggle('open', open);
    this.root.setAttribute('aria-hidden', String(!open));
    if (open && car) {
      this.fit();
      this.cx = car.x;
      this.cz = car.z;
    }
    if (!open) (document.getElementById('view') as HTMLCanvasElement).focus();
  }

  /** Controller: the left stick slides the map under the crosshair, the triggers zoom. */
  steer(dt: number, x: number, y: number, zoomIn: number, zoomOut: number) {
    this.cx += (x * 900 * dt) / this.zoom;
    this.cz += (y * 900 * dt) / this.zoom;
    if (zoomIn || zoomOut) this.zoomAt(Math.exp((zoomIn - zoomOut) * 2 * dt), innerWidth / 2, innerHeight / 2);
  }

  /** Controller A: waypoint under the crosshair. */
  pickCentre() {
    this.onWaypoint([this.cx, this.cz]);
  }

  private fit() {
    const c = this.ctx.canvas, dpr = Math.min(2, devicePixelRatio);
    c.width = innerWidth * dpr;
    c.height = innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private zoomAt(k: number, sx: number, sy: number) {
    const [wx, wz] = this.toWorld(sx, sy);
    this.zoom = Math.min(4, Math.max(0.08, this.zoom * k));
    // keep the point under the cursor where it is
    this.cx = wx - (sx - innerWidth / 2) / this.zoom;
    this.cz = wz - (sy - innerHeight / 2) / this.zoom;
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - innerWidth / 2) / this.zoom, this.cz + (sy - innerHeight / 2) / this.zoom];
  }

  render(car: { x: number; z: number }, heading: number, route: number[] | null, waypoint: [number, number] | null, routeLength: number | null) {
    const g = this.ctx, w = innerWidth, h = innerHeight;
    const b = this.grid.bounds;
    this.cx = Math.min(b.maxX, Math.max(b.minX, this.cx));
    this.cz = Math.min(b.maxZ, Math.max(b.minZ, this.cz));
    const sx = (x: number) => w / 2 + (x - this.cx) * this.zoom;
    const sy = (z: number) => h / 2 + (z - this.cz) * this.zoom;
    g.fillStyle = '#16181a';
    g.fillRect(0, 0, w, h);
    if (this.image) {
      g.imageSmoothingEnabled = this.zoom < (this.image.width / (b.maxX - b.minX)) * 1.5;
      g.drawImage(this.image, sx(b.minX), sy(b.minZ), (b.maxX - b.minX) * this.zoom, (b.maxZ - b.minZ) * this.zoom);
    } else {
      g.fillStyle = '#9aa0a6';
      g.font = '14px -apple-system, sans-serif';
      g.textAlign = 'center';
      g.fillText('Drawing the map…', w / 2, h / 2);
    }

    // neighbourhood names
    g.textAlign = 'center';
    g.font = `600 ${Math.round(11 + this.zoom * 6)}px -apple-system, "Segoe UI", sans-serif`;
    for (const [name, x, z] of NEIGHBOURHOODS) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(name.toUpperCase(), sx(x) + 1, sy(z) + 1);
      g.fillStyle = 'rgba(255,236,205,0.85)';
      g.fillText(name.toUpperCase(), sx(x), sy(z));
    }

    if (route) {
      g.beginPath();
      for (let i = 0; i < route.length; i += 2) g.lineTo(sx(route[i]), sy(route[i + 1]));
      g.lineCap = g.lineJoin = 'round';
      g.strokeStyle = ROUTE_COLOUR;
      g.lineWidth = Math.max(3, 7 * this.zoom);
      g.stroke();
    }
    if (waypoint) {
      const x = sx(waypoint[0]), y = sy(waypoint[1]);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x - 11, y - 20);
      g.arc(x, y - 24, 12, Math.PI * 0.8, Math.PI * 0.2);
      g.closePath();
      g.fillStyle = ROUTE_COLOUR;
      g.strokeStyle = '#fff';
      g.lineWidth = 2.5;
      g.stroke();
      g.fill();
    }

    // the car, pointing the way it faces
    g.save();
    g.translate(sx(car.x), sy(car.z));
    g.rotate(Math.PI - heading);
    g.beginPath();
    g.moveTo(0, -13);
    g.lineTo(9, 10);
    g.lineTo(0, 4);
    g.lineTo(-9, 10);
    g.closePath();
    g.fillStyle = '#ffb347';
    g.strokeStyle = '#111';
    g.lineWidth = 2.5;
    g.stroke();
    g.fill();
    g.restore();

    // crosshair, for the controller
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(w / 2 - 12, h / 2);
    g.lineTo(w / 2 + 12, h / 2);
    g.moveTo(w / 2, h / 2 - 12);
    g.lineTo(w / 2, h / 2 + 12);
    g.stroke();

    const info = document.getElementById('bigmap-route')!;
    info.textContent = routeLength === null ? (waypoint ? 'No road route to there' : 'No waypoint set') : `Route ${routeLength < 1000 ? `${Math.round(routeLength)} m` : `${(routeLength / 1000).toFixed(1)} km`}`;
    if (this.mouse) {
      const [mx, mz] = this.toWorld(...this.mouse);
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.font = '11px ui-monospace, Menlo, monospace';
      g.textAlign = 'right';
      g.fillText(`x ${mx.toFixed(0)}  z ${mz.toFixed(0)}`, w - 16, h - 16);
    }
  }
}

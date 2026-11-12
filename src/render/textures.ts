import * as THREE from 'three/webgpu';
import { mulberry32 } from '../util.ts';

// Every surface texture is painted on a canvas at start-up. Phase 0 ships no image assets,
// which keeps the download small while the look is still being judged.

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

let anisotropy = 8;
export function setAnisotropy(a: number) {
  anisotropy = a;
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

/** Per-pixel grain: the cheapest way to stop a flat colour looking like plastic. */
function grain(g: Ctx, w: number, h: number, amount: number, seed: number) {
  const rnd = mulberry32(seed);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** Soft blotches that wrap at the edges, so the tile repeats without a seam. */
function blotches(g: Ctx, w: number, h: number, count: number, colour: string, maxR: number, alpha: number, seed: number) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = (0.25 + rnd() * 0.75) * maxR;
    for (const ox of [-w, 0, w]) {
      for (const oy of [-h, 0, h]) {
        if (x + ox + r < 0 || x + ox - r > w || y + oy + r < 0 || y + oy - r > h) continue;
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, colour);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalAlpha = alpha * (0.4 + rnd() * 0.6);
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  g.globalAlpha = 1;
}

export function asphaltTexture() {
  const s = 1024;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#45464a';
  g.fillRect(0, 0, s, s);
  blotches(g, s, s, 40, '#5a5a5c', 190, 0.35, 11);
  blotches(g, s, s, 30, '#2c2d30', 150, 0.4, 12);
  blotches(g, s, s, 14, '#1c1c1e', 60, 0.5, 13); // oil
  const rnd = mulberry32(14);
  // patched repairs, the signature of a Delhi road
  for (let i = 0; i < 2; i++) {
    g.fillStyle = `rgba(${34 + rnd() * 12},${34 + rnd() * 12},${37 + rnd() * 12},0.22)`;
    g.fillRect(rnd() * s, rnd() * s, 80 + rnd() * 160, 50 + rnd() * 90);
  }
  g.strokeStyle = 'rgba(18,18,20,0.28)';
  for (let i = 0; i < 7; i++) {
    g.lineWidth = 0.6 + rnd() * 0.8;
    g.beginPath();
    let x = rnd() * s;
    let y = rnd() * s;
    g.moveTo(x, y);
    for (let k = 0; k < 9; k++) {
      x += (rnd() - 0.5) * 70;
      y += (rnd() - 0.5) * 70;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  grain(g, s, s, 15, 15);
  return tex(c);
}

export function pavementTexture() {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#a39c8f';
  g.fillRect(0, 0, s, s);
  const rnd = mulberry32(21);
  const n = 8;
  const p = s / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 150 + rnd() * 26;
      g.fillStyle = `rgb(${v + 6},${v},${v - 12})`;
      g.fillRect(x * p + 1.5, y * p + 1.5, p - 3, p - 3);
    }
  }
  blotches(g, s, s, 26, '#5d564b', 90, 0.3, 22);
  grain(g, s, s, 12, 23);
  return tex(c);
}

export function groundTexture() {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#8f8676';
  g.fillRect(0, 0, s, s);
  blotches(g, s, s, 40, '#a59a84', 120, 0.4, 31);
  blotches(g, s, s, 40, '#6f685c', 110, 0.35, 32);
  grain(g, s, s, 16, 33);
  return tex(c);
}

export function grassTexture() {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#566f37';
  g.fillRect(0, 0, s, s);
  blotches(g, s, s, 50, '#6d8a40', 90, 0.45, 41);
  blotches(g, s, s, 40, '#3f5529', 90, 0.4, 42);
  blotches(g, s, s, 16, '#8a8052', 70, 0.35, 43); // worn, dry patches
  grain(g, s, s, 20, 44);
  return tex(c);
}

/** Draws one leaf: a pointed oval with a lighter midrib. */
function leaf(g: Ctx, x: number, y: number, len: number, wid: number, angle: number, fill: string) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.beginPath();
  g.moveTo(-len / 2, 0);
  g.quadraticCurveTo(0, -wid, len / 2, 0);
  g.quadraticCurveTo(0, wid, -len / 2, 0);
  g.fillStyle = fill;
  g.fill();
  g.strokeStyle = 'rgba(230,240,190,0.25)';
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(-len / 2, 0);
  g.lineTo(len / 2, 0);
  g.stroke();
  g.restore();
}

/** The dense inner crown: overlapping leaves with dark gaps between them, so the canopy reads as foliage up close. */
export function leafTexture() {
  const s = 256;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#3c4a2c';
  g.fillRect(0, 0, s, s);
  const rnd = mulberry32(51);
  for (let i = 0; i < 1500; i++) {
    const l = 26 + rnd() * 34;
    const x = rnd() * s, y = rnd() * s;
    // wrap round the edges so the texture tiles
    for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) {
      if (ox && Math.abs(x + ox - s / 2) > s / 2 + 12) continue;
      if (oy && Math.abs(y + oy - s / 2) > s / 2 + 12) continue;
      leaf(g, x + ox, y + oy, 9 + rnd() * 9, 3 + rnd() * 3, rnd() * Math.PI * 2, `hsl(${78 + rnd() * 30},${30 + rnd() * 25}%,${l}%)`);
    }
  }
  grain(g, s, s, 10, 53);
  return tex(c);
}

/** A loose spray of leaves on a clear ground, for the cards that give each canopy a ragged edge. */
export function leafCardTexture() {
  const s = 256;
  const [c, g] = canvas(s, s);
  const rnd = mulberry32(52);
  // twigs first, leaves over them
  g.strokeStyle = 'rgba(70,52,36,0.9)';
  for (let i = 0; i < 7; i++) {
    g.lineWidth = 1 + rnd() * 1.5;
    g.beginPath();
    g.moveTo(s / 2, s / 2);
    const a = rnd() * Math.PI * 2;
    g.lineTo(s / 2 + Math.cos(a) * 100, s / 2 + Math.sin(a) * 100);
    g.stroke();
  }
  // leaves gather in a few clumps, big enough to keep their shape when the card is small on screen
  const clumps = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + rnd() * 0.6, r = i === 0 ? 0 : 38 + rnd() * 34;
    return [s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, 46 + rnd() * 18];
  });
  for (let i = 0; i < 330; i++) {
    const [cx, cy, cr] = clumps[i % clumps.length];
    const r = Math.sqrt(rnd()) * cr, a = rnd() * Math.PI * 2;
    const l = 28 + rnd() * 30 - (r / cr) * 6;
    leaf(g, cx + Math.cos(a) * r, cy + Math.sin(a) * r, 20 + rnd() * 14, 7 + rnd() * 5, rnd() * Math.PI * 2, `hsl(${80 + rnd() * 28},${32 + rnd() * 28}%,${l}%)`);
  }
  const t = tex(c, true, false);
  t.generateMipmaps = true;
  return t;
}

export function barkTexture() {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#5b4a3a';
  g.fillRect(0, 0, 128, 256);
  const rnd = mulberry32(61);
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '30,24,18' : '130,112,92'},${0.15 + rnd() * 0.3})`;
    g.fillRect(rnd() * 128, 0, 1 + rnd() * 3, 256);
  }
  grain(g, 128, 256, 14, 62);
  return tex(c);
}

export interface Facade {
  map: THREE.Texture;
  /** green = roughness, blue = metalness: glass comes out mirror-like, plaster stays matt */
  orm: THREE.Texture;
  /** metres covered by one repeat of the texture */
  width: number;
  height: number;
  bays: number;
  floors: number;
  /** lit windows and shop signs, for night: black where the wall is dark */
  glow: THREE.Texture;
}

const WINDOW_LIGHTS = ['#ffd9a0', '#ffe7c2', '#fff2dc', '#dfe9ff', '#ffc98a'];

interface Painter {
  bays: number;
  floors: number;
  bayWidth: number;
  floorHeight: number;
  wall: (g: Ctx, w: number, h: number) => void;
  /** paints one bay; `glass(x, y, w, h)` marks a reflective pane */
  cell: (g: Ctx, x: number, y: number, w: number, h: number, glass: (x: number, y: number, w: number, h: number, tint?: string) => void, rnd: () => number) => void;
  wallRoughness?: number;
}

function buildFacade(p: Painter, seed: number): Facade {
  const cw = 128;
  const ch = 136;
  const w = cw * p.bays;
  const h = ch * p.floors;
  const [c, g] = canvas(w, h);
  const [oc, og] = canvas(w, h);
  const [ec, eg] = canvas(w, h);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, w, h);
  // its own random stream, so which windows are lit leaves the daytime look as it was
  const lights = mulberry32(seed + 9);
  const rough = Math.round((p.wallRoughness ?? 0.9) * 255);
  og.fillStyle = `rgb(255,${rough},0)`;
  og.fillRect(0, 0, w, h);
  p.wall(g, w, h);
  const rnd = mulberry32(seed);
  const glass = (x: number, y: number, gw: number, gh: number, tint?: string) => {
    const lit = rnd();
    const grad = g.createLinearGradient(x, y, x + gw * 0.4, y + gh);
    grad.addColorStop(0, tint ?? (lit < 0.2 ? '#56616b' : '#2c3a45'));
    grad.addColorStop(1, lit < 0.2 ? '#3a444d' : '#141c23');
    g.fillStyle = grad;
    g.fillRect(x, y, gw, gh);
    // drawn curtains and blinds break up the mirror
    if (rnd() < 0.3) {
      g.fillStyle = `rgba(${200 + rnd() * 40},${190 + rnd() * 40},${160 + rnd() * 50},0.55)`;
      g.fillRect(x, y, gw, gh * (0.25 + rnd() * 0.6));
    }
    og.fillStyle = 'rgb(255,26,235)';
    og.fillRect(x, y, gw, gh);
    if (lights() < 0.42) {
      const lg = eg.createLinearGradient(x, y, x, y + gh);
      const c0 = WINDOW_LIGHTS[Math.floor(lights() * WINDOW_LIGHTS.length)];
      lg.addColorStop(0, c0);
      lg.addColorStop(1, `rgba(120,80,40,${0.5 + lights() * 0.4})`);
      eg.globalAlpha = 0.45 + lights() * 0.55;
      eg.fillStyle = lg;
      eg.fillRect(x, y, gw, gh);
      eg.globalAlpha = 1;
    }
  };
  for (let fy = 0; fy < p.floors; fy++) {
    for (let bx = 0; bx < p.bays; bx++) p.cell(g, bx * cw, fy * ch, cw, ch, glass, rnd);
  }
  grain(g, w, h, 7, seed + 1);
  return { map: tex(c), orm: tex(oc, false), glow: tex(ec), width: p.bays * p.bayWidth, height: p.floors * p.floorHeight, bays: p.bays, floors: p.floors };
}

function stains(g: Ctx, w: number, h: number, seed: number, strength: number) {
  const rnd = mulberry32(seed);
  for (let i = 0; i < 26; i++) {
    const x = rnd() * w;
    const len = 30 + rnd() * 120;
    const y = rnd() * h;
    const grad = g.createLinearGradient(0, y, 0, y + len);
    grad.addColorStop(0, `rgba(45,40,34,${strength * (0.3 + rnd() * 0.7)})`);
    grad.addColorStop(1, 'rgba(45,40,34,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, 3 + rnd() * 14, len);
  }
}

/** White rendered Georgian blocks with tall shuttered windows: Connaught Place. */
export function colonialFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 2, bayWidth: 3.6, floorHeight: 4.6,
      wall(g, w, h) {
        g.fillStyle = '#e9e5da';
        g.fillRect(0, 0, w, h);
        blotches(g, w, h, 24, '#bdb6a6', 90, 0.3, 71);
        stains(g, w, h, 72, 0.16);
      },
      cell(g, x, y, w, h, glass) {
        // cornice and string course
        g.fillStyle = '#f4f1e8';
        g.fillRect(x, y, w, 9);
        g.fillStyle = 'rgba(60,55,45,0.35)';
        g.fillRect(x, y + 9, w, 3);
        // pilasters
        g.fillStyle = '#f1eee4';
        g.fillRect(x, y + 12, 12, h - 12);
        g.fillStyle = 'rgba(60,55,45,0.22)';
        g.fillRect(x + 12, y + 12, 3, h - 12);
        // tall window with a surround
        const wx = x + 40;
        const ww = w - 62;
        const wy = y + 30;
        const wh = h - 52;
        g.fillStyle = '#f6f3ea';
        g.fillRect(wx - 6, wy - 6, ww + 12, wh + 12);
        g.fillStyle = 'rgba(40,36,30,0.3)';
        g.fillRect(wx - 6, wy + wh + 6, ww + 12, 4);
        glass(wx, wy, ww, wh);
        g.strokeStyle = '#d9d5c8';
        g.lineWidth = 3;
        g.strokeRect(wx, wy, ww, wh);
        g.beginPath();
        g.moveTo(wx + ww / 2, wy);
        g.lineTo(wx + ww / 2, wy + wh);
        g.moveTo(wx, wy + wh * 0.33);
        g.lineTo(wx + ww, wy + wh * 0.33);
        g.stroke();
      },
    },
    70,
  );
}

/** Banded concrete offices: Barakhamba Road and Kasturba Gandhi Marg. */
export function officeFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 4, bayWidth: 3.2, floorHeight: 3.4,
      wall(g, w, h) {
        g.fillStyle = '#b8ad9a';
        g.fillRect(0, 0, w, h);
        blotches(g, w, h, 30, '#8f8676', 100, 0.3, 81);
        stains(g, w, h, 82, 0.28);
      },
      cell(g, x, y, w, h, glass, rnd) {
        g.fillStyle = 'rgba(50,45,38,0.3)';
        g.fillRect(x, y + h - 4, w, 4);
        glass(x + 8, y + 26, w - 16, h - 66);
        g.strokeStyle = '#6e6a63';
        g.lineWidth = 2.5;
        g.strokeRect(x + 8, y + 26, w - 16, h - 66);
        g.beginPath();
        g.moveTo(x + w / 2, y + 26);
        g.lineTo(x + w / 2, y + h - 40);
        g.stroke();
        if (rnd() < 0.35) {
          // window air conditioner with its rust streak
          g.fillStyle = '#d5d2c8';
          g.fillRect(x + w / 2 - 15, y + h - 38, 30, 20);
          g.fillStyle = '#8e8b83';
          g.fillRect(x + w / 2 - 12, y + h - 35, 24, 3);
          g.fillRect(x + w / 2 - 12, y + h - 29, 24, 3);
          g.fillStyle = 'rgba(90,60,35,0.3)';
          g.fillRect(x + w / 2 - 4, y + h - 18, 6, 18);
        }
      },
    },
    80,
  );
}

/** Curtain-wall towers. */
export function glassFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 4, bayWidth: 3, floorHeight: 3.6, wallRoughness: 0.45,
      wall(g, w, h) {
        g.fillStyle = '#4b5258';
        g.fillRect(0, 0, w, h);
      },
      cell(_g, x, y, w, h, glass, rnd) {
        const t = rnd();
        glass(x + 3, y + 3, w - 6, h - 30, t < 0.33 ? '#3d5560' : t < 0.66 ? '#35505c' : '#44606a');
        glass(x + 3, y + h - 24, w - 6, 21, '#27353c'); // spandrel panel
      },
    },
    90,
  );
}

/** Painted plaster walk-ups, the fabric of most of the city. Tinted per building. */
export function plasterFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 4, bayWidth: 3.2, floorHeight: 3.2,
      wall(g, w, h) {
        g.fillStyle = '#e4dfd2';
        g.fillRect(0, 0, w, h);
        blotches(g, w, h, 40, '#a39b88', 90, 0.35, 101);
        stains(g, w, h, 102, 0.4);
      },
      cell(g, x, y, w, h, glass, rnd) {
        g.fillStyle = 'rgba(50,45,38,0.25)';
        g.fillRect(x, y + h - 5, w, 5);
        const kind = rnd();
        if (kind < 0.55) {
          glass(x + 30, y + 34, w - 60, h - 78);
          g.strokeStyle = '#5b4a3c';
          g.lineWidth = 3;
          g.strokeRect(x + 30, y + 34, w - 60, h - 78);
          // window grille
          g.lineWidth = 1;
          g.strokeStyle = 'rgba(30,26,22,0.8)';
          for (let i = 1; i < 5; i++) {
            g.beginPath();
            g.moveTo(x + 30 + ((w - 60) * i) / 5, y + 34);
            g.lineTo(x + 30 + ((w - 60) * i) / 5, y + h - 44);
            g.stroke();
          }
          // sunshade
          g.fillStyle = '#cfc9ba';
          g.fillRect(x + 22, y + 24, w - 44, 8);
          g.fillStyle = 'rgba(30,26,22,0.35)';
          g.fillRect(x + 22, y + 32, w - 44, 4);
        } else {
          // balcony with a door and a railing
          g.fillStyle = '#3b3028';
          g.fillRect(x + 20, y + 26, 36, h - 46);
          glass(x + 64, y + 34, w - 84, h - 80);
          g.fillStyle = 'rgba(25,22,18,0.4)';
          g.fillRect(x + 6, y + h - 22, w - 12, 5);
          g.strokeStyle = '#2f2a25';
          g.lineWidth = 1.5;
          for (let i = 0; i <= 14; i++) {
            g.beginPath();
            g.moveTo(x + 8 + ((w - 16) * i) / 14, y + h - 52);
            g.lineTo(x + 8 + ((w - 16) * i) / 14, y + h - 20);
            g.stroke();
          }
          g.lineWidth = 3;
          g.beginPath();
          g.moveTo(x + 6, y + h - 52);
          g.lineTo(x + w - 6, y + h - 52);
          g.stroke();
          if (rnd() < 0.5) {
            // washing on the railing
            for (let i = 0; i < 3; i++) {
              g.fillStyle = ['#b6403a', '#d9a93b', '#3f6fa3', '#e9e4d8', '#5d8f58'][Math.floor(rnd() * 5)];
              g.fillRect(x + 16 + i * 30, y + h - 50, 22, 22 + rnd() * 10);
            }
          }
        }
      },
    },
    100,
  );
}

/** Lutyens' bungalows: cream lime plaster over a red sandstone plinth, tall green-shuttered windows. */
export function lutyensFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 2, bayWidth: 4.2, floorHeight: 4.4,
      wall(g, w, h) {
        g.fillStyle = '#efe6d2';
        g.fillRect(0, 0, w, h);
        blotches(g, w, h, 22, '#c9bb9c', 90, 0.3, 131);
        stains(g, w, h, 132, 0.14);
      },
      cell(g, x, y, w, h, glass, rnd) {
        const ground = y >= h; // the lower of the two floors sits on the sandstone plinth
        // cornice
        g.fillStyle = '#f7f0e0';
        g.fillRect(x, y, w, 8);
        g.fillStyle = 'rgba(70,55,40,0.3)';
        g.fillRect(x, y + 8, w, 3);
        if (ground) {
          g.fillStyle = '#a5523a';
          g.fillRect(x, y + h - 26, w, 26);
          g.fillStyle = 'rgba(40,20,10,0.35)';
          g.fillRect(x, y + h - 26, w, 3);
        }
        const wx = x + 38, ww = w - 76, wy = y + 26, wh = h - (ground ? 66 : 44);
        // deep chhajja sunshade over the window
        g.fillStyle = '#d9cdb3';
        g.fillRect(wx - 14, wy - 10, ww + 28, 8);
        g.fillStyle = 'rgba(40,30,20,0.35)';
        g.fillRect(wx - 14, wy - 2, ww + 28, 6);
        glass(wx, wy, ww, wh);
        if (rnd() < 0.6) {
          // green louvred shutters folded back
          g.fillStyle = '#3f5a3a';
          g.fillRect(wx - 13, wy, 12, wh);
          g.fillRect(wx + ww + 1, wy, 12, wh);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          for (let k = wy + 4; k < wy + wh; k += 6) {
            g.fillRect(wx - 13, k, 12, 1.5);
            g.fillRect(wx + ww + 1, k, 12, 1.5);
          }
        }
      },
    },
    130,
  );
}

/** The red and buff sandstone of the Secretariat blocks and the government buildings round them. */
export function sandstoneFacade(): Facade {
  return buildFacade(
    {
      bays: 4, floors: 3, bayWidth: 4, floorHeight: 4.2,
      wall(g, w, h) {
        g.fillStyle = '#d8b48a';
        g.fillRect(0, 0, w, h);
        blotches(g, w, h, 30, '#b88d63', 90, 0.35, 141);
        stains(g, w, h, 142, 0.2);
        // red sandstone lower storey
        const third = h / 3;
        g.fillStyle = '#a24e36';
        g.fillRect(0, h - third, w, third);
        blotches(g, w, third, 12, '#7e3a28', 60, 0.3, 143);
        g.fillStyle = 'rgba(40,20,10,0.4)';
        g.fillRect(0, h - third, w, 4);
      },
      cell(g, x, y, w, h, glass) {
        // pilasters and a recessed window with a jaali screen above it
        g.fillStyle = 'rgba(255,240,215,0.25)';
        g.fillRect(x, y, 14, h);
        g.fillStyle = 'rgba(60,35,20,0.3)';
        g.fillRect(x + 14, y, 3, h);
        const wx = x + 36, ww = w - 64;
        g.fillStyle = 'rgba(60,35,20,0.35)';
        g.fillRect(wx - 6, y + 18, ww + 12, h - 30);
        g.fillStyle = 'rgba(80,45,25,0.85)';
        for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) g.fillRect(wx + 4 + i * (ww / 4), y + 24 + k * 10, ww / 4 - 8, 5);
        glass(wx, y + 48, ww, h - 66);
      },
    },
    140,
  );
}

function supportsDevanagari() {
  const [, g] = canvas(40, 24);
  const draw = (s: string) => {
    g.clearRect(0, 0, 40, 24);
    g.font = '18px sans-serif';
    g.fillText(s, 2, 19);
    return g.getImageData(0, 0, 40, 24).data.join(',');
  };
  // Without a Devanagari font both strings render as the same "missing glyph" box.
  return draw('क') !== draw('ख');
}

const SHOPS_EN = ['SHARMA SWEETS', 'DELHI SAREE HOUSE', 'MOBILE WORLD', 'GUPTA CHEMIST', 'CHAI POINT', 'BOOK DEPOT', 'ROYAL TAILORS', 'KHADI BHANDAR', 'JEWELLERS', 'PHOTO STUDIO', 'OPTICIANS', 'TRAVELS', 'ELECTRONICS', 'BAKERY', 'PAAN BHANDAR', 'DHABA'];
const SHOPS_HI = ['शर्मा मिष्ठान भंडार', 'दिल्ली साड़ी हाउस', 'गुप्ता केमिस्ट', 'चाय', 'किताब घर', 'खादी भंडार', 'पान भंडार', 'ज्वैलर्स'];
const SIGN_COLOURS = ['#b3261e', '#1f4e8c', '#0f6b46', '#d08a12', '#5a2a7a', '#11110f', '#c2410c', '#0e7490', '#f2efe6'];

/** A 32 m run of street-level shopfronts: signboards, shutters and glass. */
export function shopfrontTexture(): Facade {
  const shops = 8;
  const sw = 256;
  const h = 256;
  const w = sw * shops;
  const [c, g] = canvas(w, h);
  const [oc, og] = canvas(w, h);
  const [ec, eg] = canvas(w, h);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, w, h);
  const glowRects: [number, number, number, number][] = [];
  og.fillStyle = 'rgb(255,220,0)';
  og.fillRect(0, 0, w, h);
  g.fillStyle = '#b9b1a1';
  g.fillRect(0, 0, w, h);
  const rnd = mulberry32(111);
  const hindi = supportsDevanagari();
  for (let i = 0; i < shops; i++) {
    const x = i * sw;
    // signboard
    const bg = SIGN_COLOURS[Math.floor(rnd() * SIGN_COLOURS.length)];
    g.fillStyle = bg;
    g.fillRect(x + 6, 10, sw - 12, 62);
    const light = bg === '#f2efe6';
    g.strokeStyle = light ? '#b3261e' : 'rgba(255,255,255,0.7)';
    g.lineWidth = 2;
    g.strokeRect(x + 11, 15, sw - 22, 52);
    const useHindi = hindi && rnd() < 0.4;
    const label = useHindi ? SHOPS_HI[Math.floor(rnd() * SHOPS_HI.length)] : SHOPS_EN[Math.floor(rnd() * SHOPS_EN.length)];
    g.fillStyle = light ? '#b3261e' : rnd() < 0.5 ? '#ffe9a8' : '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 30;
    do {
      g.font = `bold ${size}px ${useHindi ? 'sans-serif' : '"Arial Narrow", Arial, sans-serif'}`;
      size -= 2;
    } while (g.measureText(label).width > sw - 34 && size > 10);
    g.fillText(label, x + sw / 2, 42);
    glowRects.push([x + 6, 10, sw - 12, 62]);
    // awning shadow
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(x + 6, 72, sw - 12, 8);
    const top = 80;
    const bottom = h - 14;
    if (rnd() < 0.3) {
      // rolled-down shutter
      const v = 120 + rnd() * 60;
      g.fillStyle = `rgb(${v},${v},${v + 6})`;
      g.fillRect(x + 12, top, sw - 24, bottom - top);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      for (let y = top; y < bottom; y += 7) g.fillRect(x + 12, y, sw - 24, 2);
    } else {
      // dark interior behind glass, with stock on display
      const grad = g.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, '#15120f');
      grad.addColorStop(1, '#3d342a');
      g.fillStyle = grad;
      g.fillRect(x + 12, top, sw - 24, bottom - top);
      og.fillStyle = 'rgb(255,40,150)';
      og.fillRect(x + 12, top, sw - 24, bottom - top);
      glowRects.push([x + 12, top, sw - 24, bottom - top]);
      for (let k = 0; k < 26; k++) {
        g.fillStyle = `hsla(${rnd() * 360},${50 + rnd() * 40}%,${40 + rnd() * 30}%,0.85)`;
        g.fillRect(x + 20 + rnd() * (sw - 60), top + 30 + rnd() * (bottom - top - 60), 8 + rnd() * 20, 10 + rnd() * 24);
      }
      // warm tube light
      g.fillStyle = 'rgba(255,236,190,0.75)';
      g.fillRect(x + 30, top + 10, sw - 60, 4);
      g.strokeStyle = '#8c8880';
      g.lineWidth = 3;
      g.strokeRect(x + 12, top, sw - 24, bottom - top);
      g.beginPath();
      g.moveTo(x + sw * 0.62, top);
      g.lineTo(x + sw * 0.62, bottom);
      g.stroke();
    }
    // party wall
    g.fillStyle = '#8f8778';
    g.fillRect(x, 0, 6, h);
    g.fillRect(x + sw - 6, 0, 6, h);
  }
  // plinth
  g.fillStyle = '#6f695d';
  g.fillRect(0, h - 14, w, 14);
  grain(g, w, h, 8, 112);
  // signboards and open shops light up; shutters and walls stay dark
  for (const [x, y, rw, rh] of glowRects) eg.drawImage(c, x, y, rw, rh, x, y, rw, rh);
  eg.globalCompositeOperation = 'lighter';
  eg.fillStyle = 'rgba(90,70,40,1)';
  for (const [x, y, rw, rh] of glowRects) if (y > 20) eg.fillRect(x, y, rw, rh);
  return { map: tex(c), orm: tex(oc, false), glow: tex(ec), width: shops * 4, height: 4.2, bays: shops, floors: 1 };
}

/** Ground floor of the Connaught Place blocks: a white colonnade over a shaded arcade. */
export function colonnadeTexture(): Facade {
  const bays = 4;
  const bw = 256;
  const h = 320;
  const w = bw * bays;
  const [c, g] = canvas(w, h);
  const [oc, og] = canvas(w, h);
  og.fillStyle = 'rgb(255,225,0)';
  og.fillRect(0, 0, w, h);
  const [ec, eg] = canvas(w, h);
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, w, h);
  const rnd = mulberry32(121);
  for (let i = 0; i < bays; i++) {
    const x = i * bw;
    // the arcade behind: dark, with glowing shop windows
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0e0d0c');
    grad.addColorStop(1, '#2b2722');
    g.fillStyle = grad;
    g.fillRect(x, 0, bw, h);
    g.fillStyle = `hsla(${rnd() * 360},70%,45%,0.9)`;
    g.fillRect(x + 50, 70, bw - 100, 34);
    g.fillStyle = 'rgba(255,225,170,0.55)';
    g.fillRect(x + 56, 120, bw - 112, 130);
    for (let k = 0; k < 10; k++) {
      g.fillStyle = `hsla(${rnd() * 360},60%,45%,0.8)`;
      g.fillRect(x + 62 + rnd() * (bw - 150), 140 + rnd() * 80, 14 + rnd() * 16, 20 + rnd() * 26);
    }
    // the shop windows glow at night; the columns, drawn next, stand in front of them
    eg.drawImage(c, x + 50, 70, bw - 100, 180, x + 50, 70, bw - 100, 180);
  }
  // entablature
  g.fillStyle = '#efebe1';
  g.fillRect(0, 0, w, 44);
  g.fillStyle = 'rgba(50,45,38,0.4)';
  g.fillRect(0, 44, w, 5);
  for (let i = 0; i < bays; i++) {
    // round Tuscan columns, shaded to read as cylinders
    const cx = i * bw + bw / 2;
    const grad = g.createLinearGradient(cx - 22, 0, cx + 22, 0);
    grad.addColorStop(0, '#bdb8ac');
    grad.addColorStop(0.35, '#f7f4ec');
    grad.addColorStop(1, '#a9a498');
    g.fillStyle = grad;
    g.fillRect(cx - 22, 49, 44, h - 49 - 18);
    og.fillStyle = 'rgb(255,215,0)';
    og.fillRect(cx - 22, 49, 44, h - 67);
    g.fillStyle = '#e6e2d7';
    g.fillRect(cx - 30, 49, 60, 12);
    g.fillRect(cx - 30, h - 30, 60, 14);
  }
  g.fillStyle = '#8f897c';
  g.fillRect(0, h - 16, w, 16);
  og.fillStyle = 'rgb(255,225,0)';
  og.fillRect(0, 0, w, 49);
  og.fillRect(0, h - 16, w, 16);
  grain(g, w, h, 7, 122);
  for (let i = 0; i < bays; i++) {
    eg.fillStyle = '#000';
    eg.fillRect(i * bw + bw / 2 - 30, 49, 60, h - 49);
  }
  return { map: tex(c), orm: tex(oc, false), glow: tex(ec), width: bays * 4, height: 5, bays, floors: 1 };
}

export function roofTexture() {
  const s = 512;
  const [c, g] = canvas(s, s);
  g.fillStyle = '#8d877c';
  g.fillRect(0, 0, s, s);
  blotches(g, s, s, 40, '#5f5a52', 110, 0.4, 131);
  blotches(g, s, s, 30, '#a8a295', 100, 0.35, 132);
  grain(g, s, s, 14, 133);
  return tex(c);
}

/** Delhi private-car plate: black on white with the IND band. */
export function numberPlateTexture(text = 'DL 3C AY 4821') {
  const [c, g] = canvas(512, 128);
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#111';
  g.lineWidth = 6;
  g.strokeRect(5, 5, 502, 118);
  g.fillStyle = '#1b3f94';
  g.fillRect(8, 8, 44, 112);
  g.fillStyle = '#fff';
  g.font = 'bold 15px Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('IND', 30, 104);
  g.fillStyle = '#111';
  g.font = 'bold 76px "Arial Narrow", Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(text, 282, 68, 430);
  return tex(c, true, false);
}

export function flagTexture() {
  const [c, g] = canvas(600, 400);
  g.fillStyle = '#FF9933';
  g.fillRect(0, 0, 600, 134);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 133, 600, 134);
  g.fillStyle = '#138808';
  g.fillRect(0, 266, 600, 134);
  g.strokeStyle = '#000080';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(300, 200, 56, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 2.5;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.beginPath();
    g.moveTo(300, 200);
    g.lineTo(300 + Math.cos(a) * 56, 200 + Math.sin(a) * 56);
    g.stroke();
  }
  g.fillStyle = '#000080';
  g.beginPath();
  g.arc(300, 200, 9, 0, Math.PI * 2);
  g.fill();
  return tex(c, true, false);
}

/** Alloy wheel face, looking along the axle. */
export function wheelTexture() {
  const s = 256;
  const [c, g] = canvas(s, s);
  const m = s / 2;
  g.fillStyle = '#0c0c0d';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#17181a';
  g.beginPath();
  g.arc(m, m, 88, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#c9ccd0';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(m, m, 84, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#b4b8bd';
  for (let i = 0; i < 5; i++) {
    g.save();
    g.translate(m, m);
    g.rotate((i / 5) * Math.PI * 2);
    g.beginPath();
    g.moveTo(-9, -14);
    g.lineTo(-15, -82);
    g.lineTo(15, -82);
    g.lineTo(9, -14);
    g.closePath();
    g.fill();
    g.restore();
  }
  g.fillStyle = '#d7dadd';
  g.beginPath();
  g.arc(m, m, 22, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#3a3c40';
  g.beginPath();
  g.arc(m, m, 8, 0, Math.PI * 2);
  g.fill();
  return tex(c, true, false);
}

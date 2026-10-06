/*
 * Map canvases (design "지도 (Map_System)"): the base map image, built once per page from the heightfield, and the fog
 * overlay the map screen redraws from GameState's fog.
 * - Base image (1024 × 1024): the ground pixels of src/map/mapImage.ts (hillshade → Region palette → water), then the
 *   dirt paths along the layout's routes (the same polylines the terrain paints, from src/data/worldLayout.ts), then
 *   small drawn icons for the Landmarks and Thistlewick.
 * - Fog: unrevealed cells are covered with a parchment texture through a 140 × 140 mask scaled up with bilinear
 *   smoothing, so the edge between revealed and hidden ground is a soft linear blend.
 * DOM only (canvas 2D); the rules live in the pure modules beside it.
 */
import type { LandmarkId } from '../data/ids';
import { LOCATIONS } from '../data/worldLayout';
import { FOG_GRID, type FogOfWar } from '../logic/fogOfWar';
import { PATH_POLYLINES, regionWeightsAt, type TerrainField } from '../world/terrain';
import { MAP_SIZE, worldToMap } from './mapCoords';
import { renderMapPixels } from './mapImage';
import { LANDMARK_POINTS } from './mapModel';

function canvas(size: number): { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d');
  if (ctx === null) throw new Error('map: 2D canvas unavailable');
  return { el, ctx };
}

type Draw = (ctx: CanvasRenderingContext2D) => void;

/** Small illustrated icons, drawn around (0, 0) at about 16 px. */
const ICONS: Readonly<Record<LandmarkId | 'village', Draw>> = {
  lm_elderbough: (c) => {
    c.fillStyle = '#5a3d22';
    c.fillRect(-2, 0, 4, 9);
    c.fillStyle = '#2f6b34';
    c.beginPath();
    c.arc(0, -3, 8, 0, Math.PI * 2);
    c.fill();
  },
  lm_breezewatch: (c) => {
    c.fillStyle = '#e8dcc0';
    c.beginPath();
    c.moveTo(-3, 9);
    c.lineTo(3, 9);
    c.lineTo(2, -3);
    c.lineTo(-2, -3);
    c.fill();
    c.strokeStyle = '#4b3a2a';
    c.lineWidth = 1.6;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      c.beginPath();
      c.moveTo(0, -4);
      c.lineTo(Math.cos(a) * 8, -4 + Math.sin(a) * 8);
      c.stroke();
    }
  },
  lm_waterfall: (c) => {
    c.fillStyle = '#7d7466';
    c.fillRect(-7, -8, 14, 5);
    c.fillStyle = '#cfe8ff';
    c.fillRect(-3, -3, 6, 11);
  },
  lm_cinderspire: (c) => {
    c.fillStyle = '#ff7a45';
    c.beginPath();
    c.moveTo(0, -10);
    c.lineTo(4, 8);
    c.lineTo(-4, 8);
    c.fill();
    c.fillStyle = '#b8482a';
    c.beginPath();
    c.moveTo(-5, -3);
    c.lineTo(-2, 8);
    c.lineTo(-8, 8);
    c.fill();
  },
  lm_observatory: (c) => {
    c.fillStyle = '#dfe6f2';
    c.fillRect(-7, 1, 14, 7);
    c.beginPath();
    c.arc(0, 1, 7, Math.PI, 0);
    c.fill();
    c.fillStyle = '#3a4a70';
    c.fillRect(-1, -6, 2, 6);
  },
  lm_floating_isles: (c) => {
    c.fillStyle = '#8a8f9e';
    for (const [x, y, r] of [[-5, 2, 4], [4, -3, 3.5], [3, 6, 2.5]] as const) {
      c.beginPath();
      c.moveTo(x - r, y);
      c.lineTo(x + r, y);
      c.lineTo(x, y + r * 1.4);
      c.fill();
    }
  },
  lm_arch_azure: (c) => {
    c.strokeStyle = '#8c7b66';
    c.lineWidth = 3.5;
    c.beginPath();
    c.arc(0, 6, 8, Math.PI, 0);
    c.stroke();
  },
  lm_astral_sanctum: (c) => {
    c.fillStyle = '#e9c46a';
    c.beginPath();
    for (let k = 0; k < 8; k++) {
      const r = k % 2 === 0 ? 10 : 3.5;
      const a = (k * Math.PI) / 4 - Math.PI / 2;
      c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.fill();
  },
  village: (c) => {
    c.fillStyle = '#e9dcc0';
    c.strokeStyle = '#6b4a2e';
    c.lineWidth = 1.2;
    for (const [x, y] of [[-6, 2], [2, -2], [5, 5]] as const) {
      c.beginPath();
      c.moveTo(x - 4, y + 4);
      c.lineTo(x - 4, y);
      c.lineTo(x, y - 4);
      c.lineTo(x + 4, y);
      c.lineTo(x + 4, y + 4);
      c.closePath();
      c.fill();
      c.stroke();
    }
  },
};

function drawIcon(ctx: CanvasRenderingContext2D, x: number, z: number, draw: Draw): void {
  const { px, py } = worldToMap(x, z);
  ctx.save();
  ctx.translate(px, py);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 3;
  draw(ctx);
  ctx.restore();
}

/** The base map image: ground, water, paths and the Landmark / village icons. */
export function buildMapCanvas(terrain: Pick<TerrainField, 'heightAt' | 'waterDepthAt'>): HTMLCanvasElement {
  const { el, ctx } = canvas(MAP_SIZE);
  const pixels = renderMapPixels(terrain, regionWeightsAt);
  const image = ctx.createImageData(MAP_SIZE, MAP_SIZE);
  image.data.set(pixels);
  ctx.putImageData(image, 0, 0);
  // Paths: a dark edge under a light dirt line.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [width, colour] of [[4.2, 'rgba(70, 48, 28, 0.55)'], [2.2, 'rgba(226, 204, 158, 0.95)']] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    for (const line of PATH_POLYLINES) {
      ctx.beginPath();
      line.forEach((p, i) => {
        const { px, py } = worldToMap(p.x, p.z);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
  }
  for (const [id, p] of Object.entries(LANDMARK_POINTS) as [LandmarkId, { x: number; z: number }][]) drawIcon(ctx, p.x, p.z, ICONS[id]);
  drawIcon(ctx, LOCATIONS.thistlewick.x, LOCATIONS.thistlewick.z, ICONS.village);
  return el;
}

/** Page-wide base map: built on the first request (or by `warm`), then reused by every map screen. */
export class MapImageCache {
  private image: HTMLCanvasElement | null = null;

  constructor(private readonly terrain: Pick<TerrainField, 'heightAt' | 'waterDepthAt'>) {}

  get(): HTMLCanvasElement {
    this.image ??= buildMapCanvas(this.terrain);
    return this.image;
  }

  /** Builds the image now if it is not built yet (called once at start, after the first frame). */
  warm(): void {
    this.get();
  }
}

/** Deterministic parchment: warm paper with fibres and a darker edge per 64 px tile. */
function parchment(size: number): HTMLCanvasElement {
  const { el, ctx } = canvas(size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.75);
  gradient.addColorStop(0, '#e9dcbc');
  gradient.addColorStop(1, '#cdb88f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  // Fibres from an integer hash (no Math.random, so every page draws the same sheet).
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };
  for (let k = 0; k < 2600; k++) {
    const x = next() * size;
    const y = next() * size;
    const len = 4 + next() * 14;
    const a = next() * Math.PI;
    ctx.strokeStyle = next() < 0.5 ? 'rgba(120, 92, 52, 0.10)' : 'rgba(255, 250, 235, 0.14)';
    ctx.lineWidth = 0.8 + next();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  return el;
}

/**
 * Fog overlay for the map screen (1024 × 1024): parchment where cells are hidden, clear where revealed, the edge
 * blended linearly by scaling the 140 × 140 cell mask up with image smoothing.
 */
export class FogCanvas {
  readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mask = canvas(FOG_GRID);
  private readonly paper = parchment(MAP_SIZE);

  constructor() {
    const { el, ctx } = canvas(MAP_SIZE);
    this.element = el;
    this.ctx = ctx;
  }

  /** Redraws the overlay for `fog`. */
  draw(fog: Pick<FogOfWar, 'isCellRevealed'>): void {
    const maskCtx = this.mask.ctx;
    const data = maskCtx.createImageData(FOG_GRID, FOG_GRID);
    for (let j = 0; j < FOG_GRID; j++) {
      for (let i = 0; i < FOG_GRID; i++) {
        const o = (j * FOG_GRID + i) * 4;
        data.data[o + 3] = fog.isCellRevealed(i, j) ? 0 : 255;
      }
    }
    maskCtx.putImageData(data, 0, 0);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.paper, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.mask.el, 0, 0, FOG_GRID, FOG_GRID, 0, 0, MAP_SIZE, MAP_SIZE);
    ctx.restore();
  }
}

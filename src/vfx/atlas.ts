// Particle sprite atlas (design "VFX 시스템" Sprite atlas): at boot a 384 × 384 canvas gets the nine sprites of
// SPRITE_IDS drawn procedurally in white (the particle colour tints them), one per 128 px cell of a 3 × 3 grid, each
// inside a 4 px margin so mipmaps do not bleed between cells. Without a canvas (Node tests) a 1 × 1 white texture
// stands in, so everything above it still builds.

import * as THREE from 'three';
import { SPRITE_IDS, spriteIndex, type SpriteId } from './catalog';

export const ATLAS_SIZE = 384;
export const ATLAS_CELL = 128;
export const ATLAS_PADDING = 4;
export const ATLAS_COLUMNS = 3;

/** Drawable pixel rect (canvas coordinates, y down) of `id`'s cell. */
export function spriteRect(id: SpriteId): { x: number; y: number; size: number } {
  const i = spriteIndex(id);
  const col = i % ATLAS_COLUMNS;
  const row = Math.floor(i / ATLAS_COLUMNS);
  return { x: col * ATLAS_CELL + ATLAS_PADDING, y: row * ATLAS_CELL + ATLAS_PADDING, size: ATLAS_CELL - 2 * ATLAS_PADDING };
}

/** The same rect in texture UV (flipY: canvas top is v = 1). */
export function spriteUv(id: SpriteId): { u0: number; v0: number; u1: number; v1: number } {
  const r = spriteRect(id);
  return {
    u0: r.x / ATLAS_SIZE,
    u1: (r.x + r.size) / ATLAS_SIZE,
    v0: 1 - (r.y + r.size) / ATLAS_SIZE,
    v1: 1 - r.y / ATLAS_SIZE,
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws every sprite in white into `ctx` (a 384 × 384 surface). */
export function drawAtlas(ctx: Ctx): void {
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  for (const id of SPRITE_IDS) {
    const r = spriteRect(id);
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.size, r.size);
    ctx.clip();
    ctx.translate(r.x + r.size / 2, r.y + r.size / 2);
    DRAW[id](ctx, r.size / 2);
    ctx.restore();
  }
}

const white = (a: number): string => `rgba(255,255,255,${a})`;

function softDisc(ctx: Ctx, radius: number, core = 0): void {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  g.addColorStop(0, white(1));
  g.addColorStop(Math.max(0.01, core), white(0.85));
  g.addColorStop(1, white(0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
}

/** Path helpers draw around the cell centre with `h` = half the drawable size (60 px). */
const DRAW: Record<SpriteId, (ctx: Ctx, h: number) => void> = {
  circle: (ctx, h) => softDisc(ctx, h * 0.98, 0.25),
  spark: (ctx, h) => {
    softDisc(ctx, h * 0.45, 0.3);
    ctx.fillStyle = white(1);
    for (const [w, l] of [[h * 0.09, h * 0.98], [h * 0.06, h * 0.6]] as const) {
      for (let k = 0; k < 2; k++) {
        ctx.save();
        ctx.rotate((k * Math.PI) / 2 + (l < h * 0.9 ? Math.PI / 4 : 0));
        ctx.beginPath();
        ctx.moveTo(0, -l);
        ctx.lineTo(w, 0);
        ctx.lineTo(0, l);
        ctx.lineTo(-w, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  },
  petal: (ctx, h) => {
    const g = ctx.createLinearGradient(0, -h, 0, h);
    g.addColorStop(0, white(1));
    g.addColorStop(1, white(0.55));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.9);
    ctx.bezierCurveTo(h * 0.85, h * 0.2, h * 0.5, -h * 0.8, 0, -h * 0.55);
    ctx.bezierCurveTo(-h * 0.5, -h * 0.8, -h * 0.85, h * 0.2, 0, h * 0.9);
    ctx.fill();
  },
  ember: (ctx, h) => {
    const g = ctx.createRadialGradient(0, h * 0.35, 0, 0, h * 0.1, h * 0.95);
    g.addColorStop(0, white(1));
    g.addColorStop(0.45, white(0.8));
    g.addColorStop(1, white(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.95);
    ctx.bezierCurveTo(h * 0.25, -h * 0.4, h * 0.75, h * 0.1, h * 0.55, h * 0.55);
    ctx.bezierCurveTo(h * 0.35, h * 0.95, -h * 0.35, h * 0.95, -h * 0.55, h * 0.55);
    ctx.bezierCurveTo(-h * 0.75, h * 0.1, -h * 0.25, -h * 0.4, 0, -h * 0.95);
    ctx.fill();
  },
  droplet: (ctx, h) => {
    ctx.fillStyle = white(0.9);
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.9);
    ctx.bezierCurveTo(h * 0.2, -h * 0.4, h * 0.62, h * 0.05, h * 0.62, h * 0.35);
    ctx.arc(0, h * 0.35, h * 0.62, 0, Math.PI, false);
    ctx.bezierCurveTo(-h * 0.62, h * 0.05, -h * 0.2, -h * 0.4, 0, -h * 0.9);
    ctx.fill();
    ctx.fillStyle = white(1);
    ctx.beginPath();
    ctx.ellipse(-h * 0.22, h * 0.25, h * 0.12, h * 0.2, -0.4, 0, Math.PI * 2);
    ctx.fill();
  },
  leaf: (ctx, h) => {
    ctx.rotate(Math.PI / 5);
    ctx.fillStyle = white(0.95);
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.95);
    ctx.quadraticCurveTo(h * 0.7, 0, 0, h * 0.95);
    ctx.quadraticCurveTo(-h * 0.7, 0, 0, -h * 0.95);
    ctx.fill();
    ctx.strokeStyle = white(0.45);
    ctx.lineWidth = h * 0.06;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.8);
    ctx.lineTo(0, h * 0.85);
    ctx.stroke();
  },
  shard: (ctx, h) => {
    const g = ctx.createLinearGradient(-h, -h, h, h);
    g.addColorStop(0, white(1));
    g.addColorStop(1, white(0.6));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(h * 0.1, -h * 0.95);
    ctx.lineTo(h * 0.55, -h * 0.1);
    ctx.lineTo(h * 0.25, h * 0.9);
    ctx.lineTo(-h * 0.45, h * 0.45);
    ctx.lineTo(-h * 0.4, -h * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = white(0.5);
    ctx.lineWidth = h * 0.05;
    ctx.beginPath();
    ctx.moveTo(h * 0.1, -h * 0.95);
    ctx.lineTo(-h * 0.05, h * 0.2);
    ctx.lineTo(h * 0.25, h * 0.9);
    ctx.stroke();
  },
  star: (ctx, h) => {
    softDisc(ctx, h * 0.5, 0.2);
    ctx.fillStyle = white(1);
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? h * 0.95 : h * 0.4;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  },
  ring: (ctx, h) => {
    const g = ctx.createRadialGradient(0, 0, h * 0.55, 0, 0, h * 0.98);
    g.addColorStop(0, white(0));
    g.addColorStop(0.45, white(1));
    g.addColorStop(1, white(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, h * 0.98, 0, Math.PI * 2);
    ctx.fill();
  },
};

/** A drawing surface: a DOM canvas in the page, an OffscreenCanvas in workers, none in Node. */
function makeSurface(): HTMLCanvasElement | OffscreenCanvas | null {
  const g = globalThis as { document?: Document; OffscreenCanvas?: typeof OffscreenCanvas };
  if (g.document !== undefined && typeof g.document.createElement === 'function') {
    const canvas = g.document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    return canvas;
  }
  if (g.OffscreenCanvas !== undefined) return new g.OffscreenCanvas(ATLAS_SIZE, ATLAS_SIZE);
  return null;
}

/** The atlas texture (mipmapped, sRGB); a 1 × 1 white texture without a canvas. */
export function createAtlasTexture(): THREE.Texture {
  const surface = makeSurface();
  const ctx = surface?.getContext('2d') as Ctx | null | undefined;
  if (surface === null || ctx === null || ctx === undefined) {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  }
  drawAtlas(ctx);
  const texture = new THREE.CanvasTexture(surface as HTMLCanvasElement);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.name = 'vfxAtlas';
  return texture;
}

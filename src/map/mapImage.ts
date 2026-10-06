/*
 * Map image pixels (design "지도 (Map_System)" 지도 이미지): the ground layers of the 1024 × 1024 map, built once from
 * the heightfield. For each pixel (its world point from src/map/mapCoords): the Region palette (the terrain's own
 * Region weights, blended across the borders, lighter with height, snow on the Azure peaks, mist past the play
 * boundary) × hillshade lit from the north-west (azimuth 315°, altitude 45°) with faint 20 m contour lines, then the
 * water surfaces (the terrain's water depth, deeper is darker). The canvas side (src/map/mapCanvas.ts) strokes the
 * paths and draws the Landmark icons over these pixels. Pure: no DOM (RGBA bytes in a Uint8ClampedArray).
 */
import type { TerrainRegion } from '../world/terrain';
import { MAP_SIZE, mapToWorld } from './mapCoords';

/** What the image reads from the terrain. */
export interface MapTerrain {
  heightAt(x: number, z: number): number;
  /** Water surface − ground where there is water, else 0. */
  waterDepthAt(x: number, z: number): number;
}

export type RegionWeights = (x: number, z: number) => Readonly<Record<TerrainRegion, number>>;

type Rgb = readonly [number, number, number];

/** Region ground colours (the map's printed palette, not the 3D materials). */
export const MAP_PALETTE: Readonly<Record<TerrainRegion, Rgb>> = {
  verdant: [128, 168, 96],
  ember: [196, 130, 84],
  azure: [146, 170, 188],
  crater: [160, 146, 170],
};
const SNOW: Rgb = [236, 240, 246];
const MIST: Rgb = [196, 204, 218];
const WATER_SHALLOW: Rgb = [92, 150, 196];
const WATER_DEEP: Rgb = [46, 92, 150];
/** Unit vector toward the light: from the north-west (−x, −z), 45° up. */
const LIGHT = { x: -0.5, y: Math.SQRT1_2, z: -0.5 } as const;
/** Height exaggeration of the hillshade relief. */
const RELIEF = 1.6;
const CONTOUR_STEP = 20;
/** Play boundary and where the mist is full (m from the origin). */
const MIST_START = 470;
const MIST_FULL = 545;
/** Region weights are sampled every this many pixels and blended between. */
const REGION_STEP = 4;

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (e0: number, e1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Region colour grid: RGB per REGION_STEP pixels, (n + 1)² samples. */
function regionColors(size: number, weights: RegionWeights): { grid: Float32Array; n: number } {
  const n = Math.ceil(size / REGION_STEP);
  const grid = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const { x, z } = mapToWorld(Math.min(size, i * REGION_STEP) * (MAP_SIZE / size), Math.min(size, j * REGION_STEP) * (MAP_SIZE / size));
      const w = weights(x, z);
      let r = 0;
      let g = 0;
      let b = 0;
      let sum = 0;
      for (const key of Object.keys(MAP_PALETTE) as TerrainRegion[]) {
        const k = w[key] ?? 0;
        const c = MAP_PALETTE[key];
        r += c[0] * k;
        g += c[1] * k;
        b += c[2] * k;
        sum += k;
      }
      const o = (j * (n + 1) + i) * 3;
      const s = sum > 0 ? 1 / sum : 0;
      grid[o] = sum > 0 ? r * s : MAP_PALETTE.verdant[0];
      grid[o + 1] = sum > 0 ? g * s : MAP_PALETTE.verdant[1];
      grid[o + 2] = sum > 0 ? b * s : MAP_PALETTE.verdant[2];
    }
  }
  return { grid, n };
}

/**
 * RGBA pixels of the map's ground layers, `size` × `size` (default 1024; a smaller size samples the same world square
 * more coarsely, for tests). Row-major, north row first.
 */
export function renderMapPixels(terrain: MapTerrain, weights: RegionWeights, size = MAP_SIZE): Uint8ClampedArray {
  const px = MAP_SIZE / size; // map pixels per output pixel
  const cell = (2 * 560) / size; // metres per output pixel
  // Heights at the pixel centres, with a one-pixel border for the gradients.
  const side = size + 2;
  const heights = new Float32Array(side * side);
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const { x, z } = mapToWorld((i - 0.5) * px, (j - 0.5) * px);
      heights[j * side + i] = terrain.heightAt(x, z);
    }
  }
  const { grid, n } = regionColors(size, weights);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const { x, z } = mapToWorld((i + 0.5) * px, (j + 0.5) * px);
      const c = (j + 1) * side + (i + 1);
      const h = heights[c];
      // Region colour, bilinear between the coarse samples.
      const gx = (i + 0.5) / REGION_STEP;
      const gz = (j + 0.5) / REGION_STEP;
      const i0 = Math.min(n - 1, Math.floor(gx));
      const j0 = Math.min(n - 1, Math.floor(gz));
      const fx = Math.min(1, gx - i0);
      const fz = Math.min(1, gz - j0);
      const o00 = (j0 * (n + 1) + i0) * 3;
      const o10 = o00 + 3;
      const o01 = o00 + (n + 1) * 3;
      const o11 = o01 + 3;
      // Lighter with height; snow on the high Azure ground; mist past the play boundary.
      const lift = Math.min(1.18, Math.max(0.88, 0.94 + h / 600));
      let r = mix(mix(grid[o00], grid[o10], fx), mix(grid[o01], grid[o11], fx), fz) * lift;
      let g = mix(mix(grid[o00 + 1], grid[o10 + 1], fx), mix(grid[o01 + 1], grid[o11 + 1], fx), fz) * lift;
      let b = mix(mix(grid[o00 + 2], grid[o10 + 2], fx), mix(grid[o01 + 2], grid[o11 + 2], fx), fz) * lift;
      const snow = smooth(140, 175, h);
      r = mix(r, SNOW[0], snow);
      g = mix(g, SNOW[1], snow);
      b = mix(b, SNOW[2], snow);
      // Hillshade from the height gradient.
      const dhx = (heights[c + 1] - heights[c - 1]) / (2 * cell);
      const dhz = (heights[c + side] - heights[c - side]) / (2 * cell);
      const nx = -dhx * RELIEF;
      const nz = -dhz * RELIEF;
      const len = Math.hypot(nx, 1, nz);
      const shade = Math.max(0, (nx * LIGHT.x + LIGHT.y + nz * LIGHT.z) / len);
      let light = 0.32 + 0.95 * shade; // flat ground ≈ 0.99
      // Contours: a darker line where a 20 m level crosses between this pixel and its east / south neighbour.
      const level = Math.floor(h / CONTOUR_STEP);
      if (level !== Math.floor(heights[c + 1] / CONTOUR_STEP) || level !== Math.floor(heights[c + side] / CONTOUR_STEP)) light *= 0.9;
      r *= light;
      g *= light;
      b *= light;
      // Water over the ground.
      const depth = terrain.waterDepthAt(x, z);
      if (depth > 0.05) {
        const d = Math.min(1, depth / 6);
        r = mix(WATER_SHALLOW[0], WATER_DEEP[0], d);
        g = mix(WATER_SHALLOW[1], WATER_DEEP[1], d);
        b = mix(WATER_SHALLOW[2], WATER_DEEP[2], d);
      }
      const mist = smooth(MIST_START, MIST_FULL, Math.hypot(x, z)) * 0.75;
      const o = (j * size + i) * 4;
      out[o] = mix(r, MIST[0], mist);
      out[o + 1] = mix(g, MIST[1], mist);
      out[o + 2] = mix(b, MIST[2], mist);
      out[o + 3] = 255;
    }
  }
  return out;
}

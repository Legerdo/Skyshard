/*
 * Terrain vertex colours (design.md "지형 렌더링"; Req 39.2, 39.3). A vertex starts from the base colour of the
 * TerrainMaterial `materialAt` returns there, blended across the Region masks (each Region paints its materials from
 * its palette, so a border never cuts the colour), then:
 * - slope rock blend: from 26° to 44° the colour fades toward the Region's rock colour (Ember: `ashRock`), so the 38°
 *   rock threshold of `materialAt` never reads as a hard step;
 * - low-frequency noise tint: ±9 % brightness over ≈ 140 m and a warm / cool shift over ≈ 260 m break up broad fields;
 * - `strata`: the steep-slope weight (34° → 56°) the terrain shader draws its world-height strata bands with.
 *
 * Pure (no three.js / DOM / Math.random): the noise comes from the seeded terrain noise, so the same seed paints the
 * same terrain.
 */
import { deriveSeed } from '../../core/rng';
import { REGION_PALETTES } from '../../data/palettes';
import type { TerrainField, TerrainMaterial, TerrainRegion } from '../../world/terrain';
import { createNoise2D, fbm, regionWeightsAt, type Noise2D } from '../../world/terrain';
import { srgbHexToLinear, type LinearRgb } from '../terrainMesh';

/** The TerrainField queries the terrain colours read. */
export type TerrainColorSurface = Pick<TerrainField, 'heightAt' | 'normalAt' | 'materialAt'>;

export const TERRAIN_REGIONS: readonly TerrainRegion[] = ['verdant', 'ember', 'azure', 'crater'];

/** Slope band (deg) over which the colour fades to rock, and the band that carries the strata shader. */
export const ROCK_BLEND_DEG = { from: 26, to: 44 } as const;
export const STRATA_DEG = { from: 34, to: 56 } as const;
/** Noise tint: brightness amplitude and the two wavelengths (m). */
export const TERRAIN_TINT = { brightness: 0.09, brightnessScale: 140, hue: 0.045, hueScale: 260 } as const;

const P = REGION_PALETTES;

/** Base colour (sRGB hex) per Region and TerrainMaterial. */
export const TERRAIN_REGION_COLORS: Readonly<Record<TerrainRegion, Readonly<Record<TerrainMaterial, number>>>> = {
  verdant: {
    grass: P.verdant.swatches.grass, dirt: 0x9a7a52, rock: P.verdant.swatches.rock, sand: 0xd8c796, ashRock: 0x6f5b54,
    crystal: 0xc24a5e, snow: 0xeef2f6, stone: P.verdant.swatches.stone,
  },
  ember: {
    grass: P.ember.swatches.grass, dirt: 0x8a5a44, rock: 0x6f4a3e, sand: 0xc09a70, ashRock: 0x6a4a40,
    crystal: 0xb04a3a, snow: 0xe8e2de, stone: P.ember.swatches.stone,
  },
  azure: {
    grass: P.azure.swatches.grass, dirt: 0x8a8070, rock: P.azure.swatches.rock, sand: 0xd6d0bc, ashRock: 0x6a6878,
    crystal: 0x9fb4e8, snow: 0xf2f6fc, stone: P.azure.swatches.stone,
  },
  crater: {
    grass: P.crater.swatches.grass, dirt: 0xa08a60, rock: P.crater.swatches.rock, sand: 0xd2c08a, ashRock: 0x7a6450,
    crystal: 0xa070d0, snow: 0xf0ece4, stone: 0xc4b286,
  },
};

const LINEAR: Readonly<Record<TerrainRegion, Readonly<Record<TerrainMaterial, LinearRgb>>>> = Object.fromEntries(
  TERRAIN_REGIONS.map((region) => [
    region,
    Object.fromEntries(Object.entries(TERRAIN_REGION_COLORS[region]).map(([m, hex]) => [m, srgbHexToLinear(hex)])),
  ]),
) as Record<TerrainRegion, Record<TerrainMaterial, LinearRgb>>;

/** The steep-slope material of a Region: Ember cliffs are ash rock, the others plain rock. */
export function slopeRockOf(region: TerrainRegion): TerrainMaterial {
  return region === 'ember' ? 'ashRock' : 'rock';
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Colour output slot (linear rgb) plus the strata weight. */
export interface TerrainVertexColor {
  r: number;
  g: number;
  b: number;
  strata: number;
}

/** Per-seed noise pair of the tint (cached: every chunk of one terrain shares it). */
interface TintNoise {
  readonly brightness: Noise2D;
  readonly hue: Noise2D;
}

const tintCache = new Map<number, TintNoise>();

function tintNoise(seed: number): TintNoise {
  const key = seed >>> 0;
  let n = tintCache.get(key);
  if (n === undefined) {
    n = { brightness: createNoise2D(deriveSeed(key, 'terrainTint')), hue: createNoise2D(deriveSeed(key, 'terrainHue')) };
    tintCache.set(key, n);
  }
  return n;
}

/**
 * The vertex colour at (x, z): material base colour blended over the Region weights, the slope rock blend, the noise
 * tint, and the strata weight. `slopeDeg` is the slope there (acos of the normal's y).
 */
export function terrainColorAt(
  field: TerrainColorSurface, seed: number, x: number, z: number, slopeDeg: number, out: TerrainVertexColor,
): TerrainVertexColor {
  const material = field.materialAt(x, z);
  const w = regionWeightsAt(x, z);
  const rock = smoothstep(ROCK_BLEND_DEG.from, ROCK_BLEND_DEG.to, slopeDeg);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const region of TERRAIN_REGIONS) {
    const weight = w[region];
    if (!(weight > 0)) continue;
    const table = LINEAR[region];
    const base = table[material];
    const cliff = table[slopeRockOf(region)];
    r += weight * (base[0] + (cliff[0] - base[0]) * rock);
    g += weight * (base[1] + (cliff[1] - base[1]) * rock);
    b += weight * (base[2] + (cliff[2] - base[2]) * rock);
  }
  // Snow and sand stay clean; everything else takes the full tint.
  const tintScale = material === 'snow' || material === 'sand' ? 0.4 : 1;
  const noise = tintNoise(seed);
  const bright = 1 + TERRAIN_TINT.brightness * tintScale * fbm(noise.brightness, x / TERRAIN_TINT.brightnessScale, z / TERRAIN_TINT.brightnessScale, 3);
  const hue = TERRAIN_TINT.hue * tintScale * noise.hue(x / TERRAIN_TINT.hueScale, z / TERRAIN_TINT.hueScale);
  // hue > 0: warm (more red, less blue); < 0: cool.
  out.r = Math.max(0, r * bright * (1 + hue));
  out.g = Math.max(0, g * bright);
  out.b = Math.max(0, b * bright * (1 - hue));
  out.strata = smoothstep(STRATA_DEG.from, STRATA_DEG.to, slopeDeg);
  return out;
}

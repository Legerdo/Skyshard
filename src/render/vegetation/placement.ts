/*
 * Deterministic vegetation placement per 64 m chunk and kind (design.md "식생·바위·소품"; Req 39.4, 38.5).
 *
 * Candidates sit on a jittered grid whose cell gives the chunk's highest candidate density (the densest Region the
 * chunk touches × the 1.6 × top step). A candidate exists with probability (local density × clumping) ÷ that maximum,
 * where the local density blends the Region densities by the terrain's Region weights, and it passes the surface
 * rules of its kind: inside its radius from the world centre, outside every keep-out shape (grown by the kind's
 * margin), clear of the dirt paths, no steeper than the kind's limit, on one of its ground materials, not under
 * water, and (trees / bushes near the village) off the plaza's Sanctum sight axis. Each record carries a keep value
 * u: a vegetation step s keeps it while u < s ÷ 1.6, so lower steps are subsets of higher ones.
 *
 * Randomness comes from an integer hash of (seed, kind, cell, channel): no Math.random, no state, so a chunk rebuilt
 * later (or in another session with the same seed) gets the same instances. Pure: no three.js / DOM.
 */
import { deriveSeed } from '../../core/rng';
import {
  MAX_VEGETATION_DENSITY, ROCK_VARIANTS, ROCK_VARIANTS_PER_CHUNK, TREE_ARCHETYPES, VEGETATION_DENSITY, VEGETATION_KINDS,
  VEGETATION_REGIONS, VEGETATION_RULES, type GroundMaterial, type VegetationKind, type VegetationRegion,
} from '../../data/vegetation';
import { blocksSanctumSight, VILLAGE_CENTER } from '../../data/village';
import type { TerrainField } from '../../world/terrain';
import { createNoise2D, distanceToPath, PATH_HALF_WIDTH, regionWeightsAt, type Noise2D } from '../../world/terrain';
import { gridCoord, type TerrainChunkSpec } from '../terrainMesh';
import { blockedBy, KeepOutIndex, KIND_BIT, worldKeepOuts } from './keepOuts';

/** The TerrainField queries the placer reads (water depth optional: surfaces without water skip the check). */
export type VegetationSurface = Pick<TerrainField, 'heightAt' | 'normalAt' | 'materialAt'> & Partial<Pick<TerrainField, 'waterDepthAt'>>;

/** Floats per placed instance. */
export const RECORD_STRIDE = 8;
/** Field offsets of a record. */
export const REC = { x: 0, y: 1, z: 2, yaw: 3, scale: 4, variant: 5, tint: 6, keep: 7 } as const;

/** Trees and bushes this close to the plaza are checked against its Sanctum sight axis (m). */
const SIGHT_CHECK_RADIUS = 120;

export interface PlacementEnv {
  readonly seed: number;
  readonly keepOuts: KeepOutIndex;
  /** Horizontal distance to the nearest dirt path (m). */
  pathDistance(x: number, z: number): number;
  /** Region weights at (x, z), summing to 1. */
  regionWeights(x: number, z: number): Readonly<Record<VegetationRegion, number>>;
}

/** The world's placement environment: the static keep-outs, dirt paths and Region masks. */
export function createPlacementEnv(seed: number, overrides: Partial<Omit<PlacementEnv, 'seed'>> = {}): PlacementEnv {
  return {
    seed: seed >>> 0,
    keepOuts: overrides.keepOuts ?? new KeepOutIndex(worldKeepOuts()),
    pathDistance: overrides.pathDistance ?? distanceToPath,
    regionWeights: overrides.regionWeights ?? regionWeightsAt,
  };
}

// ── Hashing ────────────────────────────────────────────────────────────────

function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) from four integers. */
export function hash01(seed: number, a: number, b: number, c: number): number {
  let h = mix32((seed ^ Math.imul(a | 0, 0x27d4eb2d)) >>> 0);
  h = mix32((h ^ Math.imul(b | 0, 0x165667b1)) >>> 0);
  h = mix32((h ^ Math.imul(c | 0, 0x9e3779b1)) >>> 0);
  return h / 4294967296;
}

const KIND_INDEX: Readonly<Record<VegetationKind, number>> = Object.fromEntries(VEGETATION_KINDS.map((k, i) => [k, i])) as Record<VegetationKind, number>;
const REGION_INDEX: Readonly<Record<VegetationRegion, number>> = { verdant: 0, ember: 1, azure: 2, crater: 3 };

const noiseCache = new Map<string, Noise2D>();
function clusterNoise(seed: number, kind: VegetationKind): Noise2D {
  const key = `${seed}:${kind}`;
  let n = noiseCache.get(key);
  if (n === undefined) {
    n = createNoise2D(deriveSeed(seed, `vegetation:${kind}`));
    noiseCache.set(key, n);
  }
  return n;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ── Variants ───────────────────────────────────────────────────────────────

/** Flower colours per Region (sRGB). */
export const FLOWER_COLORS: Readonly<Record<VegetationRegion, readonly number[]>> = {
  verdant: [0xf2d24b, 0xf28bb0, 0xfff6e8, 0xb58cf2],
  ember: [0xffa24a, 0xf2d24b, 0xe0584a, 0xffc86a],
  azure: [0xbfd8ff, 0xfff6e8, 0xc9b8ff, 0x9fe0ff],
  crater: [0xe9c46a, 0xc286ff, 0xfff1c4, 0xe9c46a],
};

/** What a record's `variant` field encodes. */
export interface DecodedVariant {
  readonly region: VegetationRegion;
  /** Tree archetype 0–2, rock variant 0–5, flower colour 0–3; 0 for grass and bushes. */
  readonly sub: number;
}

export function encodeVariant(region: VegetationRegion, sub: number): number {
  return REGION_INDEX[region] * 8 + sub;
}

export function decodeVariant(value: number): DecodedVariant {
  const v = Math.round(value);
  const region = VEGETATION_REGIONS[Math.min(3, Math.max(0, Math.floor(v / 8)))] as VegetationRegion;
  return { region, sub: v % 8 };
}

/** The rock variants a chunk draws (ROCK_VARIANTS_PER_CHUNK of the six, from the chunk's hash). */
export function chunkRockVariants(seed: number, spec: Pick<TerrainChunkSpec, 'cx' | 'cz'>): number[] {
  const first = Math.floor(hash01(seed, spec.cx, spec.cz, 7001) * ROCK_VARIANTS);
  const out: number[] = [];
  for (let k = 0; k < ROCK_VARIANTS_PER_CHUNK; k++) out.push((first + Math.round((k * ROCK_VARIANTS) / ROCK_VARIANTS_PER_CHUNK)) % ROCK_VARIANTS);
  return out;
}

function pickArchetype(region: VegetationRegion, u: number): number {
  const list = TREE_ARCHETYPES[region];
  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += (list[i] as { share: number }).share;
    if (u < acc) return i;
  }
  return list.length - 1;
}

// ── Placement ──────────────────────────────────────────────────────────────

/** Chunk rectangle in world metres. */
function chunkRect(spec: TerrainChunkSpec): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return { minX: gridCoord(spec.ix0), maxX: gridCoord(spec.ix0 + spec.quadsX), minZ: gridCoord(spec.iz0), maxZ: gridCoord(spec.iz0 + spec.quadsZ) };
}

/** Highest Region density of `kind` the chunk touches (3 × 3 samples, 32 m apart: finer than the 40 m blend band). */
function chunkMaxDensity(env: PlacementEnv, kind: VegetationKind, r: ReturnType<typeof chunkRect>): number {
  let best = 0;
  for (let j = 0; j <= 2; j++) {
    for (let i = 0; i <= 2; i++) {
      const w = env.regionWeights(r.minX + ((r.maxX - r.minX) * i) / 2, r.minZ + ((r.maxZ - r.minZ) * j) / 2);
      for (const region of VEGETATION_REGIONS) if (w[region] > 1e-3) best = Math.max(best, VEGETATION_DENSITY[kind][region]);
    }
  }
  return best;
}

/**
 * Instance records of `kind` in the chunk at the top step (1.6 ×), RECORD_STRIDE floats each:
 * x, y (ground height), z, yaw, uniform scale, variant (encodeVariant), tint 0–1, keep value u.
 */
export function placeChunk(surface: VegetationSurface, spec: TerrainChunkSpec, kind: VegetationKind, env: PlacementEnv): Float32Array {
  const rule = VEGETATION_RULES[kind];
  const rect = chunkRect(spec);
  const maxD = chunkMaxDensity(env, kind, rect);
  if (!(maxD > 0)) return new Float32Array(0);
  // The chunk lies wholly beyond the kind's radius: nothing.
  const nearX = Math.max(rect.minX, Math.min(0, rect.maxX));
  const nearZ = Math.max(rect.minZ, Math.min(0, rect.maxZ));
  if (nearX * nearX + nearZ * nearZ > rule.maxRadius * rule.maxRadius) return new Float32Array(0);

  const cell = 1 / Math.sqrt(maxD * MAX_VEGETATION_DENSITY);
  const seed = env.seed;
  const k = KIND_INDEX[kind];
  const bit = KIND_BIT[kind];
  const margin = rule.keepOutMargin;
  const shapes = env.keepOuts.near(rect.minX - margin, rect.maxX + margin, rect.minZ - margin, rect.maxZ + margin);
  const noise = rule.clusterStrength > 0 ? clusterNoise(seed, kind) : null;
  const clusterMean = 1 - rule.clusterStrength * 0.5;
  const materials = new Set<GroundMaterial>(rule.materials);
  const pathLimit = PATH_HALF_WIDTH + rule.pathClearance;
  const maxR2 = rule.maxRadius * rule.maxRadius;
  const cosMax = Math.cos((rule.maxSlopeDeg * Math.PI) / 180);
  const rocks = kind === 'rock' ? chunkRockVariants(seed, spec) : [];
  const cellSeed = mix32((seed ^ Math.imul(k + 1, 0x632be5ab)) >>> 0);
  const sightCheck = (kind === 'tree' || kind === 'bush')
    && Math.hypot(Math.max(rect.minX - VILLAGE_CENTER.x, 0, VILLAGE_CENTER.x - rect.maxX), Math.max(rect.minZ - VILLAGE_CENTER.z, 0, VILLAGE_CENTER.z - rect.maxZ)) < SIGHT_CHECK_RADIUS;

  const out: number[] = [];
  const i0 = Math.floor(rect.minX / cell);
  const i1 = Math.ceil(rect.maxX / cell);
  const j0 = Math.floor(rect.minZ / cell);
  const j1 = Math.ceil(rect.maxZ / cell);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const h = (c: number): number => hash01(cellSeed, i, j, c);
      const x = (i + h(0)) * cell;
      const z = (j + h(1)) * cell;
      if (x < rect.minX || x >= rect.maxX || z < rect.minZ || z >= rect.maxZ) continue;
      if (x * x + z * z > maxR2) continue;
      // Existence: blended Region density × clumping against the chunk's candidate density.
      const w = env.regionWeights(x, z);
      let density = 0;
      for (const region of VEGETATION_REGIONS) density += w[region] * VEGETATION_DENSITY[kind][region];
      if (!(density > 0)) continue;
      let cluster = 1;
      if (noise !== null) {
        const n = noise(x / rule.clusterScale, z / rule.clusterScale);
        cluster = (1 - rule.clusterStrength + rule.clusterStrength * smoothstep(-0.25, 0.45, n)) / clusterMean;
      }
      if (h(2) >= Math.min(1, (density * cluster) / maxD)) continue;
      // Surface rules, cheapest first.
      if (blockedBy(shapes, x, z, bit, margin)) continue;
      if (env.pathDistance(x, z) < pathLimit) continue;
      const n = surface.normalAt(x, z);
      if (!(n.y >= cosMax)) continue;
      const material = surface.materialAt(x, z) as GroundMaterial;
      if (!materials.has(material)) continue;
      if ((surface.waterDepthAt?.(x, z) ?? 0) > 0) continue;
      const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * h(3);
      if (sightCheck && blocksSanctumSight({ x, z }, (kind === 'tree' ? 3.5 : 1.2) * scale)) continue;
      // The species / tint Region: picked by its share of the local density.
      let pickU = h(4) * density;
      let region: VegetationRegion = 'verdant';
      for (const r of VEGETATION_REGIONS) {
        region = r;
        pickU -= w[r] * VEGETATION_DENSITY[kind][r];
        if (pickU < 0) break;
      }
      let sub = 0;
      if (kind === 'tree') sub = pickArchetype(region, h(5));
      else if (kind === 'rock') sub = rocks[Math.min(rocks.length - 1, Math.floor(h(5) * rocks.length))] ?? 0;
      else if (kind === 'flower') sub = Math.floor(h(5) * 4) % 4;
      out.push(x, surface.heightAt(x, z), z, h(6) * Math.PI * 2, scale, encodeVariant(region, sub), h(7), h(8));
    }
  }
  return Float32Array.from(out);
}

/** Records kept at vegetation density `density` (0.4 / 1.0 / 1.6): keep value u < density ÷ 1.6. */
export function keptCount(records: Float32Array, density: number): number {
  const limit = density / MAX_VEGETATION_DENSITY;
  let n = 0;
  for (let r = 0; r < records.length; r += RECORD_STRIDE) if ((records[r + REC.keep] as number) < limit) n++;
  return n;
}

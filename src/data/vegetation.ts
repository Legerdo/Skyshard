/*
 * Vegetation data (design.md "식생·바위·소품", "품질 프리셋", "성능 예산"; Req 39.4, 39.5, 38.1, 38.5). What grows where
 * and how much: per-Region densities of the five instanced kinds (crossed-card grass, flowers, bushes, rocks, trees),
 * the surface rules each kind needs, the tree archetypes of each Region, the draw distances, and the Settings
 * vegetation step (density 0.4 / 1.0 / 1.6 ×, grass distance 45 / 70 / 90 m).
 *
 * Densities are instances per m² of eligible ground at 1.0 ×. The placer (src/render/vegetation/placement.ts) draws
 * its candidates once at the highest step (1.6 ×) and gives each a keep value u in [0, 1); a step keeps the
 * candidates with u < density / 1.6, so the lower steps are subsets of the higher ones and a settings change only
 * refilters instance buffers.
 *
 * Pure data: no three.js, DOM or Math.random.
 */

/** Settings' vegetation step (same union as Settings' `VegetationQuality`). */
export type VegetationStep = 'low' | 'medium' | 'high';

export interface VegetationStepDef {
  /** Density multiplier of every kind. */
  readonly density: number;
  /** Grass (and flowers) are drawn up to this camera distance (m). */
  readonly grassDistance: number;
}

export const VEGETATION_STEPS: Readonly<Record<VegetationStep, VegetationStepDef>> = {
  low: { density: 0.4, grassDistance: 45 },
  medium: { density: 1.0, grassDistance: 70 },
  high: { density: 1.6, grassDistance: 90 },
};

/** The highest density multiplier: the placer's candidate density. */
export const MAX_VEGETATION_DENSITY = 1.6;

/** The step's values; an unknown step reads as 'medium' (Default_Quality). */
export function vegetationStepFor(step: string): VegetationStepDef {
  return (VEGETATION_STEPS as Readonly<Record<string, VegetationStepDef | undefined>>)[step] ?? VEGETATION_STEPS.medium;
}

export const VEGETATION_KINDS = ['grass', 'flower', 'bush', 'rock', 'tree'] as const;
export type VegetationKind = (typeof VEGETATION_KINDS)[number];

/** Terrain-shaping Regions (the floating Sanctum grows nothing on the heightfield). */
export type VegetationRegion = 'verdant' | 'ember' | 'azure' | 'crater';
export const VEGETATION_REGIONS: readonly VegetationRegion[] = ['verdant', 'ember', 'azure', 'crater'];

/** Terrain surface materials (the physics TerrainMaterial union, kept local for the data layer). */
export type GroundMaterial = 'grass' | 'dirt' | 'rock' | 'sand' | 'ashRock' | 'crystal' | 'snow' | 'stone';

/** Instances per m² of eligible ground at density 1.0 ×. */
export const VEGETATION_DENSITY: Readonly<Record<VegetationKind, Readonly<Record<VegetationRegion, number>>>> = {
  grass: { verdant: 0.3, ember: 0.05, azure: 0.22, crater: 0.03 },
  flower: { verdant: 0.035, ember: 0.003, azure: 0.016, crater: 0.002 },
  bush: { verdant: 0.006, ember: 0.0025, azure: 0.004, crater: 0.0012 },
  rock: { verdant: 0.0022, ember: 0.0045, azure: 0.0032, crater: 0.0035 },
  tree: { verdant: 0.0045, ember: 0.0016, azure: 0.0035, crater: 0.0006 },
};

export interface VegetationRule {
  /** Steepest ground (deg) the kind stands on. */
  readonly maxSlopeDeg: number;
  /** Ground materials it grows on. */
  readonly materials: readonly GroundMaterial[];
  /** Clearance beyond the dirt path's half width (m). */
  readonly pathClearance: number;
  /** Added to every keep-out shape (buildings, POIs, pads …) for this kind (m). */
  readonly keepOutMargin: number;
  /** Clumping noise wavelength (m) and how strongly it thins the gaps (0 = even, 1 = only in clumps). */
  readonly clusterScale: number;
  readonly clusterStrength: number;
  /** Uniform scale range of an instance. */
  readonly scale: readonly [number, number];
  /** Farthest distance from the world centre it grows at (m). */
  readonly maxRadius: number;
}

export const VEGETATION_RULES: Readonly<Record<VegetationKind, VegetationRule>> = {
  grass: {
    maxSlopeDeg: 34, materials: ['grass', 'ashRock', 'stone'], pathClearance: 0.3, keepOutMargin: 0.3,
    clusterScale: 22, clusterStrength: 0.45, scale: [0.75, 1.25], maxRadius: 480,
  },
  flower: {
    maxSlopeDeg: 28, materials: ['grass'], pathClearance: 0.6, keepOutMargin: 0.5,
    clusterScale: 14, clusterStrength: 0.85, scale: [0.8, 1.2], maxRadius: 470,
  },
  bush: {
    maxSlopeDeg: 32, materials: ['grass', 'dirt', 'ashRock', 'stone', 'snow'], pathClearance: 1.5, keepOutMargin: 1.5,
    clusterScale: 30, clusterStrength: 0.6, scale: [0.7, 1.3], maxRadius: 480,
  },
  rock: {
    maxSlopeDeg: 42, materials: ['grass', 'dirt', 'rock', 'ashRock', 'stone', 'snow', 'crystal'], pathClearance: 1.5, keepOutMargin: 1.5,
    clusterScale: 40, clusterStrength: 0.5, scale: [0.5, 1.8], maxRadius: 520,
  },
  tree: {
    maxSlopeDeg: 30, materials: ['grass', 'dirt', 'ashRock', 'stone', 'snow'], pathClearance: 3.5, keepOutMargin: 4,
    clusterScale: 70, clusterStrength: 0.7, scale: [0.8, 1.25], maxRadius: 520,
  },
};

/** The three tree archetypes of each Region (design: Region마다 절차적 원형 3종) and their shares. */
export const TREE_ARCHETYPES: Readonly<Record<VegetationRegion, readonly { readonly id: string; readonly share: number }[]>> = {
  verdant: [{ id: 'broadleaf', share: 0.55 }, { id: 'birch', share: 0.35 }, { id: 'giant', share: 0.1 }],
  ember: [{ id: 'charredPine', share: 0.5 }, { id: 'crystalShrub', share: 0.3 }, { id: 'ashSnag', share: 0.2 }],
  azure: [{ id: 'windPine', share: 0.45 }, { id: 'blueSpruce', share: 0.4 }, { id: 'frostBirch', share: 0.15 }],
  crater: [{ id: 'gnarledSnag', share: 0.45 }, { id: 'dustAcacia', share: 0.35 }, { id: 'shardShrub', share: 0.2 }],
};

/** Rock variants (noise-displaced icosahedra) and how many of them one chunk draws (draw-call budget). */
export const ROCK_VARIANTS = 6;
export const ROCK_VARIANTS_PER_CHUNK = 2;

/**
 * Draw distances (m, from the camera to the chunk box). Grass and flowers follow the vegetation step; trees switch to
 * their one-blob canopy LOD beyond `treeNear` and disappear beyond `treeFar` (the fog has them by then); rocks switch
 * to one low-poly far rock beyond `rockNear` and disappear beyond `rock`. The far levels draw per far block of
 * FAR_BLOCK_CHUNKS × FAR_BLOCK_CHUNKS chunks (one instanced draw per block and far geometry, draw-call budget).
 */
export const VEGETATION_DISTANCES = {
  bush: 140,
  rockNear: 120,
  rock: 230,
  treeNear: 120,
  treeFar: 420,
} as const;

/** Chunks per side of a far block (4 × 4 chunks of 64 m: 256 m). */
export const FAR_BLOCK_CHUNKS = 4;

/** Wind: world direction (unit x / z), sway amplitude (m at a sway weight of 1) and the bend around the character. */
export const VEGETATION_WIND = { dirX: 0.8, dirZ: 0.6, strength: 0.16, bendRadius: 1 } as const;

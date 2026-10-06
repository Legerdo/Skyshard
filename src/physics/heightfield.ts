// Heightfield helpers for src/physics: slope/normal derivation from heightAt, plus small
// analytic heightfields for tests and harness scenes. Pure TypeScript (no three.js / DOM).

import { RAD2DEG, clamp } from '../core/math';
import type { Vec3 } from '../core/types';
import { MAX_WALKABLE_SLOPE_DEG, type Heightfield, type TerrainMaterial } from './types';

/** Half-width (m) of the central differences used by heightGradient. */
export const HEIGHT_GRADIENT_STEP = 0.05;

/** Partial derivatives of the height: dx = ∂h/∂x, dz = ∂h/∂z. */
export interface HeightGradient {
  dx: number;
  dz: number;
}

/** ∂h/∂x and ∂h/∂z by central differences of ±HEIGHT_GRADIENT_STEP. */
export function heightGradient(hf: Heightfield, x: number, z: number): HeightGradient {
  const s = HEIGHT_GRADIENT_STEP;
  return {
    dx: (hf.heightAt(x + s, z) - hf.heightAt(x - s, z)) / (2 * s),
    dz: (hf.heightAt(x, z + s) - hf.heightAt(x, z - s)) / (2 * s),
  };
}

/** Upward unit normal of the surface y = h(x, z) with the given gradient: normalize(−dx, 1, −dz). */
export function normalFromGradient(g: Readonly<HeightGradient>): Vec3 {
  // 0 − d keeps +0 (not −0) on flat ground.
  const nx = 0 - g.dx;
  const nz = 0 - g.dz;
  const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
  return { x: nx * inv, y: inv, z: nz * inv };
}

/** Upward unit surface normal at (x, z). */
export function heightNormal(hf: Heightfield, x: number, z: number): Vec3 {
  return normalFromGradient(heightGradient(hf, x, z));
}

/** Angle (degrees) between a unit normal and +Y. */
export function slopeDegFromNormal(n: Readonly<Vec3>): number {
  return Math.acos(clamp(n.y, -1, 1)) * RAD2DEG;
}

/** Terrain slope (degrees) at (x, z). */
export function heightSlopeDeg(hf: Heightfield, x: number, z: number): number {
  return slopeDegFromNormal(heightNormal(hf, x, z));
}

/** True when a slope (degrees) is standable. NaN is not. */
export function isWalkableSlope(slopeDeg: number): boolean {
  return slopeDeg <= MAX_WALKABLE_SLOPE_DEG;
}

/** Test helper: flat ground at height `y`, one material, walkable everywhere. */
export function flatHeightfield(y: number, material: TerrainMaterial = 'grass'): Heightfield {
  return {
    heightAt: () => y,
    materialAt: () => material,
    walkable: () => true,
  };
}

/**
 * Test helper: ground at `fn(x, z)`. `material` is a constant or a function of (x, z);
 * walkable wherever the slope is ≤ MAX_WALKABLE_SLOPE_DEG.
 */
export function analyticHeightfield(
  fn: (x: number, z: number) => number,
  material: TerrainMaterial | ((x: number, z: number) => TerrainMaterial) = 'grass',
): Heightfield {
  const hf: Heightfield = {
    heightAt: fn,
    materialAt: typeof material === 'function' ? material : () => material,
    walkable: (x, z) => isWalkableSlope(heightSlopeDeg(hf, x, z)),
  };
  return hf;
}

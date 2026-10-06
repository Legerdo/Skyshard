// Seeded 2D gradient noise (Perlin-style) and the fractal sums terrain heights are built from.
// Pure and deterministic: no Math.random, DOM or three.js; the lattice comes from createRng(seed).
import { createRng } from '../../core/rng';

/** Continuous scalar field over the XZ plane (noise-space units), roughly in [−1, 1]. */
export type Noise2D = (x: number, z: number) => number;

const PERM_SIZE = 256;
const PERM_MASK = PERM_SIZE - 1;
const DIAG = Math.SQRT1_2;
/** Eight unit gradients 45° apart, as x and z components indexed by `hash & 7`. */
const GRAD_X: readonly number[] = [1, DIAG, 0, -DIAG, -1, -DIAG, 0, DIAG];
const GRAD_Z: readonly number[] = [0, DIAG, 1, DIAG, 0, -DIAG, -1, -DIAG];
/** Unit-gradient 2D Perlin noise peaks at ±√2⁄2 (cell centre, aligned gradients); this maps it to ±1. */
const AMPLITUDE = Math.SQRT2;

/** Quintic fade 6t⁵ − 15t⁴ + 10t³: zero slope and curvature at cell edges, so the field is C². */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * 2D gradient noise on the integer lattice: a 256-entry permutation, Fisher–Yates-shuffled by
 * createRng(seed), hashes every lattice corner to one of eight gradients. The same seed always
 * yields the same field; it is 0 on lattice points, smooth everywhere, within [−1, 1], and it
 * repeats every 256 units.
 */
export function createNoise2D(seed: number): Noise2D {
  const rng = createRng(seed);
  const shuffled = new Uint8Array(PERM_SIZE);
  for (let i = 0; i < PERM_SIZE; i++) shuffled[i] = i;
  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const held = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = held;
  }
  // Doubled, so perm[perm[x + 1] + z + 1] never needs a second wrap.
  const perm = new Uint8Array(PERM_SIZE * 2);
  for (let i = 0; i < perm.length; i++) perm[i] = shuffled[i & PERM_MASK];

  const corner = (hash: number, dx: number, dz: number): number =>
    GRAD_X[hash & 7] * dx + GRAD_Z[hash & 7] * dz;

  return (x, z) => {
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const fx = x - cx;
    const fz = z - cz;
    const px = cx & PERM_MASK;
    const pz = cz & PERM_MASK;
    const a = perm[px] + pz;
    const b = perm[px + 1] + pz;
    const n00 = corner(perm[a], fx, fz);
    const n01 = corner(perm[a + 1], fx, fz - 1);
    const n10 = corner(perm[b], fx - 1, fz);
    const n11 = corner(perm[b + 1], fx - 1, fz - 1);
    const u = fade(fx);
    const near = n00 + u * (n10 - n00);
    const far = n01 + u * (n11 - n01);
    return AMPLITUDE * (near + fade(fz) * (far - near));
  };
}

/**
 * Fractal Brownian motion: `octaves` layers of `noise`, each at `lacunarity` × the previous
 * frequency and `gain` × its amplitude, divided by the total amplitude so the sum stays in [−1, 1].
 */
export function fbm(noise: Noise2D, x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let total = 0;
  let amp = 1;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, z * freq);
    total += Math.abs(amp);
    amp *= gain;
    freq *= lacunarity;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * Ridged fractal in [0, 1]: every octave adds (1 − |n|)², a sharp crest along the zero lines of
 * `noise`, at twice the previous frequency and half its weight; normalized by the total weight.
 */
export function ridged(noise: Noise2D, x: number, z: number, octaves = 4): number {
  let sum = 0;
  let total = 0;
  let amp = 1;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    const crest = 1 - Math.min(1, Math.abs(noise(x * freq, z * freq)));
    sum += amp * crest * crest;
    total += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return total > 0 ? sum / total : 0;
}

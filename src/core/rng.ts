// Seeded, reproducible randomness: mulberry32 generators, one independent stream per subsystem,
// so a change in how often one system draws never shifts another system's results, and the same
// seed + inputs replay identically (design: 난수 스트림 분리).
// Pure: no Math.random, DOM or three.js; src/logic and src/data may import this module.

/**
 * Deterministic PRNG. Each method consumes exactly one `next()` draw, regardless of its
 * arguments, except when it throws (throwing consumes nothing).
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /**
   * Uniform integer in [minIncl, maxIncl], both ends included. Fractional bounds are rounded
   * inward. Throws RangeError when a bound is non-finite or the range holds no integer.
   */
  int(minIncl: number, maxIncl: number): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** True with probability p: p <= 0 is never, p >= 1 is always. */
  chance(p: number): boolean;
  /** Uniformly chosen element. Throws RangeError on an empty array. */
  pick<T>(arr: readonly T[]): T;
  /** Seed this generator started from, coerced to uint32. */
  readonly seed: number;
  /** Current uint32 state; `createRng(rng.state())` continues this exact sequence (save/restore). */
  state(): number;
}

const UINT32_RANGE = 4294967296; // 2^32
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/**
 * mulberry32 generator. The seed is coerced to uint32 (`seed >>> 0`). Unlike the common
 * one-liner, the state is wrapped to 32 bits on every step, so it never loses integer
 * precision in long sessions; outputs match the reference implementation otherwise.
 */
export function createRng(seed: number): Rng {
  const initial = seed >>> 0;
  let s = initial;

  const next = (): number => {
    s = (s + MULBERRY32_INCREMENT) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };

  return {
    seed: initial,
    next,
    int(minIncl: number, maxIncl: number): number {
      const lo = Math.ceil(minIncl);
      const hi = Math.floor(maxIncl);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
        throw new RangeError(`Rng.int: no integer in [${minIncl}, ${maxIncl}]`);
      }
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    range(min: number, max: number): number {
      return min + (max - min) * next();
    },
    chance(p: number): boolean {
      return next() < p;
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new RangeError('Rng.pick: empty array');
      return arr[Math.floor(next() * arr.length)] as T;
    },
    state: (): number => s,
  };
}

const FNV_OFFSET_BASIS = 0x811c9dc5; // 2166136261
const FNV_PRIME = 0x01000193; // 16777619

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `s`, returned unsigned (`>>> 0`).
 * ASCII strings hash one byte per char; lone surrogates hash as U+FFFD, the same bytes
 * TextEncoder produces, so results match byte-oriented FNV-1a implementations.
 */
export function hashString(s: string): number {
  let h = FNV_OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      h = Math.imul(h ^ c, FNV_PRIME);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdfff) {
      const low = c <= 0xdbff && i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else {
        c = 0xfffd;
      }
    }
    // Leading byte, then continuation bytes from the high bits down.
    if (c < 0x800) {
      h = Math.imul(h ^ (0xc0 | (c >> 6)), FNV_PRIME);
    } else {
      if (c < 0x10000) {
        h = Math.imul(h ^ (0xe0 | (c >> 12)), FNV_PRIME);
      } else {
        h = Math.imul(h ^ (0xf0 | (c >> 18)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((c >> 12) & 0x3f)), FNV_PRIME);
      }
      h = Math.imul(h ^ (0x80 | ((c >> 6) & 0x3f)), FNV_PRIME);
    }
    h = Math.imul(h ^ (0x80 | (c & 0x3f)), FNV_PRIME);
  }
  return h >>> 0;
}

/** Seed of the named sub-stream of `master` (uint32): hashString(`${master >>> 0}:${name}`). */
export function deriveSeed(master: number, name: string): number {
  return hashString(`${master >>> 0}:${name}`);
}

/** Subsystems that draw from their own stream. */
export const RNG_STREAM_NAMES = ['combat', 'loot', 'ai', 'boss', 'world', 'fx', 'quest'] as const;
export type RngStreamName = (typeof RNG_STREAM_NAMES)[number];

/** One independent generator per subsystem, each seeded with deriveSeed(masterSeed, name). */
export function createRngStreams(masterSeed: number): Record<RngStreamName, Rng> {
  const stream = (name: RngStreamName): Rng => createRng(deriveSeed(masterSeed, name));
  return {
    combat: stream('combat'),
    loot: stream('loot'),
    ai: stream('ai'),
    boss: stream('boss'),
    world: stream('world'),
    fx: stream('fx'),
    quest: stream('quest'),
  };
}

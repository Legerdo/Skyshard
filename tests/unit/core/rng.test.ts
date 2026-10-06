import { describe, expect, it } from 'vitest';
import {
  RNG_STREAM_NAMES,
  createRng,
  createRngStreams,
  deriveSeed,
  hashString,
  type Rng,
} from '../../../src/core/rng';

const draw = (rng: Rng, count: number): number[] => Array.from({ length: count }, () => rng.next());

/** The widely used mulberry32 one-liner, as an independent reference for early outputs. */
function referenceMulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Byte-wise FNV-1a over TextEncoder's UTF-8 output in BigInt arithmetic, independent of hashString. */
function referenceFnv1a(s: string): number {
  let h = 0x811c9dc5n;
  for (const byte of new TextEncoder().encode(s)) {
    h = ((h ^ BigInt(byte)) * 0x01000193n) & 0xffffffffn;
  }
  return Number(h);
}

describe('createRng', () => {
  it('replays the identical first 100 values for the same seed', () => {
    expect(draw(createRng(20240601), 100)).toEqual(draw(createRng(20240601), 100));
  });

  it('produces different sequences for different seeds', () => {
    const base = draw(createRng(1), 100);
    for (const seed of [2, 3, 123456789, 0xffffffff]) {
      const other = draw(createRng(seed), 100);
      expect(other).not.toEqual(base);
      expect(other.filter((value, i) => value === base[i])).toEqual([]);
    }
  });

  it('matches the reference mulberry32 outputs', () => {
    for (const seed of [0, 1, 42, 0x7fffffff, 0xdeadbeef]) {
      const reference = referenceMulberry32(seed);
      const rng = createRng(seed);
      for (let i = 0; i < 1000; i++) expect(rng.next()).toBe(reference());
    }
  });

  it('coerces seeds to uint32 and resumes a sequence from state()', () => {
    expect(createRng(-1).seed).toBe(0xffffffff);
    expect(draw(createRng(2 ** 32 + 5), 20)).toEqual(draw(createRng(5), 20));
    expect(createRng(777).state()).toBe(777);

    const rng = createRng(777);
    draw(rng, 37);
    const resumed = createRng(rng.state());
    expect(draw(resumed, 50)).toEqual(draw(rng, 50));
  });

  it('keeps an exact 32-bit state over millions of draws', () => {
    const seed = 0xdeadbeef;
    const steps = 5_000_000;
    const rng = createRng(seed);
    for (let i = 0; i < steps; i++) rng.next();
    const expected = Number((BigInt(seed) + BigInt(steps) * 0x6d2b79f5n) % 2n ** 32n);
    expect(rng.state()).toBe(expected);
  });

  it('next() stays in [0, 1)', () => {
    const values = draw(createRng(99), 10_000);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(values.reduce((sum, v) => sum + v, 0) / values.length).toBeCloseTo(0.5, 1);
  });

  it('int() includes both bounds over 10,000 draws and only yields integers in range', () => {
    const rng = createRng(2024);
    const counts = new Map<number, number>();
    for (let i = 0; i < 10_000; i++) {
      const value = rng.int(3, 7);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7]);
    for (const count of counts.values()) expect(count).toBeGreaterThan(1500);

    const signed = new Set(Array.from({ length: 1000 }, () => rng.int(-2, 2)));
    expect([...signed].sort((x, y) => x - y)).toEqual([-2, -1, 0, 1, 2]);
    expect(rng.int(5, 5)).toBe(5);
    expect(new Set(Array.from({ length: 200 }, () => rng.int(0.5, 2.5)))).toEqual(new Set([1, 2]));
  });

  it('int() rejects ranges without an integer or with non-finite bounds', () => {
    const rng = createRng(1);
    expect(() => rng.int(3, 1)).toThrow(RangeError);
    expect(() => rng.int(0.2, 0.8)).toThrow(RangeError);
    expect(() => rng.int(0, Infinity)).toThrow(RangeError);
    expect(() => rng.int(Number.NaN, 1)).toThrow(RangeError);
  });

  it('range() stays in [min, max) and chance() follows its probability', () => {
    const rng = createRng(5);
    const values = Array.from({ length: 1000 }, () => rng.range(-2, 3));
    expect(values.every((v) => v >= -2 && v < 3)).toBe(true);

    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(0.25)) hits++;
    expect(hits / 10_000).toBeCloseTo(0.25, 1);
    expect(Array.from({ length: 200 }, () => rng.chance(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 200 }, () => rng.chance(1)).every(Boolean)).toBe(true);
  });

  it('pick() covers every element and throws on an empty array', () => {
    const rng = createRng(8);
    const items = ['ember', 'tide', 'gale', 'terra'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual([...items].sort());
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('consumes exactly one draw per call, and nothing when it throws', () => {
    const a = createRng(314);
    const b = createRng(314);
    a.int(1, 6);
    a.range(0, 1);
    a.chance(0);
    a.chance(1);
    a.pick([1, 2, 3]);
    draw(b, 5);
    expect(a.state()).toBe(b.state());
    expect(() => a.int(2, 1)).toThrow(RangeError);
    expect(() => a.pick([])).toThrow(RangeError);
    expect(a.state()).toBe(b.state());
  });
});

describe('hashString', () => {
  it('matches known FNV-1a 32-bit values and is stable', () => {
    expect(hashString('')).toBe(2166136261);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('foobar')).toBe(0xbf9cf968);
    expect(hashString('skyshard')).toBe(4092806666);
    expect(hashString('skyshard')).toBe(hashString('skyshard'));
    expect(hashString('skyshard')).not.toBe(hashString('Skyshard'));
  });

  it('hashes UTF-8 bytes like byte-oriented FNV-1a and returns an unsigned 32-bit integer', () => {
    const samples = ['', 'chest_verdant_3', '스카이샤드', 'é', '€', '𝄞 clef', 'lone \ud800 high', 'lone \udc00 low', 'x\ud83d'];
    for (const s of samples) {
      const h = hashString(s);
      expect(h, s).toBe(referenceFnv1a(s));
      expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, s).toBe(true);
    }
  });
});

describe('deriveSeed', () => {
  it('hashes "<master>:<name>" and separates names and masters', () => {
    expect(deriveSeed(42, 'combat')).toBe(hashString('42:combat'));
    expect(deriveSeed(-1, 'ai')).toBe(hashString('4294967295:ai'));
    expect(deriveSeed(42, 'combat')).toBe(deriveSeed(42, 'combat'));
    expect(deriveSeed(42, 'combat')).not.toBe(deriveSeed(42, 'loot'));
    expect(deriveSeed(42, 'combat')).not.toBe(deriveSeed(43, 'combat'));
  });
});

describe('createRngStreams', () => {
  it('creates one distinctly seeded stream per subsystem', () => {
    const streams = createRngStreams(42);
    expect(Object.keys(streams).sort()).toEqual([...RNG_STREAM_NAMES].sort());
    for (const name of RNG_STREAM_NAMES) expect(streams[name].seed).toBe(deriveSeed(42, name));
    expect(new Set(RNG_STREAM_NAMES.map((name) => streams[name].seed)).size).toBe(RNG_STREAM_NAMES.length);
    expect(draw(streams.combat, 20)).not.toEqual(draw(streams.loot, 20));
  });

  it('reproduces every stream from the same master seed', () => {
    const a = createRngStreams(9001);
    const b = createRngStreams(9001);
    for (const name of RNG_STREAM_NAMES) expect(draw(a[name], 50), name).toEqual(draw(b[name], 50));
  });

  it('keeps streams independent: consuming one never changes another sequence', () => {
    const untouched = createRngStreams(7);
    const busy = createRngStreams(7);
    draw(busy.combat, 1000);
    busy.ai.int(0, 10);
    for (const name of RNG_STREAM_NAMES) {
      if (name === 'combat' || name === 'ai') continue;
      expect(draw(busy[name], 100), name).toEqual(draw(untouched[name], 100));
    }
    expect(busy.combat.state()).not.toBe(untouched.combat.state());

    // Interleaved consumption of combat does not shift loot either.
    const interleaved = createRngStreams(7);
    const loot = Array.from({ length: 100 }, () => {
      interleaved.combat.next();
      return interleaved.loot.next();
    });
    expect(loot).toEqual(draw(createRngStreams(7).loot, 100));
  });
});

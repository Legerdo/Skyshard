import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { createNoise2D, fbm, ridged, type Noise2D } from '../../../src/world/terrain/noise';
import { WATER_BODIES, distanceToRiver, waterLevelAt, type RiverBody } from '../../../src/world/terrain/waterBodies';

// 2,000 fixed sample points over ±300 noise units, i.e. across several 256-unit permutation periods.
const rng = createRng(20240601);
const POINTS = Array.from({ length: 2000 }, () => ({ x: rng.range(-300, 300), z: rng.range(-300, 300) }));
const sample = (f: Noise2D): number[] => POINTS.map((p) => f(p.x, p.z));
const spread = (values: readonly number[]): number => Math.max(...values) - Math.min(...values);

describe('createNoise2D', () => {
  it('replays the same field for the same seed and a different one for another seed', () => {
    expect(sample(createNoise2D(7))).toEqual(sample(createNoise2D(7)));
    const a = sample(createNoise2D(1));
    const b = sample(createNoise2D(2));
    expect(a.filter((v, i) => v !== b[i]).length).toBeGreaterThan(POINTS.length * 0.9);
  });

  it('stays within [−1.2, 1.2] over 2,000 samples and uses most of that range', () => {
    const values = sample(createNoise2D(42));
    expect(values.filter((v) => !(Math.abs(v) <= 1.2))).toEqual([]);
    expect(Math.min(...values)).toBeLessThan(-0.4);
    expect(Math.max(...values)).toBeGreaterThan(0.4);
  });

  it('is continuous: a 0.01 step along x or z changes the value by less than 0.05', () => {
    const noise = createNoise2D(42);
    const step = (x: number, z: number, dx: number, dz: number): number => Math.abs(noise(x + dx, z + dz) - noise(x, z));
    expect(Math.max(...POINTS.flatMap((p) => [step(p.x, p.z, 0.01, 0), step(p.x, p.z, 0, 0.01)]))).toBeLessThan(0.05);
  });
});

describe('fbm and ridged', () => {
  const noise = createNoise2D(99);
  it('fbm stays normalized within [−1, 1] with default and custom parameters', () => {
    for (const values of [sample((x, z) => fbm(noise, x, z)), sample((x, z) => fbm(noise, x, z, 6, 2.2, 0.45))]) {
      expect(values.filter((v) => !(v >= -1 && v <= 1))).toEqual([]);
      expect(spread(values)).toBeGreaterThan(0.5);
    }
  });

  it('ridged stays within [0, 1]', () => {
    const values = sample((x, z) => ridged(noise, x, z));
    expect(values.filter((v) => !(v >= 0 && v <= 1))).toEqual([]);
    expect(spread(values)).toBeGreaterThan(0.3);
  });
});

describe('waterLevelAt', () => {
  it('reports lake_azure level 70 inside the lake and null outside it', () => {
    expect([waterLevelAt(-200, -300), waterLevelAt(-141, -300), waterLevelAt(-200, -241)]).toEqual([70, 70, 70]);
    expect([waterLevelAt(-139, -300), waterLevelAt(-200, -370), waterLevelAt(0, 0)]).toEqual([null, null, null]);
  });

  it('interpolates the river level on its centreline and is dry 10 m off it', () => {
    const [river] = WATER_BODIES.filter((b): b is RiverBody => b.id === 'river_verdant' && b.kind === 'river');
    // Midpoint of the segment (−420, 280, 24) → (−450, 350, 20), well clear of pond_verdant.
    expect(waterLevelAt(-435, 315)).toBeCloseTo(22, 9);
    expect(waterLevelAt(-420, 280)).toBeCloseTo(24, 9);
    const len = Math.hypot(-30, 70);
    const off = (d: number): [number, number] => [-435 + (70 / len) * d, 315 + (30 / len) * d];
    expect(distanceToRiver(...off(10), river).dist).toBeCloseTo(10, 9);
    expect(waterLevelAt(...off(3.5))).toBeCloseTo(22, 9);
    expect(waterLevelAt(...off(10))).toBeNull();
    // The river rises inside pond_verdant (level 30): the higher pond surface wins there.
    expect(waterLevelAt(-385, 215)).toBe(30);
  });
});

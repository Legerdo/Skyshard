// Feature: skyshard-echoes-of-the-wild, Property 26: 지도 안개 공개
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FOG_CELL, FOG_EXTENT, FOG_GRID, FogOfWar } from '../../src/logic/fogOfWar';

/** Half the 8 m cell diagonal (4√2 ≈ 5.657 m), rounded up as in the property. */
const HALF_DIAGONAL = 5.66;
const edge = (i: number): number => -FOG_EXTENT + i * FOG_CELL;
const center = (i: number): number => edge(i) + FOG_CELL / 2;
const inWorld = (v: number): boolean => v >= -FOG_EXTENT && v <= FOG_EXTENT;

/** One '0' / '1' per cell in index order (z row, x column), read at the cell centers. */
function mask(f: FogOfWar): string {
  let out = '';
  for (let j = 0; j < FOG_GRID; j++) {
    for (let i = 0; i < FOG_GRID; i++) out += f.isRevealed(center(i), center(j)) ? '1' : '0';
  }
  return out;
}

/** First cell revealed in `before` but hidden in `after`, or −1. */
function lostCell(before: string, after: string): number {
  for (let k = 0; k < before.length; k++) if (before[k] === '1' && after[k] !== '1') return k;
  return -1;
}

/**
 * First cell hidden in mask `m` whose closed square comes within `reach` of (x, z), or −1. Every in-world point
 * within `reach` lies in such a cell, so this checks all of those points.
 */
function missedCell(m: string, x: number, z: number, reach: number): number {
  for (let j = 0; j < FOG_GRID; j++) {
    const dz = Math.min(Math.max(z, edge(j)), edge(j + 1)) - z;
    for (let i = 0; i < FOG_GRID; i++) {
      const dx = Math.min(Math.max(x, edge(i)), edge(i + 1)) - x;
      if (dx * dx + dz * dz <= reach * reach && m[j * FOG_GRID + i] !== '1') return j * FOG_GRID + i;
    }
  }
  return -1;
}

/** Uniform on a 1 mm grid (fc.double clusters near 0). */
const arbMeters = (min: number, max: number) =>
  fc.integer({ min: min * 1000, max: max * 1000 }).map((mm) => mm / 1000);

const arbCoord = fc.oneof(
  { arbitrary: arbMeters(-700, 700), weight: 3 }, // centers up to 140 m outside the world
  { arbitrary: fc.integer({ min: -140, max: 140 }).map((k) => k * 4), weight: 1 }, // cell edges and centers
);
const arbRadius = fc.oneof(
  { arbitrary: arbMeters(0, 260), weight: 3 },
  { arbitrary: fc.constantFrom(0, 4, 5.66, 8, 40, 200), weight: 1 },
);
/** Probe point: a fraction of r − 5.66 m from the center and a bearing in degrees. */
const arbSample = fc.tuple(fc.integer({ min: 0, max: 1000 }).map((t) => t / 1000), fc.integer({ min: 0, max: 359 }));

/** arbRevealOps: reveal(x, z, r) calls, each with probe points. */
const arbRevealOps = fc.array(
  fc.record({ x: arbCoord, z: arbCoord, r: arbRadius, samples: fc.array(arbSample, { maxLength: 4 }) }),
  { minLength: 1, maxLength: 8 },
);

describe('Property 26: map fog reveal', () => {
  it('round-trips through encode/decode, never hides a cell, repeats return 0 and covers r − 5.66 m', () => {
    let revealingRuns = 0;
    fc.assert(
      fc.property(arbRevealOps, (ops) => {
        const f = new FogOfWar();
        let cells = mask(f);
        for (const { x, z, r } of ops) {
          const count = f.revealedCount();
          const added = f.reveal(x, z, r);
          expect(added).toBeGreaterThanOrEqual(0);
          expect(f.revealedCount()).toBe(count + added);
          expect(f.reveal(x, z, r)).toBe(0);
          const next = mask(f);
          expect(lostCell(cells, next)).toBe(-1);
          cells = next;
        }
        expect(cells.split('1').length - 1).toBe(f.revealedCount());
        expect(mask(FogOfWar.decode(f.encode()))).toBe(cells);

        for (const { x, z, r, samples } of ops) {
          const reach = r - HALF_DIAGONAL;
          if (reach < 0) continue;
          expect(missedCell(cells, x, z, reach)).toBe(-1);
          for (const [t, deg] of samples) {
            const px = x + t * reach * Math.cos((deg * Math.PI) / 180);
            const pz = z + t * reach * Math.sin((deg * Math.PI) / 180);
            if (inWorld(px) && inWorld(pz)) expect(f.isRevealed(px, pz), `${px}, ${pz}`).toBe(true);
          }
        }
        if (f.revealedCount() > 0) revealingRuns++;
      }),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: most sequences must reveal something.
    expect(revealingRuns).toBeGreaterThan(100);
  });
});

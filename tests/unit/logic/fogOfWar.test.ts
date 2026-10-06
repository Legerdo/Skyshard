import { describe, expect, it } from 'vitest';
import { FOG_CELL, FOG_EXTENT, FOG_GRID, FogOfWar, cellIndex } from '../../../src/logic/fogOfWar';

const ALL = FOG_GRID * FOG_GRID;
const fresh = (x: number, z: number, r: number): number => new FogOfWar().reveal(x, z, r);
const full = (): Uint8Array => new Uint8Array(ALL / 8).fill(0xff);

describe('cellIndex', () => {
  it('is ⌊(z + 560) / 8⌋ × 140 + ⌊(x + 560) / 8⌋ with 560 clamped to the last cell', () => {
    expect([FOG_CELL, FOG_GRID, FOG_EXTENT]).toEqual([8, 140, 560]);
    expect([cellIndex(-560, -560), cellIndex(-552.001, -560), cellIndex(-552, -560)]).toEqual([0, 0, 1]);
    expect([cellIndex(0, 0), cellIndex(559.99, -560), cellIndex(560, -560)]).toEqual([70 * 140 + 70, 139, 139]);
    expect([cellIndex(-560, 560), cellIndex(560, 560)]).toEqual([139 * 140, ALL - 1]);
  });

  it('is −1 outside the world or for non-finite input', () => {
    const outside = [[560.001, 0], [-560.001, 0], [0, 561], [0, -600], [NaN, 0], [0, Infinity], [-Infinity, 0]];
    for (const [x, z] of outside) expect(cellIndex(x, z), `${x}, ${z}`).toBe(-1);
  });
});

describe('reveal', () => {
  it('reveals every cell whose center lies within r, inclusive', () => {
    expect(fresh(0, 0, 4)).toBe(0); // the nearest centers are 4√2 ≈ 5.657 m away
    expect(fresh(0, 0, 5.66)).toBe(4);
    expect(fresh(4, 4, 0)).toBe(1); // exactly on a center
    expect(fresh(4, 4, 8)).toBe(5);
    expect(fresh(4, 4, 40)).toBe(81); // lattice points with a² + b² ≤ 25
    expect(fresh(0, 0, 40)).toBe(80);
    expect(fresh(0, 0, 800)).toBe(ALL); // the farthest center is 786 m out
  });

  it('returns only newly revealed cells, so a repeated reveal returns 0', () => {
    const f = new FogOfWar();
    expect([f.reveal(4, 4, 40), f.reveal(4, 4, 40)]).toEqual([81, 0]);
    expect(f.reveal(12, 4, 40)).toBe(11); // one new cell per row of the shifted disc
    expect(f.revealedCount()).toBe(92);
    expect([f.isRevealed(52, 4), f.isRevealed(55.9, 7.9), f.isRevealed(56, 4)]).toEqual([true, true, false]);
  });

  it('returns 0 for non-finite input or a negative radius', () => {
    const f = new FogOfWar();
    const bad = [[NaN, 0, 10], [0, Infinity, 10], [0, 0, Infinity], [0, 0, NaN], [4, 4, -1]];
    expect(bad.map(([x, z, r]) => f.reveal(x, z, r))).toEqual([0, 0, 0, 0, 0]);
    expect(f.revealedCount()).toBe(0);
  });

  it('reveals edge cells from centers outside the world; 560 reads the last cell, outside reads false', () => {
    const f = new FogOfWar();
    expect(f.reveal(600, 4, 44)).toBe(1); // only the center (556, 4)
    const probes = [f.isRevealed(552, 0), f.isRevealed(560, 4), f.isRevealed(551.99, 4), f.isRevealed(560.01, 4)];
    expect(probes).toEqual([true, true, false, false]);
    expect(f.reveal(556, 556, 0)).toBe(1);
    expect([f.isRevealed(560, 560), f.isRevealed(NaN, 560), f.isRevealed(560, 560.5)]).toEqual([true, false, false]);
  });
});

describe('encode / decode', () => {
  it('encodes the 2,450-byte bitset as 3,268 base64 characters, cell 0 in the lowest bit', () => {
    const f = new FogOfWar();
    expect(f.encode()).toBe(`${'A'.repeat(3267)}=`);
    f.reveal(-556, -556, 0);
    expect([f.encode().length, f.encode().slice(0, 4)]).toEqual([3268, 'AQAA']);
    f.reveal(0, 0, 800);
    expect(f.encode()).toBe(`${'/'.repeat(3266)}8=`);
  });

  it('decodes invalid input to an all-hidden fog without throwing', () => {
    const s = new FogOfWar(full()).encode();
    const bad: unknown[] = ['', 'garbage', s.slice(1), `${s}=`, `*${s.slice(1)}`, `${s.slice(0, -1)}/`];
    bad.push(`${s.slice(0, 9)}=${s.slice(10)}`, `${'é'.repeat(3267)}=`, null, undefined, 42);
    for (const g of bad) expect(FogOfWar.decode(g as string).revealedCount(), String(g).slice(0, 12)).toBe(0);
    expect(FogOfWar.decode(s).revealedCount()).toBe(ALL);
  });

  it('round-trips; clone and the constructor copy their source', () => {
    const f = new FogOfWar();
    [[-130, 250, 200], [200, 60, 40], [-560, 560, 13]].forEach(([x, z, r]) => f.reveal(x, z, r));
    const back = FogOfWar.decode(f.encode());
    expect([back.encode(), back.revealedCount()]).toEqual([f.encode(), f.revealedCount()]);
    const copy = f.clone();
    expect(copy.reveal(500, -500, 30)).toBeGreaterThan(0);
    expect([f.isRevealed(500, -500), copy.isRevealed(500, -500)]).toEqual([false, true]);
    const bytes = full();
    const owned = new FogOfWar(bytes);
    bytes.fill(0);
    expect([owned.revealedCount(), new FogOfWar(full().subarray(1)).revealedCount()]).toEqual([ALL, 0]);
  });
});

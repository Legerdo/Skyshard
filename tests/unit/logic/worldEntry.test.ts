import { describe, expect, it } from 'vitest';
import type { RegionId } from '../../../src/data/ids';
import { areaVisitedFlag, newAreaEntries, stepRegion } from '../../../src/logic/worldEntry';

// Region and area entry rules (task 4.5; Req 8.7).
const all = (): boolean => true;

describe('stepRegion', () => {
  it('enters a Region the first time only when it is not discovered yet', () => {
    expect(stepRegion(null, 'verdant', all, [])).toEqual({ region: 'verdant', entered: { regionId: 'verdant', first: true } });
    expect(stepRegion('crater', 'verdant', all, ['verdant'])).toEqual({ region: 'verdant', entered: { regionId: 'verdant', first: false } });
  });

  it('keeps the current Region while staying in it, in a border strip or at a locked Region', () => {
    expect(stepRegion('verdant', 'verdant', all, [])).toEqual({ region: 'verdant', entered: null });
    expect(stepRegion('verdant', null, all, [])).toEqual({ region: 'verdant', entered: null });
    const locked = (r: RegionId): boolean => r !== 'azure';
    expect(stepRegion('crater', 'azure', locked, [])).toEqual({ region: 'crater', entered: null });
  });

  it('does not enter the Region it just came back to from a border strip', () => {
    const strip = stepRegion('verdant', null, all, ['verdant']);
    expect(stepRegion(strip.region, 'verdant', all, ['verdant']).entered).toBeNull();
  });
});

describe('newAreaEntries', () => {
  it('reports areas entered this tick, first when never visited', () => {
    const visited = new Set(['b']);
    expect(newAreaEntries(new Set(), ['a', 'b'], (id) => visited.has(id))).toEqual([
      { id: 'a', first: true },
      { id: 'b', first: false },
    ]);
  });

  it('does not report areas the feet stay in, and reports each area once', () => {
    expect(newAreaEntries(new Set(['a']), ['a', 'c', 'c'], () => false)).toEqual([{ id: 'c', first: true }]);
    expect(newAreaEntries(new Set(['a']), [], () => false)).toEqual([]);
  });

  it('names the GameState flag of a visited area', () => {
    expect(areaVisitedFlag('hollowroot')).toBe('entered_hollowroot');
  });
});

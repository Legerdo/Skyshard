import { describe, expect, it } from 'vitest';
import { MUSIC_TRACK_IDS } from '../../src/data/music';
import { differingAspects, MAIN_REGION_IDS, REGION_ASPECTS, REGION_PROFILES, type RegionProfile } from '../../src/data/regions';

// Task 20.4 (Req 8.2): every pair of main Regions differs in at least 6 of the 9 aspects (terrain, palette,
// vegetation, architecture, enemies, movement, hazards, music, Landmarks), compared on the Region definition data.

const PAIRS = MAIN_REGION_IDS.flatMap((a, i) => MAIN_REGION_IDS.slice(i + 1).map((b) => [a, b] as const));

describe('Region identities (Req 8.2)', () => {
  it('compares the nine aspects', () => {
    expect(REGION_ASPECTS).toHaveLength(9);
    expect(PAIRS).toHaveLength(3);
  });

  it.each(PAIRS)('%s and %s differ in at least 6 aspects', (a, b) => {
    const differing = differingAspects(REGION_PROFILES[a], REGION_PROFILES[b]);
    expect(differing.length, `same: ${REGION_ASPECTS.filter((k) => !differing.includes(k)).join(', ')}`).toBeGreaterThanOrEqual(6);
  });

  it.each(MAIN_REGION_IDS)('%s has every aspect filled from its data', (id) => {
    const p = REGION_PROFILES[id];
    expect(p.terrain.maxY).toBeGreaterThan(p.terrain.minY);
    for (const list of [p.vegetation, p.architecture, p.enemies, p.movement, p.hazards, p.landmarks]) expect(list.length).toBeGreaterThan(0);
    expect(MUSIC_TRACK_IDS as readonly string[]).toContain(p.music);
  });

  it('counts an aspect as the same only when its values match (arrays as sets)', () => {
    const base = REGION_PROFILES.verdant;
    const twin: RegionProfile = { ...base, vegetation: [...base.vegetation].reverse() };
    expect(differingAspects(base, twin)).toEqual([]);
    const other: RegionProfile = { ...base, palette: { ...base.palette, accent: 0 }, music: 'mus_ember' };
    expect(differingAspects(base, other)).toEqual(['palette', 'music']);
  });
});

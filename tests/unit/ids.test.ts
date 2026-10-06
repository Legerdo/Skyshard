import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BARRIER_IDS,
  BOSS_IDS,
  BOSS_NAMES,
  CHALLENGE_AREA_IDS,
  CHALLENGE_AREA_NAMES,
  CHARACTER_IDS,
  CHARACTER_NAMES,
  ELEMENT_IDS,
  ELEMENT_NAMES,
  ELITE_IDS,
  ELITE_NAMES,
  ENEMY_IDS,
  ENEMY_NAMES,
  LANDMARK_IDS,
  LANDMARK_NAMES,
  MAIN_STAGE_IDS,
  MAIN_STAGE_NAMES,
  NPC_IDS,
  NPC_NAMES,
  REACTION_IDS,
  REACTION_NAMES,
  REGION_IDS,
  REGION_NAMES,
  SIDE_QUEST_IDS,
  SIDE_QUEST_NAMES,
  WAYSTONE_IDS,
  WAYSTONE_NAMES,
  isBarrierId,
  isBossId,
  isChallengeAreaId,
  isCharacterId,
  isElementId,
  isEliteId,
  isEnemyId,
  isLandmarkId,
  isMainStageId,
  isNpcId,
  isReactionId,
  isRegionId,
  isSideQuestId,
  isWaystoneId,
  makeGuard,
} from '../../src/data/ids';

interface Registry {
  readonly name: string;
  readonly ids: readonly string[];
  /** Number of IDs listed in design.md's Canonical ID Registry. */
  readonly count: number;
  readonly guard: (value: unknown) => boolean;
  readonly names: Readonly<Record<string, string>> | null;
}

const REGISTRIES: readonly Registry[] = [
  { name: 'CHARACTER_IDS', ids: CHARACTER_IDS, count: 4, guard: isCharacterId, names: CHARACTER_NAMES },
  { name: 'ELEMENT_IDS', ids: ELEMENT_IDS, count: 4, guard: isElementId, names: ELEMENT_NAMES },
  { name: 'REACTION_IDS', ids: REACTION_IDS, count: 6, guard: isReactionId, names: REACTION_NAMES },
  { name: 'REGION_IDS', ids: REGION_IDS, count: 5, guard: isRegionId, names: REGION_NAMES },
  {
    name: 'CHALLENGE_AREA_IDS',
    ids: CHALLENGE_AREA_IDS,
    count: 3,
    guard: isChallengeAreaId,
    names: CHALLENGE_AREA_NAMES,
  },
  { name: 'NPC_IDS', ids: NPC_IDS, count: 7, guard: isNpcId, names: NPC_NAMES },
  { name: 'ENEMY_IDS', ids: ENEMY_IDS, count: 8, guard: isEnemyId, names: ENEMY_NAMES },
  { name: 'ELITE_IDS', ids: ELITE_IDS, count: 6, guard: isEliteId, names: ELITE_NAMES },
  { name: 'BOSS_IDS', ids: BOSS_IDS, count: 1, guard: isBossId, names: BOSS_NAMES },
  { name: 'MAIN_STAGE_IDS', ids: MAIN_STAGE_IDS, count: 10, guard: isMainStageId, names: MAIN_STAGE_NAMES },
  { name: 'SIDE_QUEST_IDS', ids: SIDE_QUEST_IDS, count: 3, guard: isSideQuestId, names: SIDE_QUEST_NAMES },
  { name: 'WAYSTONE_IDS', ids: WAYSTONE_IDS, count: 6, guard: isWaystoneId, names: WAYSTONE_NAMES },
  { name: 'BARRIER_IDS', ids: BARRIER_IDS, count: 5, guard: isBarrierId, names: null },
  { name: 'LANDMARK_IDS', ids: LANDMARK_IDS, count: 8, guard: isLandmarkId, names: LANDMARK_NAMES },
];

type NamedRegistry = Registry & { readonly names: Readonly<Record<string, string>> };
const NAMED_REGISTRIES = REGISTRIES.filter((r): r is NamedRegistry => r.names !== null);

const ALL_IDS = REGISTRIES.flatMap((r) => r.ids);

describe('Canonical ID Registry', () => {
  it.each(REGISTRIES)('$name lists $count unique, well-formed ids', ({ ids, count }) => {
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !/^[a-z][A-Za-z0-9_]*$/.test(id))).toEqual([]);
  });

  it('shares no id string between registries except ember (ElementId and RegionId)', () => {
    const shared = ALL_IDS.filter((id, index) => ALL_IDS.indexOf(id) !== index);
    expect(shared).toEqual(['ember']);
  });

  it.each(NAMED_REGISTRIES)('$name has exactly one distinct, non-empty display name per id', ({ ids, names }) => {
    expect(Object.keys(names).sort()).toEqual([...ids].sort());
    const values = Object.values(names);
    expect(values.filter((value) => value.trim() === '' || value !== value.trim())).toEqual([]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('follows the naming conventions of the design', () => {
    expect(MAIN_STAGE_IDS).toEqual(Array.from({ length: 10 }, (_, i) => `ms${i + 1}`));
    for (const id of SIDE_QUEST_IDS) {
      expect(id.startsWith('sq_') && isNpcId(id.slice('sq_'.length)), id).toBe(true);
    }
    for (const id of BARRIER_IDS) {
      const [, region] = /^(?:gate|veil|seal)_(.+)$/.exec(id) ?? [];
      expect(isRegionId(region), id).toBe(true);
    }
    expect(WAYSTONE_IDS.filter((id) => !id.startsWith('ws_'))).toEqual([]);
    expect(LANDMARK_IDS.filter((id) => !id.startsWith('lm_'))).toEqual([]);
  });
});

describe('ID type guards', () => {
  it.each(REGISTRIES)('guard for $name accepts every member', ({ ids, guard }) => {
    expect(ids.filter((id) => !guard(id))).toEqual([]);
  });

  it.each(REGISTRIES)('guard for $name rejects other ids, near misses and non-strings', ({ ids, guard }) => {
    const [sample = ''] = ids;
    const nonMembers: unknown[] = [
      ...ALL_IDS.filter((id) => !ids.includes(id)),
      '',
      sample.toUpperCase(),
      ` ${sample}`,
      `${sample} `,
      `${sample}_x`,
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      undefined,
      null,
      0,
      1,
      true,
      Symbol(sample),
      {},
      [sample],
      new String(sample),
      { toString: () => sample },
    ];
    expect(nonMembers.filter((value) => guard(value))).toEqual([]);
  });

  it('guards agree with registry membership for arbitrary values', () => {
    fc.assert(
      fc.property(fc.oneof(fc.anything(), fc.constantFrom(...ALL_IDS)), (value) =>
        REGISTRIES.every((r) => r.guard(value) === (typeof value === 'string' && r.ids.includes(value))),
      ),
    );
  });

  it('makeGuard narrows to the members of any id tuple', () => {
    const isAb = makeGuard(['a', 'b'] as const);
    const value: unknown = 'b';
    expect(isAb('a')).toBe(true);
    expect(isAb('c')).toBe(false);
    if (isAb(value)) {
      const narrowed: 'a' | 'b' = value;
      expect(narrowed).toBe('b');
    } else {
      expect.unreachable('b is a member');
    }
  });
});

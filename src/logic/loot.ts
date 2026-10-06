// Chest rewards (design "Chest와 보상표", Req 10.5, 10.6). Deterministic: every chest draws from its
// own mulberry32 stream seeded with hashString(chestId), not the loot drop stream, so reloading a
// save and reopening the chest yields the same rewards.
// Enemy drops (design "적 드롭", Req 28.13): the kind's drop table rolled on the loot drop stream.
import { createRng, hashString, type Rng } from '../core/rng';
import { ENEMY_DROPS } from '../data/enemies';
import type { EliteId, EnemyId, ItemId } from '../data/ids';

export type ChestTier = 'common' | 'fine' | 'glowing';

export type Reward = { kind: 'glim'; amount: number } | { kind: 'item'; id: ItemId; count: number };

const HERB_DUMPLING: ItemId = 'con_herbDumpling';
const STARMOTE: ItemId = 'mat_starmote';

/** Reward table; [min, max] ranges are inclusive, drawn as uniform integers. */
export const CHEST_REWARDS = {
  common: { glim: [30, 60], herbChance: 0.5 },
  fine: { glim: [60, 120], starmote: [2, 3] },
  /** Glowing chest without a designated item, or whose item is already owned. */
  glowingFallback: { glim: 200, starmote: 5 },
} as const;

/**
 * Rewards for opening `chestId`. common: Glim 30–60, 50% one herb dumpling; fine: Glim 60–120 +
 * Starmote 2–3; glowing: `glowingItem` when given and not in `owned`, else Starmote 5 + Glim 200.
 */
export function rollChest(
  tier: ChestTier,
  chestId: string,
  owned: ReadonlySet<ItemId>,
  glowingItem?: ItemId,
): Reward[] {
  const rng = createRng(hashString(chestId));
  if (tier === 'common') {
    const { glim, herbChance } = CHEST_REWARDS.common;
    const rewards: Reward[] = [{ kind: 'glim', amount: rng.int(glim[0], glim[1]) }];
    if (rng.chance(herbChance)) rewards.push({ kind: 'item', id: HERB_DUMPLING, count: 1 });
    return rewards;
  }
  if (tier === 'fine') {
    const { glim, starmote } = CHEST_REWARDS.fine;
    return [
      { kind: 'glim', amount: rng.int(glim[0], glim[1]) },
      { kind: 'item', id: STARMOTE, count: rng.int(starmote[0], starmote[1]) },
    ];
  }
  if (glowingItem !== undefined && !owned.has(glowingItem)) return [{ kind: 'item', id: glowingItem, count: 1 }];
  const { glim, starmote } = CHEST_REWARDS.glowingFallback;
  return [
    { kind: 'item', id: STARMOTE, count: starmote },
    { kind: 'glim', amount: glim },
  ];
}

/**
 * The chance drops of one defeated `kind` (its ENEMY_DROPS lines, in table order): each line draws exactly one
 * `rng.chance(chance)`, so a line that always drops (Elites' Starmote ×3) still advances the stream the same way
 * and a kind's draw count never depends on earlier results. XP and Glim are the EnemyDef's fixed values, not
 * rolled here. Kinds without a table drop nothing and draw nothing.
 */
export function rollEnemyDrop(kind: EnemyId | EliteId, rng: Rng): Reward[] {
  const drops: Reward[] = [];
  for (const line of ENEMY_DROPS[kind] ?? []) {
    if (rng.chance(line.chance) && line.count > 0) drops.push({ kind: 'item', id: line.item, count: line.count });
  }
  return drops;
}

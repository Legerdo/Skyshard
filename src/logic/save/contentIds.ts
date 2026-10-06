/*
 * Which ids the content defines, for the save repair and validation (design "보정 규칙": ids no content defines are
 * dropped). Built from the data modules; the POI, hidden-place, Echo_Tablet and Chest lists come from src/data/pois.ts
 * (task 20.1). Every category also keeps its id-format fallback from src/data/ids.ts and the design (cinematics have
 * only the format until src/data/cinematics.ts lands), so saves made with a newer placement table are not stripped.
 * Pure.
 */
import { checkpointById, CHALLENGE_AREA_DEFS } from '../../data/challengeAreas';
import {
  CHALLENGE_AREA_IDS, ELITE_IDS, LANDMARK_IDS, NPC_IDS, REACTION_IDS, REGION_IDS, WAYSTONE_IDS, type ChallengeAreaId,
  type ItemId,
} from '../../data/ids';
import { ITEM_BY_ID, type ItemDef } from '../../data/items';
import { CHESTS, ECHO_TABLETS, HIDDEN_PLACES, POIS } from '../../data/pois'; // task 20.1
import { puzzleDefsFor } from '../../data/puzzles';
import { SIDE_QUEST_PUZZLES } from '../../data/sideQuests';
import { CAMPS, ENCOUNTER_GROUPS, SPAWNERS } from '../../data/spawns';
import { TUTORIAL_HINT_IDS } from '../../data/tutorials';
import { WAYSTONES } from '../../data/waystones';
import { THISTLEWICK_HEARTH, type SpotDef } from '../../data/worldLayout';

const REGION_ALT = REGION_IDS.join('|');
const CHEST_FORMAT = new RegExp(`^chest_(?:(?:${REGION_ALT})_\\d+|pz_[a-z]+_\\d+)$`);
const TABLET_FORMAT = new RegExp(`^tab_(?:${REGION_ALT})_\\d+$`);
const POI_FORMAT = new RegExp(`^(?:poi_(?:${REGION_ALT})_\\d+|(?:chest|camp|pz|tab|vista|ws|lm|hidden)_[A-Za-z0-9_]+)$`);
const HIDDEN_FORMAT = /^(?:hidden|poi)_[A-Za-z0-9_]+$/;
const CINEMATIC_FORMAT = /^cin_[A-Za-z0-9_]+$/;
const CAMP_FORMAT = new RegExp(`^camp_(?:${REGION_ALT})_\\d+$`);

const NPC_SET: ReadonlySet<string> = new Set(NPC_IDS);
const ELITE_SET: ReadonlySet<string> = new Set(ELITE_IDS);

export const isKnownItem = (id: unknown): id is ItemId => typeof id === 'string' && ITEM_BY_ID.has(id as ItemId);
export const itemDef = (id: string): ItemDef | undefined => ITEM_BY_ID.get(id as ItemId);
export const isEquipmentItem = (id: string): boolean => {
  const k = itemDef(id)?.kind;
  return k === 'weapon' || k === 'charm' || k === 'relic';
};
/** Consumables and materials: what `inventory.items` counts. */
export const isStackItem = (id: string): boolean => {
  const k = itemDef(id)?.kind;
  return k === 'consumable' || k === 'material';
};

const CAMP_IDS: ReadonlySet<string> = new Set([
  ...CAMPS.map((c) => c.id),
  ...ENCOUNTER_GROUPS.map((g) => g.id),
  ...SPAWNERS.flatMap((s) => (s.campId === null ? [] : [s.campId])),
]);
export const isKnownCamp = (id: string): boolean => CAMP_IDS.has(id) || CAMP_FORMAT.test(id);

const puzzleCache = new Map<number, ReadonlySet<string>>();
/** Puzzle ids of a save with `seed` (the Observatory puzzle's order depends on it; its id does not). */
export function puzzleIds(seed: number): ReadonlySet<string> {
  let set = puzzleCache.get(seed);
  if (set === undefined) {
    const ids = [...puzzleDefsFor(seed).map((p) => p.id), ...Object.values(SIDE_QUEST_PUZZLES).flatMap((l) => (l ?? []).map((p) => p.id))];
    set = new Set(ids);
    if (puzzleCache.size > 16) puzzleCache.clear();
    puzzleCache.set(seed, set);
  }
  return set;
}

const DEFINED_CHESTS: ReadonlySet<string> = new Set([
  ...CAMPS.flatMap((c) => (c.chestId === null ? [] : [c.chestId])),
  ...puzzleDefsFor(0).flatMap((p) => {
    const opens = (p.reward as { opens?: string } | undefined)?.opens;
    return typeof opens === 'string' ? [opens] : [];
  }),
  ...CHESTS.map((c) => c.id), // task 20.1
]);
// Task 20.1: the placement tables of src/data/pois.ts; the formats stay as fallbacks.
const DEFINED_TABLETS: ReadonlySet<string> = new Set(ECHO_TABLETS.map((t) => t.id));
const DEFINED_POIS: ReadonlySet<string> = new Set(POIS.map((p) => p.id));
const DEFINED_HIDDEN: ReadonlySet<string> = new Set(HIDDEN_PLACES.map((h) => h.id));
export const isKnownChest = (id: string): boolean => DEFINED_CHESTS.has(id) || CHEST_FORMAT.test(id);
export const isKnownTablet = (id: string): boolean => DEFINED_TABLETS.has(id) || TABLET_FORMAT.test(id);
export const isKnownPoi = (id: string): boolean => DEFINED_POIS.has(id) || POI_FORMAT.test(id) || NPC_SET.has(id) || ELITE_SET.has(id);
export const isKnownHiddenPlace = (id: string): boolean => DEFINED_HIDDEN.has(id) || HIDDEN_FORMAT.test(id);
export const isKnownCinematic = (id: string): boolean => CINEMATIC_FORMAT.test(id);

const TUTORIAL_SET: ReadonlySet<string> = new Set(TUTORIAL_HINT_IDS);
export const isKnownTutorial = (id: string): boolean => TUTORIAL_SET.has(id);

export const REGION_SET: ReadonlySet<string> = new Set(REGION_IDS);
export const LANDMARK_SET: ReadonlySet<string> = new Set(LANDMARK_IDS);
export const WAYSTONE_SET: ReadonlySet<string> = new Set(WAYSTONE_IDS);
export { ELITE_SET };
export const REACTION_SET: ReadonlySet<string> = new Set(REACTION_IDS);
export const CHALLENGE_AREA_SET: ReadonlySet<string> = new Set(CHALLENGE_AREA_IDS);

/** A respawn point the content defines. */
export function isKnownRespawn(kind: unknown, id: unknown): boolean {
  if (typeof id !== 'string') return false;
  if (kind === 'waystone') return WAYSTONE_SET.has(id);
  if (kind === 'hearth') return id === THISTLEWICK_HEARTH.id;
  if (kind === 'checkpoint') return checkpointById(id) !== null;
  return false;
}

/** A Challenge_Area checkpoint the content defines, in that area. */
export function isKnownCheckpoint(area: unknown, id: unknown): area is ChallengeAreaId {
  if (typeof area !== 'string' || typeof id !== 'string' || !CHALLENGE_AREA_SET.has(area)) return false;
  return checkpointById(id)?.area.id === area;
}

/** Where a respawn point stands (pure twin of src/save/runtimeState respawnSpot). */
export function respawnPointSpot(respawn: { readonly kind: string; readonly id: string }): SpotDef {
  if (respawn.kind === 'waystone' && WAYSTONE_SET.has(respawn.id)) return { ...WAYSTONES[respawn.id as keyof typeof WAYSTONES].spot };
  if (respawn.kind === 'checkpoint') {
    const found = checkpointById(respawn.id);
    if (found !== null) {
      const { pos, yaw } = found.checkpoint.spot;
      return { x: pos.x, z: pos.z, groundY: pos.y, yaw };
    }
  }
  return THISTLEWICK_HEARTH;
}

/** Half extent of the world square (m): saved positions outside it are not valid Safe_Positions. */
export const WORLD_HALF_EXTENT = 560;

/** Number of checkpoint areas defined (sanity for tests). */
export const CHECKPOINT_AREA_COUNT = CHALLENGE_AREA_DEFS.length;

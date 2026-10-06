/*
 * Canonical ID Registry (design.md, "Canonical ID Registry").
 *
 * Every content ID shared by data, code, tests and save files is declared here once: a readonly
 * `as const` tuple, the string-literal union type derived from it, the display names given by the
 * design, and a runtime type guard. The module has no imports and uses no three.js / DOM API, so
 * src/logic, src/data and tests can all depend on it.
 *
 * Prefix rules for IDs that are not enumerated here (new IDs must follow them):
 * - Items: `wpn_` Weapon, `chm_` Charm, `rlc_` Relic (equipment); `con_` consumable; `mat_` material
 *   (e.g. `mat_starmote`).
 * - Placed objects: `chest_<region>_<n>` Chest, `tab_<region>_<n>` Echo_Tablet, `camp_<region>_<n>`
 *   Enemy_Camp, `poi_<region>_<n>` POI, where `<region>` is a RegionId and `<n>` a serial number
 *   within that region.
 * - `pz_<area>_<n>` Puzzle_Mechanism (event `puzzleId`); `<area>` is a RegionId or ChallengeAreaId.
 * - `cin_<name>` cinematic (event `cinematicId`), `tut_<name>` Tutorial_Hint (event `hintId`).
 * - `atk_<owner>_<name>` attack definition; `<owner>` is a CharacterId, EnemyId, EliteId or BossId, or `env`
 *   for environment hazards (e.g. `atk_env_unstable_crystal`).
 * - `sfx_` sound effects and `mus_` music (audio keys).
 * - Event names are `'domain:verb'`, e.g. `'waystone:activated'`, `'camp:cleared'`.
 *
 * `ember` is both an ElementId and a RegionId: the strings are equal but the types mean different
 * things, so never pass one where the other is expected.
 */

// ── Party, elements, reactions ──────────────────────────────────────────────

export const CHARACTER_IDS = ['kairen', 'isla', 'wren', 'talus'] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export const CHARACTER_NAMES: Readonly<Record<CharacterId, string>> = {
  kairen: 'Kairen', // Ember, melee attacker
  isla: 'Isla', // Tide, ranged attacker
  wren: 'Wren', // Gale, area control
  talus: 'Talus', // Terra, defense / support
};

export const ELEMENT_IDS = ['ember', 'tide', 'gale', 'terra'] as const;
export type ElementId = (typeof ELEMENT_IDS)[number];

export const ELEMENT_NAMES: Readonly<Record<ElementId, string>> = {
  ember: 'Ember·불꽃',
  tide: 'Tide·물결',
  gale: 'Gale·바람',
  terra: 'Terra·대지',
};

export const REACTION_IDS = [
  'steamBurst',
  'lavaRift',
  'mudBind',
  'flameSpread',
  'mistSpread',
  'sandGust',
] as const;
export type ReactionId = (typeof REACTION_IDS)[number];

export const REACTION_NAMES: Readonly<Record<ReactionId, string>> = {
  steamBurst: '증기 폭발', // ember + tide
  lavaRift: '용암 균열', // ember + terra
  mudBind: '진흙 속박', // tide + terra
  flameSpread: '불꽃 확산', // gale + ember
  mistSpread: '물안개 확산', // gale + tide
  sandGust: '모래 돌풍', // gale + terra
};

// ── World ───────────────────────────────────────────────────────────────────

export const REGION_IDS = ['verdant', 'ember', 'azure', 'crater', 'sanctum'] as const;
export type RegionId = (typeof REGION_IDS)[number];

export const REGION_NAMES: Readonly<Record<RegionId, string>> = {
  verdant: 'Verdant Reach',
  ember: 'Ember Ravine',
  azure: 'Azure Highlands',
  crater: 'Shardfall Crater',
  sanctum: 'Astral Sanctum',
};

/** Challenge areas; they belong to verdant / ember / azure respectively. */
export const CHALLENGE_AREA_IDS = ['hollowroot', 'cinderspire', 'observatory'] as const;
export type ChallengeAreaId = (typeof CHALLENGE_AREA_IDS)[number];

export const CHALLENGE_AREA_NAMES: Readonly<Record<ChallengeAreaId, string>> = {
  hollowroot: 'Hollowroot Shrine',
  cinderspire: 'Cinderspire',
  observatory: 'Starfall Observatory',
};

/** Waystones: fast-travel, healing and respawn points. */
export const WAYSTONE_IDS = [
  'ws_thistlewick',
  'ws_elderbough',
  'ws_ember',
  'ws_azure',
  'ws_crater',
  'ws_sanctum',
] as const satisfies readonly `ws_${string}`[];
export type WaystoneId = (typeof WAYSTONE_IDS)[number];

export const WAYSTONE_NAMES: Readonly<Record<WaystoneId, string>> = {
  ws_thistlewick: 'Thistlewick',
  ws_elderbough: 'Elderbough',
  ws_ember: 'Ember Ravine',
  ws_azure: 'Azure Highlands',
  ws_crater: 'Shardfall Crater',
  ws_sanctum: 'Astral Sanctum',
};

/**
 * Barriers: `gate_ember` / `gate_azure` are the Blight_Barrier region entrances (lifted at
 * Skyshard ≥ 1 / ≥ 2), `veil_*` is the Blight veil around a whole locked region, and
 * `seal_sanctum` is the Astral Sanctum seal sphere shown until the Resonance_Altar is activated.
 */
export const BARRIER_IDS = [
  'gate_ember',
  'gate_azure',
  'veil_ember',
  'veil_azure',
  'seal_sanctum',
] as const satisfies readonly (`gate_${RegionId}` | `veil_${RegionId}` | `seal_${RegionId}`)[];
export type BarrierId = (typeof BARRIER_IDS)[number];

/** Landmarks: Verdant Reach (first three), Ember Ravine, Azure Highlands (next three), crater sky. */
export const LANDMARK_IDS = [
  'lm_elderbough',
  'lm_breezewatch',
  'lm_waterfall',
  'lm_cinderspire',
  'lm_observatory',
  'lm_floating_isles',
  'lm_arch_azure',
  'lm_astral_sanctum',
] as const satisfies readonly `lm_${string}`[];
export type LandmarkId = (typeof LANDMARK_IDS)[number];

export const LANDMARK_NAMES: Readonly<Record<LandmarkId, string>> = {
  lm_elderbough: 'Elderbough',
  lm_breezewatch: 'Breezewatch',
  lm_waterfall: '폭포',
  lm_cinderspire: 'Cinderspire',
  lm_observatory: 'Starfall Observatory',
  lm_floating_isles: '부유 유적 섬',
  lm_arch_azure: '거대 자연 아치',
  lm_astral_sanctum: 'Astral Sanctum',
};

// ── NPCs, enemies, elites, boss ─────────────────────────────────────────────

export const NPC_IDS = ['maren', 'pip', 'bram', 'tamsin', 'hobb', 'durga', 'oriel'] as const;
export type NpcId = (typeof NPC_IDS)[number];

export const NPC_NAMES: Readonly<Record<NpcId, string>> = {
  maren: 'Elder Maren', // village elder, Main_Quest
  pip: 'Pip', // merchant
  bram: 'Old Bram', // Echo Altar keeper
  tamsin: 'Tamsin', // child, Side_Quest
  hobb: 'Hobb', // farmer, Side_Quest
  durga: 'Durga', // miner in Ember Ravine, Side_Quest
  oriel: 'Oriel', // astronomer in Azure Highlands
};

export const ENEMY_IDS = [
  'bramblekin',
  'thornspitter',
  'mossbackBrute',
  'cinderHound',
  'slagshell',
  'ashWisp',
  'windcutter',
  'aetherSentinel',
] as const;
export type EnemyId = (typeof ENEMY_IDS)[number];

export const ENEMY_NAMES: Readonly<Record<EnemyId, string>> = {
  // Verdant Reach (Thornspitter also appears in Ember Ravine)
  bramblekin: 'Bramblekin',
  thornspitter: 'Thornspitter',
  mossbackBrute: 'Mossback Brute',
  // Ember Ravine
  cinderHound: 'Cinder Hound',
  slagshell: 'Slagshell',
  ashWisp: 'Ash Wisp',
  // Azure Highlands
  windcutter: 'Windcutter',
  aetherSentinel: 'Aether Sentinel',
};

export const ELITE_IDS = [
  'oldMossback',
  'emberjaw',
  'galeclaw',
  'rootboundWarden',
  'cinderAlpha',
  'sentinelPrime',
] as const;
export type EliteId = (typeof ELITE_IDS)[number];

export const ELITE_NAMES: Readonly<Record<EliteId, string>> = {
  // Hidden Elites of verdant / ember / azure
  oldMossback: 'Old Mossback',
  emberjaw: 'Emberjaw',
  galeclaw: 'Galeclaw',
  // Guardian Elites of hollowroot / cinderspire / observatory
  rootboundWarden: 'Rootbound Warden',
  cinderAlpha: 'Cinder Alpha',
  sentinelPrime: 'Sentinel Prime',
};

export const BOSS_IDS = ['caelith'] as const;
export type BossId = (typeof BOSS_IDS)[number];

export const BOSS_NAMES: Readonly<Record<BossId, string>> = {
  caelith: 'Caelith', // final boss
};

// ── Quests ──────────────────────────────────────────────────────────────────

/** Main_Quest stages 1–10 in story order. */
export const MAIN_STAGE_IDS = [
  'ms1',
  'ms2',
  'ms3',
  'ms4',
  'ms5',
  'ms6',
  'ms7',
  'ms8',
  'ms9',
  'ms10',
] as const satisfies readonly `ms${number}`[];
export type MainStageId = (typeof MAIN_STAGE_IDS)[number];

export const MAIN_STAGE_NAMES: Readonly<Record<MainStageId, string>> = {
  ms1: '방랑자의 도착',
  ms2: '첫 번째 공명',
  ms3: '뿌리 아래의 성소',
  ms4: '붉은 협곡',
  ms5: '불꽃 첨탑',
  ms6: '하늘 고원',
  ms7: '별이 떨어진 관측소',
  ms8: '성소의 각성',
  ms9: '추락한 별',
  ms10: '새벽',
};

/** Side_Quests; the suffix is the quest giver's NpcId. */
export const SIDE_QUEST_IDS = [
  'sq_tamsin',
  'sq_hobb',
  'sq_durga',
] as const satisfies readonly `sq_${NpcId}`[];
export type SideQuestId = (typeof SIDE_QUEST_IDS)[number];

export const SIDE_QUEST_NAMES: Readonly<Record<SideQuestId, string>> = {
  sq_tamsin: '잃어버린 풍경',
  sq_hobb: '들판 가시 소탕',
  sq_durga: '식어버린 용광로',
};

// ── Prefix-based IDs (declared by data files, not enumerated here) ─────────

export type WeaponId = `wpn_${string}`;
export type CharmId = `chm_${string}`;
export type RelicId = `rlc_${string}`;
export type EquipmentId = WeaponId | CharmId | RelicId;
export type ConsumableId = `con_${string}`;
export type MaterialId = `mat_${string}`;
export type ItemId = EquipmentId | ConsumableId | MaterialId;

export type ChestId = `chest_${RegionId}_${number}`;
export type EchoTabletId = `tab_${RegionId}_${number}`;
export type CampId = `camp_${RegionId}_${number}`;
export type PoiId = `poi_${RegionId}_${number}`;
export type PuzzleId = `pz_${RegionId | ChallengeAreaId}_${number}`;
export type CinematicId = `cin_${string}`;
export type TutorialHintId = `tut_${string}`;
/** `env`: environment hazards such as the Unstable_Crystal blast. */
export type AttackOwnerId = CharacterId | EnemyId | EliteId | BossId | 'env';
export type AttackId = `atk_${AttackOwnerId}_${string}`;
export type SfxId = `sfx_${string}`;
export type MusicId = `mus_${string}`;

/** Runtime instance ID (spawned enemy, projectile, pickup, ...); not a content ID, so any string. */
export type EntityId = string;

/** Entities whose visual model is resolved through VisualProvider / visualManifest (Req 43). */
export type VisualEntityId = CharacterId | EnemyId | EliteId | BossId | NpcId;

// ── Type guards ─────────────────────────────────────────────────────────────

/** Runtime check that narrows `unknown` to one registry's ID union. */
export type IdGuard<T extends string> = (value: unknown) => value is T;

/** Builds an {@link IdGuard} that accepts exactly the strings in `ids`. */
export function makeGuard<T extends string>(ids: readonly T[]): IdGuard<T> {
  const members: ReadonlySet<string> = new Set<string>(ids);
  return (value: unknown): value is T => typeof value === 'string' && members.has(value);
}

export const isCharacterId: IdGuard<CharacterId> = makeGuard(CHARACTER_IDS);
export const isElementId: IdGuard<ElementId> = makeGuard(ELEMENT_IDS);
export const isReactionId: IdGuard<ReactionId> = makeGuard(REACTION_IDS);
export const isRegionId: IdGuard<RegionId> = makeGuard(REGION_IDS);
export const isChallengeAreaId: IdGuard<ChallengeAreaId> = makeGuard(CHALLENGE_AREA_IDS);
export const isWaystoneId: IdGuard<WaystoneId> = makeGuard(WAYSTONE_IDS);
export const isBarrierId: IdGuard<BarrierId> = makeGuard(BARRIER_IDS);
export const isLandmarkId: IdGuard<LandmarkId> = makeGuard(LANDMARK_IDS);
export const isNpcId: IdGuard<NpcId> = makeGuard(NPC_IDS);
export const isEnemyId: IdGuard<EnemyId> = makeGuard(ENEMY_IDS);
export const isEliteId: IdGuard<EliteId> = makeGuard(ELITE_IDS);
export const isBossId: IdGuard<BossId> = makeGuard(BOSS_IDS);
export const isMainStageId: IdGuard<MainStageId> = makeGuard(MAIN_STAGE_IDS);
export const isSideQuestId: IdGuard<SideQuestId> = makeGuard(SIDE_QUEST_IDS);

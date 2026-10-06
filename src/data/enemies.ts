// Enemy and Elite definitions (design "Enemies·AI": 적 정의, Elite; Req 28.1, 28.9, 28.11, 28.13, 8.9). Pure data.
//
// Stats hold at `baseLevel`, the level L₀ of the region where the kind first appears (verdant 1, ember 4, azure 6);
// logic/enemyScaling derives other levels: HP +10% per level, ATK through computeDamage's `level = L − L₀ + 1`
// (applied once, Req 28.10). DEF, speed, reach and Telegraph ignore level. Hidden Elites scale the same way from
// their base kind with HP ×2.5 and ATK ×1.3 folded into HP₀ / ATK₀; guardian Elites are `scaling: 'fixed'`
// (absolute HP / ATK at any level, computeDamage level 1). Seconds, metres, m/s; dmgMul multiplies the enemy's ATK.
//
// Attack timing (Req 28.9): every enemy attack's first HitEvent comes at its Telegraph duration (enemy ground circles
// use `delay: 0`, so they are judged at `t`), and each later hit of a combo follows the previous one by at least the
// same minimum: 0.4 s for ordinary attacks, 0.8 s for heavy ones (`telegraph.strong`).
//
// Attack ids follow `atk_<owner>_<name>` with the full EnemyId / EliteId as owner (the design table's short forms
// `atk_mossback_*` / `atk_sentinel_*` become `atk_mossbackBrute_*` / `atk_aetherSentinel_*`).

import type { AttackDef, HitEvent, HitShape, TelegraphDef } from './combatTypes';
import {
  ELITE_NAMES, ENEMY_NAMES, type ChallengeAreaId, type EliteId, type ElementId, type EnemyId, type ItemId, type RegionId,
} from './ids';
import { XP_SOURCES } from './progression';
import { AI_STATES, DETECT_CONE_DEG, DETECT_CONE_RANGE, DETECT_NEAR_RANGE, type AiState } from '../logic/ai';
import type { EnemyScaling } from '../logic/enemyScaling';
import type { FrontGuardRule } from '../logic/frontGuard';

// ── Types ───────────────────────────────────────────────────────────────────

/** Design archetypes (Req 28.1); a kind may combine two (방어형·속성, 원거리·속성, ...), primary first. */
export type EnemyArchetype = 'melee' | 'ranged' | 'defensive' | 'charger' | 'elemental';

/** Enemy levels per region (Req 8.9); Shardfall Crater has no enemy placements. */
export const REGION_ENEMY_LEVELS = {
  verdant: [1, 3],
  ember: [4, 6],
  azure: [6, 8],
  sanctum: [9, 9],
} as const satisfies Readonly<Partial<Record<RegionId, readonly [number, number]>>>;
export type EnemyRegionId = keyof typeof REGION_ENEMY_LEVELS;

/** Whether `level` is an allowed enemy level in `region` (an integer within its range). */
export function isRegionEnemyLevel(region: EnemyRegionId, level: number): boolean {
  const [min, max] = REGION_ENEMY_LEVELS[region];
  return Number.isInteger(level) && level >= min && level <= max;
}

/** Detection (Req 28.3): the `coneDeg` forward cone out to `coneRange`, or anywhere within `nearRange` (m). */
export interface EnemyPerception {
  coneDeg: number;
  coneRange: number;
  nearRange: number;
}

export const STANDARD_PERCEPTION: EnemyPerception = {
  coneDeg: DETECT_CONE_DEG,
  coneRange: DETECT_CONE_RANGE,
  nearRange: DETECT_NEAR_RANGE,
};

/** Movement pattern (Req 28.1 이동 패턴); speeds are EnemyDef.moveSpeed. */
export type EnemyMovement =
  /** Walks or runs after the target. */
  | { kind: 'walk' }
  /** Runs in, then attacks with straight dashes (the dash length is its attack's rootMotion). */
  | { kind: 'charge' }
  /**
   * Rooted in place (moveSpeed 0). When the target comes within `triggerRange` it tunnels `distance` m away over
   * `seconds`, with no hurtbox while underground (design "감지·추적·거리 유지").
   */
  | { kind: 'burrow'; triggerRange: number; distance: number; seconds: number }
  /** Floats `altitude` m above the ground. */
  | { kind: 'hover'; altitude: number }
  /** Never leaves its spot; turns toward the target at most `turnRateDeg` per second. */
  | { kind: 'anchored'; turnRateDeg: number };

/** Lingering ground hazard left where a hit lands (burning floor, spore cloud, tornado). */
export interface HazardZoneDef {
  radius: number;
  seconds: number;
  /** Damage tick interval (s); each tick deals the owner's ATK × dmgMul to a character inside. */
  interval: number;
  dmgMul: number;
  /** An Element hit that puts it out (Ash Wisp's burning floor: Tide). */
  clearedBy?: ElementId;
  /** Pulls characters inside toward its centre (m/s). */
  pull?: number;
}

/** Burn on the character hit: `seconds` of ticks every `interval`, each the owner's ATK × dmgMul. */
export interface BurnDef {
  seconds: number;
  interval: number;
  dmgMul: number;
}

/** An enemy attack: the shared AttackDef (design "전투 액션 모델") plus what the Enemy_AI needs to pick and run it. */
export interface EnemyAttackDef extends AttackDef {
  owner: EnemyId | EliteId;
  /** Required: shape, duration (clip start → first HitEvent) and heavy flag (Req 28.9, 26.5). */
  telegraph: TelegraphDef;
  /** Horizontal target distance window (m) in which the AI may start it. */
  useRange: readonly [number, number];
  /** Seconds from its start before the AI may pick it again (0: whenever it is in range). */
  cooldown: number;
  /**
   * `'self'` (default): hit shapes sit in the attacker's frame. `'target'`: ground shapes are centred on the target's
   * feet, locked when the Telegraph starts (lobbed spikes, spore clouds, tornadoes).
   */
  aim?: 'self' | 'target';
  zone?: HazardZoneDef;
  burn?: BurnDef;
  /** Lifting the feet over it with a jump avoids it (Cinder Alpha's fire ring). */
  jumpAvoidable?: boolean;
}

/** Mossback Brute's front guard (Req 28.11): ×0.3 frontal Normal_Attack damage (logic/damage FRONT_GUARD_MUL). */
export interface FrontGuardDef extends FrontGuardRule {
  /** Stagger after a break (s); the guard is back when that Stagger ends. */
  breakStagger: number;
}

/** Element_Shield at spawn (design Element·Reactions: ×0.25 same Element, Reaction ×3, 3 s Stagger on break). */
export interface EnemyShieldDef {
  element: ElementId;
  /** Durability (ElementShield.max); a broken shield stays broken until a return restores HP (Req 28.5). */
  max: number;
  /** Switches Element every `every` s along `order` (starting at `element`), keeping its durability. */
  rotation?: { every: number; order: readonly ElementId[] };
}

/** Rule changes a weakness makes; combat code switches on `kind` (design "효과 표현"). */
export type WeaknessEffect =
  /** Its `element` mark's damage over time × mul (Bramblekin: Ember ×2). */
  | { kind: 'markDotMul'; element: ElementId; mul: number }
  /** A launch (Gale Charged_Attack) uproots it: stunned `seconds` (Thornspitter). */
  | { kind: 'launchStun'; seconds: number }
  /** While `element`-marked its dash length × mul (Cinder Hound: Tide ½). */
  | { kind: 'markDashMul'; element: ElementId; mul: number }
  /** While `element`-marked its hits push nobody (Windcutter: Terra). */
  | { kind: 'markNoKnockback'; element: ElementId }
  /** Talus's stone pillars stop its dash. */
  | { kind: 'pillarStopsDash' }
  /** A hit carrying `element` from inside the `arcDeg` sector behind it staggers it (Rootbound Warden). */
  | { kind: 'backWeakSpot'; arcDeg: number; element: ElementId; staggerSeconds: number };

export interface EnemyWeakness {
  /** Elements that exploit it (hints, codex). */
  elements: readonly ElementId[];
  /** Korean counter-play line. */
  note: string;
  effects: readonly WeaknessEffect[];
}

/** One drop-table line (Req 28.13): `count` of `item` with probability `chance` (loot Rng stream). */
export interface DropEntry {
  item: ItemId;
  chance: number;
  count: number;
}

export interface EnemyDef {
  id: EnemyId | EliteId;
  name: string;
  archetypes: readonly EnemyArchetype[];
  /** Korean silhouette description (Req 28.1; the model preset of task 19.3). */
  silhouette: string;
  /** Regions it is placed in; the first sets `baseLevel`. */
  regions: readonly EnemyRegionId[];
  /** Level L₀ at which the stats below hold. */
  baseLevel: number;
  scaling: EnemyScaling;
  hp: number;
  atk: number;
  def: number;
  /** Chase speed, m/s (0: never walks). */
  moveSpeed: number;
  movement: EnemyMovement;
  perception: EnemyPerception;
  /** Reach of its attack hits (m); a melee enemy starts attacking once the target is inside it. */
  attackRange: number;
  /** Ranged kinds keep the target within this distance band while chasing (Req 28.4: 8–14 m). */
  keepRange?: readonly [number, number];
  /** Hurt capsule: feet at the position, like the player's. */
  radius: number;
  height: number;
  /** Stagger meter threshold of the 2 s stagger (Req 26.9: small 100, Mossback Brute / Aether Sentinel 250, Elite 400). */
  staggerThreshold: number;
  /** A single hit with stagger ≥ poise also stops its movement during the flinch (task 7.7). */
  poise: number;
  /**
   * Attacks in priority order: the AI starts the first whose `useRange` holds the target and whose cooldown has run
   * out. Telegraph = clip start to the first hit (Req 28.9).
   */
  attacks: readonly EnemyAttackDef[];
  /** Melee enemies need a MeleeTokenPool token to start an attack (Req 28.6); ranged ones do not. */
  melee: boolean;
  weakness: EnemyWeakness;
  frontGuard?: FrontGuardDef;
  shield?: EnemyShieldDef;
  /** AI states this kind uses (Req 28.2); the transition table itself is shared (logic/ai). */
  aiStates: readonly AiState[];
  xp: number;
  glim: number;
  drops: readonly DropEntry[];
  /** Elites only: role, placement, summons, drones and reward. */
  elite?: EliteDef;
}

/** Hidden Elites: base kind × multipliers; guardian Elites: absolute values (design "Elite"). */
export type EliteStats = { kind: 'baseMul'; hpMul: number; atkMul: number } | { kind: 'fixed'; hp: number; atk: number };

/** Enemies an Elite calls in: tops its group up to `count` living members every `every` s. */
export interface SummonDef {
  kind: EnemyId;
  count: number;
  /** Placement level of the summoned enemies. */
  level: number;
  every: number;
  /** Wind-up before they appear (s). */
  castTime: number;
}

/** Sentinel Prime's drones: orbiting turrets with their own HP that fire `attack` with the Elite's ATK. */
export interface DroneDef {
  count: number;
  hp: number;
  def: number;
  radius: number;
  orbitRadius: number;
  altitude: number;
  attack: EnemyAttackDef;
}

export type EliteReward =
  /** Hidden Elite: a glowing Chest where it falls, holding `item` while not owned (design Chest 보상표). */
  | { kind: 'glowingChest'; item: ItemId }
  /** Guardian Elite: opens the Challenge_Area's Skyshard room. */
  | { kind: 'skyshardRoom'; area: ChallengeAreaId };

export interface EliteDef {
  id: EliteId;
  role: 'hidden' | 'guardian';
  region: EnemyRegionId;
  area?: ChallengeAreaId;
  /** Korean placement description. */
  location: string;
  /** Base kind whose body, attacks, DEF, movement, reach and shield it keeps; null for Rootbound Warden. */
  base: EnemyId | null;
  stats: EliteStats;
  /** Placement level (within the region's range); guardians' stats ignore it. */
  level: number;
  /** Patterns added on top of the base kind's attacks (tried first). */
  extraAttacks: readonly EnemyAttackDef[];
  summon?: SummonDef;
  drones?: DroneDef;
  reward: EliteReward;
}

// ── Shared numbers ──────────────────────────────────────────────────────────

export const STAGGER_THRESHOLD = { small: 100, large: 250, elite: 400 } as const;
export const HIDDEN_ELITE_HP_MUL = 2.5;
export const HIDDEN_ELITE_ATK_MUL = 1.3;
/** Elite bodies are their base model scaled 1.4× (task 19.3), and so are their hurt capsules. */
export const ELITE_SIZE = 1.4;

/** Every AI state (Req 28.2); rooted kinds drop `patrol`. */
const ALL_STATES: readonly AiState[] = AI_STATES;
const ROOTED_STATES: readonly AiState[] = AI_STATES.filter((s) => s !== 'patrol');
/** Ranged kinds hold the target at 8–14 m while chasing (Req 28.4). */
const RANGED_KEEP: readonly [number, number] = [8, 14];

/** Starmote drops (design "적 드롭"): regular enemies 10% for one, Elites three for sure. */
const REGULAR_DROPS: readonly DropEntry[] = [{ item: 'mat_starmote', chance: 0.1, count: 1 }];
const ELITE_DROPS: readonly DropEntry[] = [{ item: 'mat_starmote', chance: 1, count: 3 }];

/** Drop table per enemy id (Req 28.13); XP / Glim are the EnemyDef's. */
export const ENEMY_DROPS: Readonly<Record<EnemyId | EliteId, readonly DropEntry[]>> = {
  bramblekin: REGULAR_DROPS,
  thornspitter: REGULAR_DROPS,
  mossbackBrute: REGULAR_DROPS,
  cinderHound: REGULAR_DROPS,
  slagshell: REGULAR_DROPS,
  ashWisp: REGULAR_DROPS,
  windcutter: REGULAR_DROPS,
  aetherSentinel: REGULAR_DROPS,
  oldMossback: ELITE_DROPS,
  emberjaw: ELITE_DROPS,
  galeclaw: ELITE_DROPS,
  rootboundWarden: ELITE_DROPS,
  cinderAlpha: ELITE_DROPS,
  sentinelPrime: ELITE_DROPS,
};

/** An enemy HitEvent: no Element, no Energy; `poise` is the stagger value it deals. */
function enemyHit(t: number, shape: HitShape, dmgMul: number, poise: number, knockback: number): HitEvent {
  return { t, shape, dmgMul, appliesElement: false, poise, knockback, energy: null };
}

const groundCircle = (radius: number): HitShape => ({ kind: 'groundCircle', radius, delay: 0 });
const line = (length: number, width: number): HitShape => ({ kind: 'line', length, width });

// ── Attacks ─────────────────────────────────────────────────────────────────

const CLAW_ARC: HitShape = { kind: 'arc', radius: 1.8, angleDeg: 100, height: 1.6 };

/** 2연속 할퀴기: the body glows for 0.4 s, then two claws 0.4 s apart (each hit has ≥ 0.4 s of warning). */
export const ATK_BRAMBLEKIN_CLAW: EnemyAttackDef = {
  id: 'atk_bramblekin_claw',
  owner: 'bramblekin',
  clip: 'bramblekin_claw',
  duration: 1.2,
  telegraph: { kind: 'glow', duration: 0.4, strong: false },
  useRange: [0, 1.8],
  cooldown: 0,
  recoveryFrom: 0.95,
  dodgeCancelFrom: 0.95,
  hits: [enemyHit(0.4, CLAW_ARC, 1, 10, 0.4), enemyHit(0.8, CLAW_ARC, 1, 10, 0.4)],
};

/** 곡사 가시탄: a landing circle on the target for 0.8 s; the lobbed spike (visual) lands in it. */
export const ATK_THORNSPITTER_SPIKE: EnemyAttackDef = {
  id: 'atk_thornspitter_spike',
  owner: 'thornspitter',
  clip: 'thornspitter_spike',
  duration: 1.4,
  telegraph: { kind: 'circle', duration: 0.8, strong: false, radius: 1.5 },
  aim: 'target',
  useRange: [0, 14],
  cooldown: 1.5,
  recoveryFrom: 1.4,
  dodgeCancelFrom: 1.4,
  hits: [enemyHit(0.8, groundCircle(1.5), 1.0, 15, 0.5)],
};

/** 휩쓸기: a 150° sector for 0.8 s (heavy). */
export const ATK_MOSSBACK_BRUTE_SWEEP: EnemyAttackDef = {
  id: 'atk_mossbackBrute_sweep',
  owner: 'mossbackBrute',
  clip: 'mossbackBrute_sweep',
  duration: 1.5,
  telegraph: { kind: 'sector', duration: 0.8, strong: true, radius: 2.4, angleDeg: 150 },
  useRange: [0, 2.4],
  cooldown: 5,
  recoveryFrom: 1.5,
  dodgeCancelFrom: 1.5,
  hits: [enemyHit(0.8, { kind: 'arc', radius: 2.4, angleDeg: 150, height: 2.2 }, 1.0, 35, 2.5)],
};

/** 내려찍기: a 2.4 m ground circle for 0.9 s (heavy). */
export const ATK_MOSSBACK_BRUTE_SMASH: EnemyAttackDef = {
  id: 'atk_mossbackBrute_smash',
  owner: 'mossbackBrute',
  clip: 'mossbackBrute_smash',
  duration: 1.6,
  telegraph: { kind: 'circle', duration: 0.9, strong: true, radius: 2.4 },
  useRange: [0, 2.4],
  cooldown: 0,
  recoveryFrom: 1.6,
  dodgeCancelFrom: 1.6,
  hits: [enemyHit(0.9, groundCircle(2.4), 1.3, 50, 2)],
};

const HOUND_BURN: BurnDef = { seconds: 3, interval: 1, dmgMul: 0.1 };

/** 직선 돌진: a red line for 0.8 s, then a 12 m dash that burns what it hits for 3 s (heavy). */
export const ATK_CINDER_HOUND_DASH: EnemyAttackDef = {
  id: 'atk_cinderHound_dash',
  owner: 'cinderHound',
  clip: 'cinderHound_dash',
  duration: 1.4,
  telegraph: { kind: 'line', duration: 0.8, strong: true, length: 12, width: 1.4 },
  useRange: [0, 12],
  cooldown: 2,
  rootMotion: 12,
  burn: HOUND_BURN,
  recoveryFrom: 1.4,
  dodgeCancelFrom: 1.4,
  hits: [enemyHit(0.8, line(12, 1.4), 1.2, 30, 2)],
};

/** 꼬리 강타: a 2.6 m ground circle for 1.0 s (heavy). */
export const ATK_SLAGSHELL_SLAM: EnemyAttackDef = {
  id: 'atk_slagshell_slam',
  owner: 'slagshell',
  clip: 'slagshell_slam',
  duration: 1.7,
  telegraph: { kind: 'circle', duration: 1.0, strong: true, radius: 2.6 },
  useRange: [0, 2.6],
  cooldown: 0,
  recoveryFrom: 1.7,
  dodgeCancelFrom: 1.7,
  hits: [enemyHit(1.0, groundCircle(2.6), 1.3, 45, 2.5)],
};

/** 화염구: the body glows for 0.6 s, then a fireball that leaves a 2.5 m burning floor for 4 s (ordinary). */
export const ATK_ASH_WISP_FIREBALL: EnemyAttackDef = {
  id: 'atk_ashWisp_fireball',
  owner: 'ashWisp',
  clip: 'ashWisp_fireball',
  duration: 1.2,
  telegraph: { kind: 'glow', duration: 0.6, strong: false },
  useRange: [0, 14],
  cooldown: 2.5,
  zone: { radius: 2.5, seconds: 4, interval: 0.5, dmgMul: 0.15, clearedBy: 'tide' },
  recoveryFrom: 1.2,
  dodgeCancelFrom: 1.2,
  hits: [enemyHit(0.6, { kind: 'projectile', speed: 14, radius: 0.4, maxRange: 16, gravity: 0, pierce: 0 }, 1.0, 15, 1)],
};

/** 바람 칼날 돌진: a line for 0.8 s, then a 10 m dash with a 5 m Gale knockback (heavy). */
export const ATK_WINDCUTTER_BLADE: EnemyAttackDef = {
  id: 'atk_windcutter_blade',
  owner: 'windcutter',
  clip: 'windcutter_blade',
  duration: 1.3,
  telegraph: { kind: 'line', duration: 0.8, strong: true, length: 10, width: 1.6 },
  useRange: [0, 10],
  cooldown: 2,
  rootMotion: 10,
  recoveryFrom: 1.3,
  dodgeCancelFrom: 1.3,
  hits: [enemyHit(0.8, line(10, 1.6), 1.2, 35, 5)],
};

/** 범위 강타: used up close, a 3.5 m ground circle for 1.2 s (heavy). */
export const ATK_AETHER_SENTINEL_SLAM: EnemyAttackDef = {
  id: 'atk_aetherSentinel_slam',
  owner: 'aetherSentinel',
  clip: 'aetherSentinel_slam',
  duration: 1.9,
  telegraph: { kind: 'circle', duration: 1.2, strong: true, radius: 3.5 },
  useRange: [0, 4],
  cooldown: 4,
  recoveryFrom: 1.9,
  dodgeCancelFrom: 1.9,
  hits: [enemyHit(1.2, groundCircle(3.5), 1.6, 50, 3)],
};

/** 조준 빔: an aim line for 1.0 s, then a 16 m beam (heavy). */
export const ATK_AETHER_SENTINEL_BEAM: EnemyAttackDef = {
  id: 'atk_aetherSentinel_beam',
  owner: 'aetherSentinel',
  clip: 'aetherSentinel_beam',
  duration: 1.6,
  telegraph: { kind: 'line', duration: 1.0, strong: true, length: 16, width: 1.2 },
  useRange: [6, 16],
  cooldown: 0,
  recoveryFrom: 1.6,
  dodgeCancelFrom: 1.6,
  hits: [enemyHit(1.0, line(16, 1.2), 1.4, 40, 1.5)],
};

/** Old Mossback 포자 구름: a 4 m circle on the target for 1.0 s, then a spore cloud for 5 s (heavy). */
export const ATK_OLD_MOSSBACK_SPORES: EnemyAttackDef = {
  id: 'atk_oldMossback_spores',
  owner: 'oldMossback',
  clip: 'oldMossback_spores',
  duration: 1.6,
  telegraph: { kind: 'circle', duration: 1.0, strong: true, radius: 4 },
  aim: 'target',
  useRange: [0, 12],
  cooldown: 10,
  zone: { radius: 4, seconds: 5, interval: 1, dmgMul: 0.25 },
  recoveryFrom: 1.6,
  dodgeCancelFrom: 1.6,
  hits: [enemyHit(1.0, groundCircle(4), 0.8, 20, 0)],
};

/** Emberjaw 3연속 돌진: three 12 m dashes, each behind its own 0.8 s line (1.1 s apart), each burning (heavy). */
export const ATK_EMBERJAW_TRIPLE_DASH: EnemyAttackDef = {
  id: 'atk_emberjaw_tripleDash',
  owner: 'emberjaw',
  clip: 'emberjaw_tripleDash',
  duration: 3.6,
  telegraph: { kind: 'line', duration: 0.8, strong: true, length: 12, width: 1.6 },
  useRange: [0, 12],
  cooldown: 8,
  rootMotion: 36,
  burn: HOUND_BURN,
  recoveryFrom: 3.6,
  dodgeCancelFrom: 3.6,
  hits: [
    enemyHit(0.8, line(12, 1.6), 1.1, 30, 2),
    enemyHit(1.9, line(12, 1.6), 1.1, 30, 2),
    enemyHit(3.0, line(12, 1.6), 1.1, 30, 2),
  ],
};

/** Galeclaw 회오리 소환: a 3 m circle on the target for 1.0 s, then a pulling tornado for 4 s (heavy). */
export const ATK_GALECLAW_TORNADO: EnemyAttackDef = {
  id: 'atk_galeclaw_tornado',
  owner: 'galeclaw',
  clip: 'galeclaw_tornado',
  duration: 1.6,
  telegraph: { kind: 'circle', duration: 1.0, strong: true, radius: 3 },
  aim: 'target',
  useRange: [0, 14],
  cooldown: 10,
  zone: { radius: 3, seconds: 4, interval: 0.5, dmgMul: 0.2, pull: 2 },
  recoveryFrom: 1.6,
  dodgeCancelFrom: 1.6,
  hits: [enemyHit(1.0, groundCircle(3), 0.8, 30, 0)],
};

/**
 * Rootbound Warden 뿌리 가시 3줄: three 16 m root lines one after another, each behind its own 0.9 s line (the
 * Warden turns toward the target between them at its 60°/s), heavy.
 */
export const ATK_ROOTBOUND_WARDEN_ROOT_SPIKES: EnemyAttackDef = {
  id: 'atk_rootboundWarden_rootSpikes',
  owner: 'rootboundWarden',
  clip: 'rootboundWarden_rootSpikes',
  duration: 3.4,
  telegraph: { kind: 'line', duration: 0.9, strong: true, length: 16, width: 1.5 },
  useRange: [0, 16],
  cooldown: 0,
  recoveryFrom: 3.4,
  dodgeCancelFrom: 3.4,
  hits: [
    enemyHit(0.9, line(16, 1.5), 1.0, 35, 1.5),
    enemyHit(1.8, line(16, 1.5), 1.0, 35, 1.5),
    enemyHit(2.7, line(16, 1.5), 1.0, 35, 1.5),
  ],
};

/** Cinder Alpha 화염 고리 충격파: an 8 m circle for 1.0 s, then a low ring a jump clears (heavy). */
export const ATK_CINDER_ALPHA_FIRE_RING: EnemyAttackDef = {
  id: 'atk_cinderAlpha_fireRing',
  owner: 'cinderAlpha',
  clip: 'cinderAlpha_fireRing',
  duration: 1.8,
  telegraph: { kind: 'circle', duration: 1.0, strong: true, radius: 8 },
  useRange: [0, 8],
  cooldown: 9,
  jumpAvoidable: true,
  recoveryFrom: 1.8,
  dodgeCancelFrom: 1.8,
  hits: [enemyHit(1.0, groundCircle(8), 1.4, 40, 3)],
};

/** Sentinel Prime 빔 휩쓸기: a 14 m, 90° sector for 1.2 s (heavy). */
export const ATK_SENTINEL_PRIME_BEAM_SWEEP: EnemyAttackDef = {
  id: 'atk_sentinelPrime_beamSweep',
  owner: 'sentinelPrime',
  clip: 'sentinelPrime_beamSweep',
  duration: 2.0,
  telegraph: { kind: 'sector', duration: 1.2, strong: true, radius: 14, angleDeg: 90 },
  useRange: [0, 14],
  cooldown: 8,
  recoveryFrom: 2.0,
  dodgeCancelFrom: 2.0,
  hits: [enemyHit(1.2, { kind: 'arc', radius: 14, angleDeg: 90, height: 3 }, 1.5, 40, 2)],
};

/** Sentinel Prime drone bolt: the drone glows for 0.6 s, then fires a bolt (ordinary). */
export const ATK_SENTINEL_PRIME_DRONE_BOLT: EnemyAttackDef = {
  id: 'atk_sentinelPrime_droneBolt',
  owner: 'sentinelPrime',
  clip: 'sentinelPrime_droneBolt',
  duration: 1.0,
  telegraph: { kind: 'glow', duration: 0.6, strong: false },
  useRange: [0, 14],
  cooldown: 3,
  recoveryFrom: 1.0,
  dodgeCancelFrom: 1.0,
  hits: [enemyHit(0.6, { kind: 'projectile', speed: 18, radius: 0.3, maxRange: 16, gravity: 0, pierce: 0 }, 0.5, 5, 0.5)],
};

// ── Enemy kinds (design 적 정의 표; values at L₀) ───────────────────────────

export const BRAMBLEKIN: EnemyDef = {
  id: 'bramblekin',
  name: ENEMY_NAMES.bramblekin,
  archetypes: ['melee'],
  silhouette: '작은 가시 정령',
  regions: ['verdant'],
  baseLevel: 1,
  scaling: 'level',
  hp: 180,
  atk: 40,
  def: 20,
  moveSpeed: 4.2,
  movement: { kind: 'walk' },
  perception: STANDARD_PERCEPTION,
  attackRange: 1.8,
  radius: 0.5,
  height: 1.3,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 15,
  attacks: [ATK_BRAMBLEKIN_CLAW],
  melee: true,
  weakness: {
    elements: ['ember'],
    note: 'Ember 표식 지속 피해 2배, 낮은 HP',
    effects: [{ kind: 'markDotMul', element: 'ember', mul: 2 }],
  },
  aiStates: ALL_STATES,
  xp: 12,
  glim: 6,
  drops: ENEMY_DROPS.bramblekin,
};

export const THORNSPITTER: EnemyDef = {
  id: 'thornspitter',
  name: ENEMY_NAMES.thornspitter,
  archetypes: ['ranged'],
  silhouette: '뿌리 내린 가시 식물',
  regions: ['verdant', 'ember'],
  baseLevel: 1,
  scaling: 'level',
  hp: 220,
  atk: 45,
  def: 25,
  moveSpeed: 0,
  // The FSM section's 5 m trigger; it resurfaces 8 m away (design table: 땅속 이동 8 m, 1.2 s).
  movement: { kind: 'burrow', triggerRange: 5, distance: 8, seconds: 1.2 },
  perception: STANDARD_PERCEPTION,
  attackRange: 14,
  keepRange: RANGED_KEEP,
  radius: 0.6,
  height: 1.8,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 20,
  attacks: [ATK_THORNSPITTER_SPIKE],
  melee: false,
  weakness: {
    elements: ['gale'],
    note: 'Gale로 띄우면 뿌리가 뽑혀 2 s 기절',
    effects: [{ kind: 'launchStun', seconds: 2 }],
  },
  aiStates: ROOTED_STATES,
  xp: 15,
  glim: 8,
  drops: ENEMY_DROPS.thornspitter,
};

export const MOSSBACK_BRUTE: EnemyDef = {
  id: 'mossbackBrute',
  name: ENEMY_NAMES.mossbackBrute,
  archetypes: ['defensive'],
  silhouette: '이끼 등껍질 거한',
  regions: ['verdant'],
  baseLevel: 1,
  scaling: 'level',
  hp: 520,
  atk: 70,
  def: 60,
  moveSpeed: 2.8,
  movement: { kind: 'walk' },
  perception: STANDARD_PERCEPTION,
  attackRange: 2.4,
  radius: 1.0,
  height: 2.6,
  staggerThreshold: STAGGER_THRESHOLD.large,
  poise: 60,
  attacks: [ATK_MOSSBACK_BRUTE_SWEEP, ATK_MOSSBACK_BRUTE_SMASH],
  melee: true,
  frontGuard: { arcDeg: 120, breakElement: 'ember', breakByCharged: true, breakStagger: 3 },
  weakness: {
    elements: ['ember'],
    note: '정면 Normal_Attack 피해 70% 감소: 측면·후방을 치거나 Ember·Charged_Attack으로 방어를 깨면 3 s Stagger',
    effects: [],
  },
  aiStates: ALL_STATES,
  xp: 35,
  glim: 20,
  drops: ENEMY_DROPS.mossbackBrute,
};

export const CINDER_HOUND: EnemyDef = {
  id: 'cinderHound',
  name: ENEMY_NAMES.cinderHound,
  archetypes: ['charger'],
  silhouette: '불씨 갈기 사냥개',
  regions: ['ember'],
  baseLevel: 4,
  scaling: 'level',
  hp: 260,
  atk: 55,
  def: 30,
  moveSpeed: 7.5,
  movement: { kind: 'charge' },
  perception: STANDARD_PERCEPTION,
  attackRange: 12,
  radius: 0.6,
  height: 1.1,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 25,
  attacks: [ATK_CINDER_HOUND_DASH],
  melee: true,
  weakness: {
    elements: ['tide'],
    note: 'Tide 표식이면 돌진 거리 절반',
    effects: [{ kind: 'markDashMul', element: 'tide', mul: 0.5 }],
  },
  aiStates: ALL_STATES,
  xp: 20,
  glim: 10,
  drops: ENEMY_DROPS.cinderHound,
};

export const SLAGSHELL: EnemyDef = {
  id: 'slagshell',
  name: ENEMY_NAMES.slagshell,
  archetypes: ['defensive', 'elemental'],
  silhouette: '용암 갑각 거북',
  regions: ['ember'],
  baseLevel: 4,
  scaling: 'level',
  hp: 420,
  atk: 60,
  def: 70,
  moveSpeed: 2.5,
  movement: { kind: 'walk' },
  perception: STANDARD_PERCEPTION,
  attackRange: 2.6,
  radius: 1.1,
  height: 1.6,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 50,
  attacks: [ATK_SLAGSHELL_SLAM],
  melee: true,
  shield: { element: 'ember', max: 300 },
  weakness: {
    elements: ['tide', 'terra'],
    note: 'Ember Element_Shield(내구도 300): Tide·Terra로 Reaction을 일으켜 파괴',
    effects: [],
  },
  aiStates: ALL_STATES,
  xp: 35,
  glim: 18,
  drops: ENEMY_DROPS.slagshell,
};

export const ASH_WISP: EnemyDef = {
  id: 'ashWisp',
  name: ENEMY_NAMES.ashWisp,
  archetypes: ['ranged', 'elemental'],
  silhouette: '떠다니는 잿불 도깨비불',
  regions: ['ember'],
  baseLevel: 4,
  scaling: 'level',
  hp: 200,
  atk: 50,
  def: 20,
  moveSpeed: 4.0,
  movement: { kind: 'hover', altitude: 3 },
  perception: STANDARD_PERCEPTION,
  attackRange: 14,
  keepRange: RANGED_KEEP,
  radius: 0.5,
  height: 1.0,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 15,
  attacks: [ATK_ASH_WISP_FIREBALL],
  melee: false,
  weakness: {
    elements: ['gale', 'tide'],
    note: '고도 3 m 부유: Isla 화살이나 Gale 넉백으로 상대하고, 불타는 바닥은 Tide로 소화',
    effects: [],
  },
  aiStates: ALL_STATES,
  xp: 22,
  glim: 12,
  drops: ENEMY_DROPS.ashWisp,
};

export const WINDCUTTER: EnemyDef = {
  id: 'windcutter',
  name: ENEMY_NAMES.windcutter,
  archetypes: ['charger', 'elemental'],
  silhouette: '바람 칼날 날개 맹금',
  regions: ['azure'],
  baseLevel: 6,
  scaling: 'level',
  hp: 300,
  atk: 65,
  def: 35,
  moveSpeed: 8.0,
  movement: { kind: 'charge' },
  perception: STANDARD_PERCEPTION,
  attackRange: 10,
  radius: 0.6,
  height: 1.7,
  staggerThreshold: STAGGER_THRESHOLD.small,
  poise: 30,
  attacks: [ATK_WINDCUTTER_BLADE],
  melee: true,
  weakness: {
    elements: ['terra'],
    note: 'Terra 표식이면 넉백 무효, Talus 돌기둥에 돌진이 막힘',
    effects: [{ kind: 'markNoKnockback', element: 'terra' }, { kind: 'pillarStopsDash' }],
  },
  aiStates: ALL_STATES,
  xp: 28,
  glim: 15,
  drops: ENEMY_DROPS.windcutter,
};

/** Aether Sentinel and Sentinel Prime cycle their shield Element in this order, starting at Ember. */
const SHIELD_ROTATION: readonly ElementId[] = ['ember', 'tide', 'gale', 'terra'];

export const AETHER_SENTINEL: EnemyDef = {
  id: 'aetherSentinel',
  name: ENEMY_NAMES.aetherSentinel,
  archetypes: ['ranged', 'defensive'],
  silhouette: '고대 기계 파수병',
  regions: ['azure'],
  baseLevel: 6,
  scaling: 'level',
  hp: 650,
  atk: 75,
  def: 60,
  moveSpeed: 2.0,
  movement: { kind: 'walk' },
  perception: STANDARD_PERCEPTION,
  attackRange: 16,
  keepRange: RANGED_KEEP,
  radius: 1.0,
  height: 3.0,
  staggerThreshold: STAGGER_THRESHOLD.large,
  poise: 60,
  attacks: [ATK_AETHER_SENTINEL_SLAM, ATK_AETHER_SENTINEL_BEAM],
  melee: false,
  shield: { element: 'ember', max: 400, rotation: { every: 10, order: SHIELD_ROTATION } },
  weakness: {
    elements: ['ember', 'tide', 'gale', 'terra'],
    note: 'Element_Shield(내구도 400)가 10 s마다 Element를 바꿈: 현재 Element와 다른 Element로 Reaction을 일으켜 파괴',
    effects: [],
  },
  aiStates: ALL_STATES,
  xp: 50,
  glim: 28,
  drops: ENEMY_DROPS.aetherSentinel,
};

const BASE_KINDS: Readonly<Record<EnemyId, EnemyDef>> = {
  bramblekin: BRAMBLEKIN,
  thornspitter: THORNSPITTER,
  mossbackBrute: MOSSBACK_BRUTE,
  cinderHound: CINDER_HOUND,
  slagshell: SLAGSHELL,
  ashWisp: ASH_WISP,
  windcutter: WINDCUTTER,
  aetherSentinel: AETHER_SENTINEL,
};

// ── Elites (design Elite 표) ────────────────────────────────────────────────

const HIDDEN: EliteStats = { kind: 'baseMul', hpMul: HIDDEN_ELITE_HP_MUL, atkMul: HIDDEN_ELITE_ATK_MUL };

/**
 * Placement levels: hidden Elites stand at the top of their region's range; guardians' stats are fixed, the level
 * only labels them. Rewards follow the design's equipment table (Verdant Elite rlc_verdant_seed, Ember Elite
 * wpn_talus_bulwark, Azure Elite rlc_ember_core); every Elite also drops Starmote ×3.
 */
export const ELITE_DEFS: Readonly<Record<EliteId, EliteDef>> = {
  oldMossback: {
    id: 'oldMossback',
    role: 'hidden',
    region: 'verdant',
    location: 'Verdant 폭포 뒤 숨겨진 숲',
    base: 'mossbackBrute',
    stats: HIDDEN,
    level: 3,
    extraAttacks: [ATK_OLD_MOSSBACK_SPORES],
    reward: { kind: 'glowingChest', item: 'rlc_verdant_seed' },
  },
  emberjaw: {
    id: 'emberjaw',
    role: 'hidden',
    region: 'ember',
    location: 'Ember 동굴 끝',
    base: 'cinderHound',
    stats: HIDDEN,
    level: 6,
    extraAttacks: [ATK_EMBERJAW_TRIPLE_DASH],
    reward: { kind: 'glowingChest', item: 'wpn_talus_bulwark' },
  },
  galeclaw: {
    id: 'galeclaw',
    role: 'hidden',
    region: 'azure',
    location: '부유 유적 섬 하층',
    base: 'windcutter',
    stats: HIDDEN,
    level: 8,
    extraAttacks: [ATK_GALECLAW_TORNADO],
    reward: { kind: 'glowingChest', item: 'rlc_ember_core' },
  },
  rootboundWarden: {
    id: 'rootboundWarden',
    role: 'guardian',
    region: 'verdant',
    area: 'hollowroot',
    location: 'Hollowroot 최심부',
    base: null,
    stats: { kind: 'fixed', hp: 1600, atk: 70 },
    level: 3,
    extraAttacks: [ATK_ROOTBOUND_WARDEN_ROOT_SPIKES],
    summon: { kind: 'bramblekin', count: 2, level: 3, every: 20, castTime: 1 },
    reward: { kind: 'skyshardRoom', area: 'hollowroot' },
  },
  cinderAlpha: {
    id: 'cinderAlpha',
    role: 'guardian',
    region: 'ember',
    area: 'cinderspire',
    location: 'Cinderspire 정상',
    base: 'cinderHound',
    stats: { kind: 'fixed', hp: 2000, atk: 85 },
    level: 6,
    extraAttacks: [ATK_CINDER_ALPHA_FIRE_RING],
    summon: { kind: 'cinderHound', count: 2, level: 6, every: 25, castTime: 1 },
    reward: { kind: 'skyshardRoom', area: 'cinderspire' },
  },
  sentinelPrime: {
    id: 'sentinelPrime',
    role: 'guardian',
    region: 'azure',
    area: 'observatory',
    location: 'Observatory 돔',
    base: 'aetherSentinel',
    stats: { kind: 'fixed', hp: 2600, atk: 95 },
    level: 8,
    extraAttacks: [ATK_SENTINEL_PRIME_BEAM_SWEEP],
    drones: { count: 2, hp: 150, def: 30, radius: 0.4, orbitRadius: 3, altitude: 3.5, attack: ATK_SENTINEL_PRIME_DRONE_BOLT },
    reward: { kind: 'skyshardRoom', area: 'observatory' },
  },
};

/** What an Elite sets itself on top of its base kind. */
type EliteOwn = Pick<EnemyDef, 'silhouette' | 'poise' | 'glim'> & Partial<Pick<EnemyDef, 'weakness' | 'shield'>>;

/**
 * An Elite built on its base kind: the base's body (×ELITE_SIZE), movement, DEF, reach, guard, shield and attacks
 * (after the Elite's own patterns); HP / ATK from EliteStats, the Elite stagger threshold, XP from XP_SOURCES.
 */
function eliteOnBase(elite: EliteDef, base: EnemyDef, own: EliteOwn): EnemyDef {
  const stats = elite.stats;
  const hidden = stats.kind === 'baseMul';
  return {
    ...base,
    id: elite.id,
    name: ELITE_NAMES[elite.id],
    silhouette: own.silhouette,
    regions: [elite.region],
    baseLevel: hidden ? base.baseLevel : elite.level,
    scaling: hidden ? 'level' : 'fixed',
    hp: stats.kind === 'baseMul' ? base.hp * stats.hpMul : stats.hp,
    atk: stats.kind === 'baseMul' ? base.atk * stats.atkMul : stats.atk,
    radius: base.radius * ELITE_SIZE,
    height: base.height * ELITE_SIZE,
    staggerThreshold: STAGGER_THRESHOLD.elite,
    poise: own.poise,
    attacks: [...elite.extraAttacks, ...base.attacks],
    weakness: own.weakness ?? base.weakness,
    shield: own.shield ?? base.shield,
    xp: XP_SOURCES.elite[elite.id],
    glim: own.glim,
    drops: ENEMY_DROPS[elite.id],
    elite,
  };
}

const eliteBase = (id: EliteId): EnemyDef => {
  const base = ELITE_DEFS[id].base;
  if (base === null) throw new Error(`Elite '${id}' has no base kind`);
  return BASE_KINDS[base];
};

/** Rootbound Warden: no base kind; rooted in its arena, turning at 60°/s, with a glowing root weak spot on its back. */
const ROOTBOUND_WARDEN: EnemyDef = {
  id: 'rootboundWarden',
  name: ELITE_NAMES.rootboundWarden,
  archetypes: ['defensive', 'elemental'],
  silhouette: '뿌리로 엮인 거대 수호자',
  regions: ['verdant'],
  baseLevel: ELITE_DEFS.rootboundWarden.level,
  scaling: 'fixed',
  hp: 1600,
  atk: 70,
  def: 40,
  moveSpeed: 0,
  movement: { kind: 'anchored', turnRateDeg: 60 },
  perception: STANDARD_PERCEPTION,
  attackRange: 16,
  radius: 1.6,
  height: 4.2,
  staggerThreshold: STAGGER_THRESHOLD.elite,
  poise: 100,
  attacks: [ATK_ROOTBOUND_WARDEN_ROOT_SPIKES],
  melee: false,
  weakness: {
    elements: ['ember'],
    note: '등 뒤 발광 뿌리 약점: Ember로 맞히면 2 s Stagger',
    effects: [{ kind: 'backWeakSpot', arcDeg: 120, element: 'ember', staggerSeconds: 2 }],
  },
  aiStates: ROOTED_STATES,
  xp: XP_SOURCES.elite.rootboundWarden,
  glim: 60,
  drops: ENEMY_DROPS.rootboundWarden,
  elite: ELITE_DEFS.rootboundWarden,
};

/** Every enemy kind and Elite (Req 28.1). Elite Glim is an implementation choice (the design sets none). */
export const ENEMY_DEFS: Readonly<Record<EnemyId | EliteId, EnemyDef>> = {
  ...BASE_KINDS,
  oldMossback: eliteOnBase(ELITE_DEFS.oldMossback, eliteBase('oldMossback'), {
    silhouette: '이끼 등껍질 거한(1.4×, 버섯 왕관)', poise: 90, glim: 50,
  }),
  emberjaw: eliteOnBase(ELITE_DEFS.emberjaw, eliteBase('emberjaw'), {
    silhouette: '불씨 갈기 사냥개(1.4×, 용암 턱)', poise: 60, glim: 50,
  }),
  galeclaw: eliteOnBase(ELITE_DEFS.galeclaw, eliteBase('galeclaw'), {
    silhouette: '바람 칼날 날개 맹금(1.4×, 폭풍 볏)', poise: 60, glim: 50,
  }),
  rootboundWarden: ROOTBOUND_WARDEN,
  cinderAlpha: eliteOnBase(ELITE_DEFS.cinderAlpha, eliteBase('cinderAlpha'), {
    silhouette: '불씨 갈기 사냥개(1.4×, 화염 갈기 왕관)', poise: 70, glim: 70,
  }),
  sentinelPrime: eliteOnBase(ELITE_DEFS.sentinelPrime, eliteBase('sentinelPrime'), {
    silhouette: '고대 기계 파수병(1.4×, 결정 갑주와 드론 2기)',
    poise: 90,
    glim: 80,
    shield: { element: 'ember', max: 400, rotation: { every: 8, order: SHIELD_ROTATION } },
    weakness: {
      elements: ['ember', 'tide', 'gale', 'terra'],
      note: 'Element_Shield(내구도 400)가 8 s마다 Element를 바꿈: 현재 Element와 다른 Element로 Reaction을 일으켜 파괴',
      effects: [],
    },
  }),
};

/**
 * Every enemy attack definition once: the kinds' and Elites' attacks plus Sentinel Prime's drone bolt (summoned
 * Bramblekin / Cinder Hounds use their kinds' attacks). Telegraph checks iterate this list (Req 28.9).
 */
export const ENEMY_ATTACKS: readonly EnemyAttackDef[] = [
  ...new Set<EnemyAttackDef>([
    ...Object.values(ENEMY_DEFS).flatMap((d) => d.attacks),
    ...Object.values(ELITE_DEFS).flatMap((e) => (e.drones === undefined ? [] : [e.drones.attack])),
  ]),
];

/** @throws Error for a kind without data (a corrupt or unknown id). */
export function getEnemyDef(kind: EnemyId | EliteId): EnemyDef {
  const def: EnemyDef | undefined = ENEMY_DEFS[kind];
  if (def === undefined) throw new Error(`No enemy data for '${kind}'`);
  return def;
}

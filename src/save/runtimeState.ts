/*
 * RuntimeState (design.md "RuntimeState 주요 구조", "상태 계층"): the per-session simulation state that is
 * never saved: the Active_Character's controller state, party Stamina, Energy and Skill cooldowns,
 * combat flags, enemies, projectiles, placed effects, the boss fight and cinematic playback. Only the
 * current HP and Downed live in GameState. `createRuntimeState` rebuilds it from a GameState and the
 * content data after New Game, Continue, fast travel and a Party_Wipe restart (Req 11.6, 36.8).
 *
 * The enemy, projectile, zone, boss and cinematic records are skeletons: their systems (combat
 * runtime, enemies and spawners, the Caelith encounter, the cinematic player) fill in their details.
 * Times named `until` / `switchLockUntil` are simulation-clock seconds; the clock never goes below 0.
 */
import type { AttackPlayback } from '../combat/attackRuntime';
import type { Vec3 } from '../core/types';
import {
  CHARACTER_IDS, isWaystoneId, type AttackId, type BossId, type CharacterId, type CinematicId, type EliteId, type EnemyId,
  type EntityId, type ItemId,
} from '../data/ids';
import { checkpointById } from '../data/challengeAreas';
import { THISTLEWICK_HEARTH, type SpotDef } from '../data/worldLayout';
import { WAYSTONES } from '../data/waystones'; // task 13.7: respawn in front of the stone
import type { AiState } from '../logic/ai';
import type { ProbeChoice, ProgressWindow } from '../logic/aiSteering';
import type { BossPhase } from '../logic/boss';
import type { ElementTarget } from '../logic/element';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { completedTabletSets, createStaminaState, staminaMax, type StaminaState } from '../logic/stamina';
import { createControllerState, type ControllerState } from '../player/core/types';

/**
 * Front guard state: `'up'` guards the front; `'broken'` is broken with its Stagger still to start (the AI state
 * does not allow one yet); `'staggered'` is broken during that Stagger, and back `'up'` when it ends.
 */
export type GuardState = 'up' | 'broken' | 'staggered';

/** One live enemy or Elite; `spawner` is the SpawnerDef id it came from (its camp or entity id without one). */
export interface EnemyRuntime {
  id: EntityId;
  def: EnemyId | EliteId;
  /** Placement level; scales max HP and ATK (logic/enemyScaling). */
  level: number;
  /** Feet position. */
  pos: Vec3;
  /** Position and facing at the end of the previous tick (render interpolation). */
  prevPos: Vec3;
  prevYaw: number;
  /** Where it spawned (return and reset target). */
  spawnPos: Vec3;
  /** Knockback velocity while `knockTime` runs, else zero. */
  vel: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  state: AiState;
  /** Seconds in `state`. */
  stateTime: number;
  element: ElementTarget;
  /** Stagger meter (Req 26.9). */
  stagger: number;
  /** Seconds left of the hit flinch (Req 26.1). */
  flinch: number;
  /**
   * Seconds left during which a poise-breaking flinch holds the body still: a single hit whose stagger is at least
   * the kind's poise, landing outside `attack`, stops its walking for the flinch. 0 otherwise (the flinch is then
   * only an additive motion over whatever it is doing, a Telegraph included).
   */
  flinchHold: number;
  /** Seconds left of the knockback slide. */
  knockTime: number;
  /** Length of the current `stagger` state (2 s from the meter, a Reaction's own length otherwise). */
  staggerSeconds: number;
  /** A Reaction Stagger runs until this sim time (entered as soon as the AI state allows it). */
  stunUntil: number;
  /** Cannot move until this sim time (진흙 속박). */
  rootedUntil: number;
  /** Move speed × mul until sim time `until` (물안개 확산), else null. */
  slow: { mul: number; until: number } | null;
  /** Front guard (Mossback Brute, Req 28.11); null for kinds without one. */
  guard: GuardState | null;
  spawner: string;
  /** Enemy_Camp or encounter group reported in 'enemy:defeated'; null for lone enemies. */
  campId: string | null;
  /** Attack in progress, played from clip start (the Telegraph runs until its first HitEvent). */
  attack: AttackPlayback | null;
  /**
   * The target's feet, locked when a target-aimed attack (`aim: 'target'`) starts its Telegraph: its ground shapes
   * are drawn and judged there. null otherwise.
   */
  aim: Vec3 | null;
  /**
   * Spawn ordinal n (0 for the first enemy the EnemySystem spawns): its decisions run on the fixed ticks with
   * `(tick + n) % 3 === 0` (20 Hz, design "갱신 비용").
   */
  seq: number;
  /** Seconds since the target was last detected or landed a hit, counted while engaged (8 s → return, Req 28.5). */
  unseen: number;
  /** More than 80 m from the player: no decisions, movement or timers this tick (Req 28.12). */
  asleep: boolean;
  /** Planar movement chosen by the last decision, as a fraction of the move speed (zero: stand still). */
  steer: { x: number; z: number };
  /**
   * Side by spawn ordinal parity (+1 even / −1 odd, logic/aiSteering circleSide): a ranged enemy's strafe, a melee
   * enemy's circling direction on the waiting ring, and the probe side taken when both sides are open.
   */
  strafe: 1 | -1;
  /** Sim time from which each attack may be picked again (its cooldown); absent: ready. */
  attackReadyAt: Partial<Record<AttackId, number>>;
  /** Melee: refused a token, it circles the target at 4–6 m and asks again every decision (Req 28.6). */
  circling: boolean;
  /** Last terrain probe choice: 0 straight toward the goal, ±1 the ±40° side; a tie between sides keeps it (Req 28.8). */
  detour: ProbeChoice;
  /** Approach progress since the last 0.5 m closed: 2 s without it turns a chase to return (Req 28.8). */
  progress: ProgressWindow;
  /**
   * Sim time its Element_Shield was last raised (spawn, reset, return): a rotating shield's Element counts its switches
   * from here (Aether Sentinel 10 s, Sentinel Prime 8 s). Unused by kinds without a shield.
   */
  shieldSince: number;
}

/** A projectile in flight, swept as a sphere from its previous position every tick (Req 20.3). */
export interface ProjectileRuntime {
  id: EntityId;
  attack: AttackId;
  owner: EntityId;
  pos: Vec3;
  vel: Vec3;
  radius: number;
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Metres flown; the projectile expires beyond `maxRange`. */
  travelled: number;
  maxRange: number;
  /** Further targets it may still pass through. */
  pierce: number;
}

/** Projectiles in flight; the combat runtime recycles the instances and trails through a pool (Req 38.6). */
export interface ProjectilePool {
  active: ProjectileRuntime[];
}

/**
 * An enemy drop lying where the enemy fell (design "적 드롭", Req 28.13). Once the Active_Character comes within
 * 3 m it is `pulled` and flies to them; on arrival the Inventory_System grants it and the record is removed.
 */
export interface PickupRuntime {
  id: EntityId;
  itemId: ItemId;
  count: number;
  /** Resting point on the ground, or the current position while pulled. */
  pos: Vec3;
  /** Position at the end of the previous tick (render interpolation). */
  prevPos: Vec3;
  pulled: boolean;
  /** 'item:granted' source (e.g. 'enemy'). */
  source: string;
}

/**
 * A placed effect (Talus pillar, arrow rain, vortex, lava rift, ...). It keeps judging with the values
 * snapshotted when it was created, whoever is active later (Req 23.5, 23.6).
 */
export interface EffectZone {
  id: EntityId;
  /** Attack or Reaction that created it. */
  source: string;
  owner: EntityId;
  pos: Vec3;
  radius: number;
  until: number;
}

/** The Caelith fight while it runs; the encounter's snapshot (HUD, harness) is read from it. */
export interface BossRuntime {
  id: BossId;
  phase: BossPhase;
  hp: number;
  maxHp: number;
  /** Seconds in the current boss state. */
  stateTime: number;
}

/** Cinematic playback (design `CinematicPlayback`). */
export interface CinematicRuntime {
  id: CinematicId;
  /** Seconds played. */
  t: number;
  /** First timeline event not yet applied. */
  nextEvent: number;
  /** Seconds the skip input has been held. */
  skipHold: number;
}

export interface RuntimeState {
  /** Active_Character movement; party switches hand position, yaw and velocity over. */
  player: ControllerState;
  /** Party-wide Stamina (Req 17.1). */
  stamina: StaminaState;
  /** Energy per character; not saved, so it restarts at 0. */
  energy: Record<CharacterId, number>;
  /** Remaining Skill cooldown per character (s); 0 is ready. Standby characters keep counting down. */
  cooldowns: Record<CharacterId, number>;
  /** Switching is refused while the sim clock is before this (0.8 s lock, Req 23.3). */
  switchLockUntil: number;
  /** Terra Reaction shield on the Active_Character (Req 25.12). */
  shield: { amount: number; until: number } | null;
  inCombat: boolean;
  lockTarget: EntityId | null;
  enemies: Map<EntityId, EnemyRuntime>;
  /** The party's projectiles. */
  projectiles: ProjectilePool;
  /** Enemy projectiles (Ash Wisp fireballs, ...), flying at the Active_Character. */
  enemyProjectiles: ProjectilePool;
  /** Enemy drops waiting to be picked up. */
  pickups: PickupRuntime[];
  zones: EffectZone[];
  boss: BossRuntime | null;
  cinematic: CinematicRuntime | null;
}

const perCharacter = (value: number): Record<CharacterId, number> =>
  Object.fromEntries(CHARACTER_IDS.map((id): [CharacterId, number] => [id, value])) as Record<CharacterId, number>;

const standAt = (spot: SpotDef): ControllerState => createControllerState({ x: spot.x, y: spot.groundY, z: spot.z }, spot.yaw);

/**
 * Spot of the respawn point: a Waystone's spot 2 m in front of its stone (src/data/waystones.ts, task 13.7), a
 * Challenge_Area checkpoint rune (src/data/challengeAreas.ts), otherwise the Thistlewick Hearth.
 */
export function respawnSpot(respawn: DeepReadonly<GameState['respawn']>): SpotDef {
  if (respawn.kind === 'waystone' && isWaystoneId(respawn.id)) return { ...WAYSTONES[respawn.id].spot };
  if (respawn.kind === 'checkpoint') {
    const found = checkpointById(respawn.id);
    if (found !== null) {
      const { pos, yaw } = found.checkpoint.spot;
      return { x: pos.x, z: pos.z, groundY: pos.y, yaw };
    }
  }
  return THISTLEWICK_HEARTH;
}

/**
 * Fresh RuntimeState for `gs` (only read): the Active_Character standing at rest on the last
 * Safe_Position (the respawn point when there is none), full Stamina with the max from the completed
 * Echo_Tablet sets (Req 10.9), no Energy, every Skill ready, no switch lock, out of combat, and no
 * enemies, projectiles, drops, placed effects, boss fight or cinematic. Every call returns new objects.
 */
export function createRuntimeState(gs: DeepReadonly<GameState>): RuntimeState {
  const safe = gs.lastSafe;
  const player =
    safe === null
      ? standAt(respawnSpot(gs.respawn))
      : createControllerState({ x: safe.pos[0], y: safe.pos[1], z: safe.pos[2] }, safe.yaw);
  return {
    player,
    stamina: createStaminaState(staminaMax(completedTabletSets(gs.world.echoTablets))),
    energy: perCharacter(0),
    cooldowns: perCharacter(0),
    switchLockUntil: 0,
    shield: null,
    inCombat: false,
    lockTarget: null,
    // The World's SpawnerSystem places the enemies here once the session is built (it needs the terrain), skipping
    // the camps and Elites recorded in gs.world.camps / gs.world.elites (Req 11.6).
    enemies: new Map(),
    projectiles: { active: [] },
    enemyProjectiles: { active: [] },
    pickups: [],
    zones: [],
    boss: null,
    cinematic: null,
  };
}

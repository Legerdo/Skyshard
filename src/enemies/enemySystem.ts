// Enemy_AI (design "Enemies·AI"; Req 28.2–28.5, 28.9, 28.10, 28.12, 26.9): spawns enemies from src/data/enemies
// into RuntimeState.enemies and runs them on the shared AI state table:
//   idle / patrol ─(sight: 120° 14 m cone or 6 m; or a hit)→ alert (0.5 s: 'enemy:alerted' for the warning sound, the
//   "!" shows while the state is alert) → chase. Melee kinds close in to their reach and start an attack once they hold
//   a MeleeTokenPool token; ranged kinds keep the target at their 8–14 m band (approach / back off / strafe) and
//   attack only while the eye → chest ray is open (no solid hit). Recovery → chase follows the clip. Chase / recovery
//   turn to return 30 m from the spawn or after 8 s without detection: full HP, stagger meter 0, walk home, idle on
//   arrival; during return only a hit alerts. The stagger meter (hit stagger, Terra mark ×1.5) at the kind's
//   threshold → stagger (2 s), entered on the tick the state first allows it.
// Attack execution (design "공격·피격·Stagger"; Req 28.9, 28.10, 26.5): starting an attack emits 'enemy:telegraph'
// (the Audio_System's ready sound; the views also read the playback) and a target-aimed attack locks the target's
// feet as its ground shapes' centre. Nothing is judged before the first HitEvent's clip time, which the data keeps at
// or after the Telegraph's end (Property 22). Each HitEvent is then judged against the Active_Character: a hurt
// capsule overlapping during Dodge i-frames is ignored (and reported as evaded, Perfect_Dodge), otherwise the hit
// deals computeDamage (kind 'enemy', the enemy's level-scaled ATK against the character's DEF, no crit) and pushes
// by its knockback. Projectile HitEvents launch swept-sphere projectiles from the body toward the target's chest
// (src/combat/projectiles, their own pool) that land the same way.
// Hit reactions (Req 26.1): every hit plays a 0.2 s flinch without changing the AI state. A single hit whose stagger
// is at least the kind's poise, outside `attack`, also holds its walking for the flinch; otherwise the flinch is
// only additive, so a Telegraph or attack in progress is never cut. HP 0 → dead (Req 26.6): the token goes back,
// 'enemy:defeated' is emitted once (the Loot_System grants XP / Glim / drops) and the body, which the views play
// the death motion and dissolve on, is removed 1.5 s later.
// Update cost (design "갱신 비용", Req 28.12): more than 80 m from the player an enemy sleeps (no decisions, movement
// or timers; an engaged one is first put back at its spawn, idle at full HP). Within 80 m the decision step
// (detection, leash / lost target, movement choice, attack start) runs only on ticks with (tick + n) % 3 === 0, n
// the spawn ordinal; movement, timers, hits, stagger and death run every tick.
// Every change of state goes through aiTransition (resets are not transitions). Each enemy is also a HitReceiver for the party's attacks:
// a hit lowers HP, applies its Element through the ReactionSystem (src/element: mark, reaction, spread and chains
// over all enemies, and the reaction effects), adds its stagger gain, flinches for 0.2 s and slides the body back by
// the knockback. Mossback Brute's front guard (logic/frontGuard, Req 28.11) is sampled per hit from the hit's direction
// and cuts frontal Normal_Attack damage to 30%; an Ember or Charged_Attack hit breaks it for a 3 s Stagger (started
// once the AI state allows one), after which it is back up. A `backWeakSpot` (Rootbound Warden's glowing back root) turns an
// Ember hit from its rear 120° into a 2 s Stagger ('enemy:weakSpot'); an `anchored` kind turns at its own rate (60°/s)
// and is never slid by knockback. Reaction effects act here too: a Reaction Stagger enters `stagger` for its own length once the AI
// state allows it, mudBind stops movement, mistSpread and the Tide mark slow it, lava rifts burn in tick().
// Movement (design "공격 토큰과 분리", "지형 탐지와 이동"; Req 28.6–28.8, 20.2, 20.7): a melee enemy refused a token at
// its reach circles the target on the 4–6 m ring (side by ordinal parity) and asks again every decision; tokens go
// back at recovery end, stagger, death, return and resets. Every decision's movement adds separation steering away
// from close neighbours, then probes 0° / ±40° 1.5 m ahead (drop > 2.5 m, slope > 50°, water > 1 m, outside the
// boundary, a waist-height solid) and takes the open direction nearest the goal (a side tie keeps the last side);
// all blocked, it only turns. An approach (chase) that closes under 0.5 m by its own walking in 2 s turns to return,
// and a return that does the same is reset to its spawn. CollisionResolve (resolveCollisions) then keeps enemies
// 1.2 m apart (or their radius sum), pushes them out of the player's capsule within 0.2 s, and resets any enemy 2 m
// under the terrain or past 490 m to its spawn, idle.
// Element_Shield (design "Element·Reactions", "적 정의 표"; Req 25.10, 25.11, 28.5): a kind with a `shield` (Slagshell,
// Aether Sentinel, Sentinel Prime) spawns with it at full durability. While it stands the target counts as marked with
// its Element (logic/element applyElement), and every hit's damage (same Element ×0.25 already in computeDamage) and
// every Reaction's damage ×3 go into it first, the rest into HP. At 0 it breaks: gone, a 3 s Stagger (entered as soon as
// the AI state allows it) and a short Hit_Stop. A rotating shield switches its Element every `rotation.every` s along
// its order (Aether Sentinel 10 s, Sentinel Prime 8 s), keeping its durability. A broken shield comes back only with the
// HP of a return or a reset.
// Drones (design Elite 표: Sentinel Prime "드론 2기"): an Elite with `drones` carries that many orbiting turrets
// (`orbitRadius` around it, `altitude` above its feet) with their own HP and DEF. While their owner chases or attacks
// they fire their bolt (a 0.6 s glow Telegraph, then a projectile at the target's chest) whenever it is ready, the
// target within its reach and in sight. They are hit targets of the party's attacks; at 0 HP one is gone, all of them
// go with their owner's death, and a return or reset of the owner restores them.
// Placement is the World's (src/world/spawnerSystem): it spawns the SpawnerDefs here, counts camps from
// 'enemy:defeated' and, after fast travel, a load or a Party_Wipe restart, resets and replaces enemies through
// resetEngaged / reset / remove.

import { angleDelta, copyV3, DEG2RAD, distance, distanceXZ, wrapAngle, yawFromDir } from '../core/math';
import type { Vec3 } from '../core/types';
import type { ElementSource, GameEventBus } from '../core/gameEvents';
import {
  advanceAttack, attackFinished, judgeHitEvent, startAttack, type AttackPlayback, type Attacker, type HitReceiver, type ResolvedHit,
} from '../combat/attackRuntime';
import type { HurtVolume } from '../combat/hitShapes';
import { ProjectileSystem } from '../combat/projectiles';
import type { HitEvent } from '../data/combatTypes';
import { getEnemyDef, type DroneDef, type EnemyAttackDef, type EnemyDef } from '../data/enemies';
import type { EliteId, ElementId, EnemyId, EntityId, ReactionId } from '../data/ids';
import type { TimeScaleSource } from '../core/loop';
import { markModifiers, SHIELD_BREAK_STAGGER } from '../element/elementRuntime';
import { SHIELD_REACTION_MUL } from '../logic/damage';
import { HIT_FEEL } from '../logic/hitFeel';
import { ReactionSystem, type ReactionActor, type ReactionHost } from '../element/reactionSystem';
import {
  ALERT_SECONDS, MeleeTokenPool, aiTransition, alertsOn, detectsTarget, isDecisionTick, keepRangeMove, pickAttack,
  shouldReturn, sightClear, sightLine, sleepsAt, type AiState,
} from '../logic/ai';
import {
  FRESH_PROGRESS, PROBE_SIDE_RAD, advanceProgress, capLength, chooseProbe, circleSide, progressStalled, ringSteer,
  rotateYaw, separateBodies, separationSteer, type Planar, type SpacingBody,
} from '../logic/aiSteering';
import { activeMark, damageShield, emptyTarget, freshShield, shieldElementAt, type ElementTarget } from '../logic/element';
import { scaledDamageLevel, scaledMaxHp } from '../logic/enemyScaling';
import { breaksGuard, guardCovers, hitsFromBehind } from '../logic/frontGuard';
import { resolvePlayerOverlaps } from '../physics/separation';
import { MAX_WALKABLE_SLOPE_DEG, type CollisionQueries } from '../physics/types';
import type { EffectZone, EnemyRuntime, ProjectilePool } from '../save/runtimeState';
import { enemyRecoveryPosition } from '../world/worldBounds';
import { probeBlockedAt, type EnemyTerrain, type ProbeEnv } from './terrainProbe';

/** Turn speed while facing the target (rad/s). */
export const ENEMY_TURN_RATE = 540 * DEG2RAD;
/** Recovery after an attack clip; the melee token is returned when it ends. */
export const ENEMY_RECOVERY_SECONDS = 0.6;
/** Stagger length once the meter reaches the threshold (Req 26.9). */
export const ENEMY_STAGGER_SECONDS = 2;
/** The body is removed this long after death (Req 26.6). */
export const ENEMY_DESPAWN_SECONDS = 1.5;
/** Hit flinch (Req 26.1). */
export const ENEMY_FLINCH_SECONDS = 0.2;
/** A knockback slides the body over this long. */
export const ENEMY_KNOCKBACK_SECONDS = 0.15;
/** A melee enemy stops this far inside its reach of the target's surface, so a target standing still is hit. */
export const APPROACH_MARGIN = 0.3;
/** A ranged enemy strafes at this fraction of its move speed (implementation choice). */
export const STRAFE_SPEED_FRACTION = 0.5;
/** A returning enemy is home (idle) within this horizontal distance (m) of its spawn position. */
export const RETURN_ARRIVE_DISTANCE = 0.1;
/** Enemy projectiles leave the body and aim at the target at this fraction of their heights (chest). */
export const PROJECTILE_HEIGHT_FRACTION = 0.6;

const TIME_EPS = 1e-9;
/** An approach within this (m) of its goal distance has arrived. */
const ARRIVE_EPS = 1e-6;
const STILL = { x: 0, z: 0 } as const;
const ENGAGED_STATES: ReadonlySet<AiState> = new Set<AiState>(['alert', 'chase', 'attack', 'recovery', 'stagger']);
/** The separation sweep starts this far above the feet, clear of the ground the body stands on. */
const SEPARATION_LIFT = 0.05;
/** A knockback slide stops before ground rising more than this above the feet (m). */
const KNOCKBACK_MAX_RISE = 0.5;
/** A knockback slide stops before an edge dropping more than this below the feet (m): nobody is knocked off a platform. */
const KNOCKBACK_MAX_DROP = 1.5;
/** Hit_Stop when an Element_Shield breaks (Req 26.3: 50–90 ms of real time; logic/hitFeel). */
export const SHIELD_BREAK_HIT_STOP = HIT_FEEL.shieldBreak.hitStop;
/** Drones circle their owner at this rate (implementation choice, rad/s). */
export const DRONE_ORBIT_RATE = (60 * Math.PI) / 180;
/** Owner states in which its drones fire. */
const DRONE_FIRING: ReadonlySet<AiState> = new Set<AiState>(['chase', 'attack', 'recovery']);

/** One of an Elite's drones (Sentinel Prime's orbiting turrets). */
interface DroneRuntime {
  readonly id: EntityId;
  readonly owner: EntityId;
  readonly def: DroneDef;
  /** Orbit angle (rad, from +x toward +z). */
  angle: number;
  /** Centre of its body. */
  pos: Vec3;
  prevPos: Vec3;
  hp: number;
  alive: boolean;
  /** Its bolt in progress (Telegraph, then the shot), else null. */
  attack: AttackPlayback | null;
  /** Sim time from which it may fire again. */
  readyAt: number;
}

/** A drone as the views and tests see it. */
export interface DroneView {
  readonly id: EntityId;
  readonly owner: EntityId;
  /** Body centre now and at the end of the previous tick (render interpolation). */
  readonly pos: Readonly<Vec3>;
  readonly prevPos: Readonly<Vec3>;
  readonly radius: number;
  readonly hp: number;
  readonly maxHp: number;
  /** Its bolt's glow Telegraph is showing. */
  readonly telegraph: boolean;
}

/** A fresh Element state carrying the kind's Element_Shield at full durability (none for kinds without one). */
function shieldedTarget(def: EnemyDef): ElementTarget {
  return { ...emptyTarget(), shield: freshShield(def.shield) };
}

/** A drone's body centre at orbit angle `angle` around its owner's feet. */
function dronePoint(owner: Readonly<Vec3>, def: DroneDef, angle: number): Vec3 {
  return { x: owner.x + def.orbitRadius * Math.cos(angle), y: owner.y + def.altitude, z: owner.z + def.orbitRadius * Math.sin(angle) };
}

/** Where shots at a hurt volume aim: its chest (PROJECTILE_HEIGHT_FRACTION of its height). */
function targetChest(t: HurtVolume): Vec3 {
  return { x: t.pos.x, y: t.pos.y + t.height * PROJECTILE_HEIGHT_FRACTION, z: t.pos.z };
}

/** A living drone's bolt is in its glow Telegraph (before its first HitEvent). */
function droneTelegraphing(d: DroneRuntime): boolean {
  const first = d.attack?.def.hits[0];
  return d.alive && d.attack !== null && first !== undefined && d.attack.t < first.t;
}

export interface EnemySpawn {
  kind: EnemyId | EliteId;
  /** Feet x / z; y is snapped to the terrain. */
  pos: Readonly<Vec3>;
  yaw?: number;
  /** Default: the kind's base level. */
  level?: number;
  /** Enemy_Camp or encounter group reported in 'enemy:defeated'; null (default) for a lone enemy. */
  campId?: string | null;
  /** SpawnerDef id; default the camp id, else the entity id. */
  spawner?: string;
}

export interface EnemySystemOptions {
  /** RuntimeState.enemies; the system adds, updates and removes its entries. */
  enemies: Map<EntityId, EnemyRuntime>;
  /** Terrain height, plus the slope / water / boundary queries the movement probes read (a TerrainField). */
  terrain: EnemyTerrain;
  /**
   * Height of the ground an enemy at `p` stands on (feet y after each move). Default the terrain height; the
   * session passes a probe that also finds walkable collider tops (platforms, the Challenge_Area floors).
   */
  ground?: (p: Readonly<Vec3>) => number;
  bus: GameEventBus;
  /** Shared melee tokens (capacity 2). */
  tokens?: MeleeTokenPool;
  /** GameState.codex: first reactions are recorded here (Req 25.13). */
  codex?: ReactionId[];
  /** GameLoop.setTimeScale: steamBurst's 70 ms Hit_Stop. */
  timeScale?: (source: TimeScaleSource, scale: number, realSeconds: number) => void;
  /** RuntimeState.zones: lava rifts are listed while they burn. */
  zones?: EffectZone[];
  /**
   * Ranged enemies' eye → chest sight rays and the movement probes' waist rays ('solid' mask, Req 28.4, 28.8).
   * Without it the sight line is always open and no obstacle blocks a probe.
   */
  world?: Pick<CollisionQueries, 'raycast'>;
  /** RuntimeState.enemyProjectiles: enemy projectiles in flight; default a fresh pool. */
  projectiles?: ProjectilePool;
  /** Terrain and colliders enemy projectiles stop on; without it they fly through everything but the target. */
  projectileWorld?: Pick<CollisionQueries, 'sweepCapsule'>;
}

export interface EnemyTickContext {
  dt: number;
  /** The Active_Character: detection and chase target, and what enemy attacks hit. */
  player: HitReceiver;
  /** Nothing moves or decides this tick (recovery fade, cinematic); interpolation still settles. */
  frozen?: boolean;
}

export class EnemySystem {
  readonly tokens: MeleeTokenPool;
  private readonly enemies: Map<EntityId, EnemyRuntime>;
  private readonly terrain: EnemyTerrain;
  private readonly ground: ((p: Readonly<Vec3>) => number) | null;
  /** What the movement probes read: the terrain, the standing ground and the world's solids. */
  private readonly probeEnv: ProbeEnv;
  private readonly bus: GameEventBus;
  private readonly world: Pick<CollisionQueries, 'raycast'> | null;
  private readonly receiverMap = new Map<EntityId, HitReceiver>();
  private readonly receiverView: Iterable<HitReceiver> = { [Symbol.iterator]: () => this.receiverMap.values() };
  /** Element_System over these enemies: spread, chains and the Reaction effects. */
  readonly reactions: ReactionSystem;
  /** Enemy projectiles in flight (their own pool, swept against `projectileWorld`). */
  readonly projectiles: ProjectileSystem;
  private serial = 0;
  private time = 0;
  /** Index of the next fixed tick (0 for the first): the 20 Hz decision phase. */
  private tickIndex = 0;
  /** Elites' drones by drone id. */
  private readonly droneMap = new Map<EntityId, DroneRuntime>();
  private readonly setTimeScale: ((source: TimeScaleSource, scale: number, realSeconds: number) => void) | null;

  constructor(options: EnemySystemOptions) {
    this.enemies = options.enemies;
    this.terrain = options.terrain;
    this.ground = options.ground ?? null;
    this.bus = options.bus;
    this.world = options.world ?? null;
    this.setTimeScale = options.timeScale ?? null;
    this.probeEnv = { terrain: this.terrain, ground: (p) => this.groundY(p), world: this.world };
    this.tokens = options.tokens ?? new MeleeTokenPool();
    this.projectiles = new ProjectileSystem({ pool: options.projectiles ?? { active: [] }, world: options.projectileWorld ?? null });
    this.reactions = new ReactionSystem({
      bus: this.bus,
      host: this.reactionHost(),
      now: () => this.time,
      codex: options.codex,
      setTimeScale: options.timeScale,
      zones: options.zones,
    });
  }

  /** Sim seconds ticked so far (Element_Mark expiry). */
  get simTime(): number {
    return this.time;
  }

  get(id: EntityId): Readonly<EnemyRuntime> | undefined {
    return this.enemies.get(id);
  }

  /** Some enemy is engaging the player (alert, chase, attack, recovery or stagger): In_Combat. */
  get engaged(): boolean {
    for (const e of this.enemies.values()) if (ENGAGED_STATES.has(e.state)) return true;
    return false;
  }

  /**
   * Enemies the party's hits can land on (dead bodies stay listed as immune until removed). A live view that
   * can be iterated any number of times and always reflects the current enemies.
   */
  receivers(): Iterable<HitReceiver> {
    return this.receiverView;
  }

  /**
   * Enemies whose attack Telegraph shows now (clip start to the first HitEvent), for the HUD's off-screen
   * Telegraph arrows (Req 21.5): body centre and whether the attack is heavy.
   */
  telegraphs(): { entityId: EntityId; pos: Vec3; strong: boolean }[] {
    const out: { entityId: EntityId; pos: Vec3; strong: boolean }[] = [];
    for (const e of this.enemies.values()) {
      const first = e.attack?.def.hits[0];
      if (e.state !== 'attack' || e.attack === null || first === undefined || e.attack.t >= first.t) continue;
      const def = getEnemyDef(e.def);
      out.push({
        entityId: e.id,
        pos: { x: e.pos.x, y: e.pos.y + def.height / 2, z: e.pos.z },
        strong: e.attack.def.telegraph?.strong ?? false,
      });
    }
    for (const d of this.droneMap.values()) {
      if (droneTelegraphing(d)) out.push({ entityId: d.id, pos: copyV3(d.pos), strong: d.def.attack.telegraph.strong });
    }
    return out;
  }

  /** The Elites' living drones (Sentinel Prime's), in spawn order. */
  drones(): DroneView[] {
    const out: DroneView[] = [];
    for (const d of this.droneMap.values()) {
      if (!d.alive) continue;
      out.push({
        id: d.id, owner: d.owner, pos: d.pos, prevPos: d.prevPos, radius: d.def.radius, hp: d.hp, maxHp: d.def.hp,
        telegraph: droneTelegraphing(d),
      });
    }
    return out;
  }

  /**
   * Spawns one enemy, idle at full HP; returns its entity id `<kind>_<k>` (k = 1, 2, …; its decision ordinal is
   * k − 1). @throws Error for a kind without data.
   */
  spawn(s: EnemySpawn): EntityId {
    const def = getEnemyDef(s.kind);
    const seq = this.serial;
    this.serial += 1;
    const id = `${s.kind}_${this.serial}`;
    const level = s.level ?? def.baseLevel;
    const maxHp = scaledMaxHp(def, level);
    const pos = { x: s.pos.x, y: this.groundY(s.pos), z: s.pos.z };
    const yaw = Number.isFinite(s.yaw) ? wrapAngle(s.yaw ?? 0) : 0;
    const campId = s.campId ?? null;
    const e: EnemyRuntime = {
      id, def: s.kind, level, pos, prevPos: copyV3(pos), prevYaw: yaw, spawnPos: copyV3(pos),
      vel: { x: 0, y: 0, z: 0 }, yaw, hp: maxHp, maxHp, state: 'idle', stateTime: 0, element: shieldedTarget(def),
      stagger: 0, flinch: 0, flinchHold: 0, knockTime: 0, staggerSeconds: ENEMY_STAGGER_SECONDS, stunUntil: 0, rootedUntil: 0,
      slow: null, guard: def.frontGuard === undefined ? null : 'up', spawner: s.spawner ?? campId ?? id, campId, attack: null,
      aim: null,
      seq, unseen: 0, asleep: false, steer: { ...STILL }, strafe: circleSide(seq), attackReadyAt: {},
      circling: false, detour: 0, progress: FRESH_PROGRESS, shieldSince: this.time,
    };
    this.enemies.set(id, e);
    this.receiverMap.set(id, this.receiverFor(e, def));
    const drones = def.elite?.drones;
    if (drones !== undefined) {
      for (let k = 0; k < drones.count; k++) this.addDrone(e, drones, k);
    }
    return id;
  }

  /**
   * Puts a living enemy back at its spawn position, idle at full HP with a clean slate and no melee token (a reset,
   * not an AI transition). False for an unknown or dead enemy.
   */
  reset(id: EntityId): boolean {
    const e = this.enemies.get(id);
    if (e === undefined || e.state === 'dead') return false;
    this.resetToSpawn(e);
    return true;
  }

  /** Removes an enemy (a dead body included) at once, giving back its melee token. False when unknown. */
  remove(id: EntityId): boolean {
    if (!this.enemies.has(id)) return false;
    this.tokens.release(id);
    this.enemies.delete(id);
    this.receiverMap.delete(id);
    this.dropDrones(id);
    return true;
  }

  /**
   * One EnemyAI tick for every enemy, in spawn order: the 80 m sleep check, then timers, knockback slide, pending
   * Stagger, the state's per-tick work (alert / recovery / stagger clocks, attack playback), the decision step on this
   * enemy's 20 Hz ticks, movement, and pending Stagger again (so one reached in alert starts as the chase begins).
   */
  tick(ctx: EnemyTickContext): void {
    const { dt } = ctx;
    if (!(Number.isFinite(dt) && dt > 0)) return;
    this.time += dt;
    const tick = this.tickIndex;
    this.tickIndex += 1;
    this.reactions.tick(ctx.frozen === true); // lava rift damage
    const target = ctx.player.hurtVolume();
    const gone: EntityId[] = [];
    for (const e of this.enemies.values()) {
      e.prevPos = copyV3(e.pos);
      e.prevYaw = e.yaw;
      if (ctx.frozen === true) continue;
      const def = getEnemyDef(e.def);
      if (e.state === 'dead') {
        e.stateTime += dt;
        e.flinch = Math.max(0, e.flinch - dt);
        if (e.stateTime >= ENEMY_DESPAWN_SECONDS - TIME_EPS) gone.push(e.id);
        continue;
      }
      if (this.sleeps(e, target.pos)) continue;
      this.rotateShield(e, def);
      e.stateTime += dt;
      e.flinch = Math.max(0, e.flinch - dt);
      e.flinchHold = Math.max(0, e.flinchHold - dt);
      if (ENGAGED_STATES.has(e.state)) e.unseen += dt;
      this.slide(e, dt);
      this.pendingStagger(e, def);
      this.run(e, def, ctx.player, target, dt);
      if (isDecisionTick(tick, e.seq)) this.decide(e, def, target);
      this.move(e, def, target, dt);
      this.pendingStagger(e, def);
      this.guardBreakTick(e, def); // after the state's work: a pending break staggers on the tick the chase begins
      e.pos.y = this.groundY(e.pos);
    }
    this.tickDrones(dt, ctx.frozen === true, target);
    // Projectiles already launched keep flying (and hitting) after their shooter's attack ends or it dies.
    if (ctx.frozen !== true) this.projectiles.tick(dt, [ctx.player]);
    for (const id of gone) {
      this.enemies.delete(id);
      this.dropDrones(id);
    }
    for (const id of this.receiverMap.keys()) if (!this.enemies.has(id) && !this.droneMap.has(id)) this.receiverMap.delete(id);
  }

  /**
   * Party_Wipe restart (design "스폰·캠프·재배치", Req 27.4): every living enemy that was engaging the party
   * (alert, chase, attack, recovery, stagger) goes back to its spawn position at full HP, idle, with no
   * attack, stagger, flinch or knockback and without its melee token. This is a reset of the fight, not an
   * AI transition, so it does not go through AI_TRANSITIONS. Reactions in progress and enemy projectiles are
   * dropped. SpawnerSystem.rebuild runs it first, then applies the spawner rules.
   */
  resetEngaged(): void {
    for (const e of this.enemies.values()) if (ENGAGED_STATES.has(e.state)) this.resetToSpawn(e);
    this.reactions.clear();
    this.projectiles.clear();
  }

  /**
   * Beyond 80 m of the target nothing runs this tick (Req 28.12). An engaged enemy is first reset to its spawn,
   * idle at full HP, so no frozen chase is left behind; a returning or idle one simply stops where it is.
   */
  private sleeps(e: EnemyRuntime, target: Readonly<Vec3>): boolean {
    const far = sleepsAt(distance(e.pos, target));
    if (far && ENGAGED_STATES.has(e.state)) this.resetToSpawn(e);
    e.asleep = far;
    return far;
  }

  /** Back at the spawn position, idle at full HP with a clean slate (a reset, not an AI transition). */
  private resetToSpawn(e: EnemyRuntime): void {
    this.tokens.release(e.id);
    e.pos = copyV3(e.spawnPos);
    e.prevPos = copyV3(e.spawnPos);
    e.hp = e.maxHp;
    e.state = 'idle';
    e.stateTime = 0;
    e.attack = null;
    e.aim = null;
    e.stagger = 0;
    e.flinch = 0;
    e.flinchHold = 0;
    e.knockTime = 0;
    e.vel = { x: 0, y: 0, z: 0 };
    e.element = shieldedTarget(getEnemyDef(e.def));
    e.shieldSince = this.time;
    e.stunUntil = 0;
    e.rootedUntil = 0;
    e.slow = null;
    e.unseen = 0;
    e.steer = { ...STILL };
    e.attackReadyAt = {};
    e.circling = false;
    e.detour = 0;
    e.progress = FRESH_PROGRESS;
    if (e.guard !== null) e.guard = 'up';
    this.restoreDrones(e);
  }

  /**
   * CollisionResolve (design "Tick 갱신 순서"; Req 28.7, 20.2, 20.7), once per tick after every displacement: keeps
   * awake living enemies at least 1.2 m apart horizontally (or their radius sum when larger), pushes enemies out of
   * the player's capsule within 0.2 s (swept against `world`), then resets an awake enemy 2 m or more under the
   * terrain or past 490 m from the centre to its spawn, idle at full HP (a reset, not an AI transition).
   */
  resolveCollisions(world: Pick<CollisionQueries, 'sweepCapsule'>, player: HurtVolume, dt: number): void {
    this.keepSpacing();
    this.separateFromPlayer(world, player, dt);
    for (const e of this.enemies.values()) {
      if (e.state === 'dead' || e.asleep) continue;
      if (enemyRecoveryPosition(this.terrain, e.pos, e.spawnPos) !== null) this.resetToSpawn(e);
    }
  }

  /** The spacing pass over awake living enemies (logic/aiSteering separateBodies); moved bodies are put back on the ground. */
  private keepSpacing(): void {
    const list: EnemyRuntime[] = [];
    for (const e of this.enemies.values()) if (e.state !== 'dead' && !e.asleep) list.push(e);
    if (list.length < 2) return;
    const positions = separateBodies(list.map((e) => this.bodyOf(e)));
    list.forEach((e, i) => {
      const p = positions[i];
      if (p === undefined || (p.x === e.pos.x && p.z === e.pos.z)) return;
      e.pos.x = p.x;
      e.pos.z = p.z;
      e.pos.y = this.groundY(e.pos);
    });
  }

  /** An enemy as a spacing body. */
  private bodyOf(e: EnemyRuntime): SpacingBody {
    const def = getEnemyDef(e.def);
    return { x: e.pos.x, y: e.pos.y, z: e.pos.z, radius: def.radius, height: def.height };
  }

  /** The awake living enemies other than `self`, as spacing bodies (separation steering). */
  private *neighbours(self: EnemyRuntime): Iterable<SpacingBody> {
    for (const e of this.enemies.values()) {
      if (e !== self && e.state !== 'dead' && !e.asleep) yield this.bodyOf(e);
    }
  }

  /**
   * Part of resolveCollisions: pushes living enemies out of the player's capsule within 0.2 s (Req 20.2; physics/
   * separation covers radii up to MAX_SEPARATION_AGENT_RADIUS, the largest enemy's), swept against `world`, then puts
   * them back on the ground.
   */
  separateFromPlayer(world: Pick<CollisionQueries, 'sweepCapsule'>, player: HurtVolume, dt: number): void {
    const living = [...this.enemies.values()].filter((e) => e.state !== 'dead');
    if (living.length === 0) return;
    const agents = living.map((e, i) => {
      const def = getEnemyDef(e.def);
      return { id: i, pos: { x: e.pos.x, y: e.pos.y + SEPARATION_LIFT, z: e.pos.z }, radius: def.radius, height: def.height };
    });
    const body = { id: -1, pos: copyV3(player.pos), radius: player.radius, height: player.height };
    const { positions } = resolvePlayerOverlaps(world, body, agents, dt);
    living.forEach((e, i) => {
      const p = positions[i];
      if (p === undefined || (p.x === e.pos.x && p.z === e.pos.z)) return; // not pushed: left as it stands
      e.pos.x = p.x;
      e.pos.z = p.z;
      e.pos.y = this.groundY(p);
    });
  }

  /** Every tick: the alert, recovery and stagger clocks, and the attack clip (Telegraph, hits). */
  private run(e: EnemyRuntime, def: EnemyDef, player: HitReceiver, target: HurtVolume, dt: number): void {
    switch (e.state) {
      case 'alert':
        this.turnToward(e, target.pos, dt);
        if (e.stateTime >= ALERT_SECONDS - TIME_EPS) this.setState(e, 'chase');
        break;
      case 'attack':
        this.attackTick(e, def, player, target, dt);
        break;
      case 'recovery':
        if (e.stateTime >= ENEMY_RECOVERY_SECONDS - TIME_EPS) {
          this.tokens.release(e.id);
          this.setState(e, 'chase');
        }
        break;
      case 'stagger':
        if (e.stateTime >= e.staggerSeconds - TIME_EPS) {
          e.stagger = 0;
          if (e.guard === 'staggered') e.guard = 'up'; // the broken guard is back (Req 28.11)
          this.setState(e, 'chase');
        }
        break;
      default:
        break;
    }
  }

  /**
   * The decision step (20 Hz): sight alerts idle / patrol (Req 28.3); an engaged enemy that sees the target resets
   * its lost-target clock; chase / recovery turn to return at the leash or after 8 s unseen (Req 28.5); a chase
   * picks its movement and may start an attack (Req 28.4); a return aims home.
   */
  private decide(e: EnemyRuntime, def: EnemyDef, target: HurtVolume): void {
    if (e.state === 'dead') return;
    const sees = detectsTarget(e.pos, e.yaw, target.pos, def.perception);
    if (alertsOn(e.state, 'sight')) {
      if (sees) this.alert(e);
      return;
    }
    if (e.state === 'return') {
      this.aimHome(e, def);
      return;
    }
    if (sees) e.unseen = 0;
    if (e.state !== 'chase' && e.state !== 'recovery') return;
    if (shouldReturn(distanceXZ(e.pos, e.spawnPos), e.unseen)) {
      this.startReturn(e, def);
      return;
    }
    if (e.state === 'chase') {
      if (def.melee) this.decideMelee(e, def, target);
      else this.decideRanged(e, def, target);
    }
  }

  /**
   * Melee chase (Req 28.4, 28.6): close in to the attack reach; there, the first ready attack starts once a token is
   * held. Refused, the enemy circles the target on the 4–6 m ring and asks again every decision; once it holds a
   * token it closes in and attacks.
   */
  private decideMelee(e: EnemyRuntime, def: EnemyDef, target: HurtVolume): void {
    if (e.circling) {
      if (!this.tokens.acquire(e.id)) {
        this.steerToward(e, def, ringSteer(e.pos, target.pos, e.strafe));
        return;
      }
      e.circling = false;
    }
    const dx = target.pos.x - e.pos.x;
    const dz = target.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > this.meleeReach(def, target) + ARRIVE_EPS) { // the move step stops at the reach, give or take rounding
      this.steerToward(e, def, { x: dx / d, z: dz / d });
      return;
    }
    e.steer = { ...STILL };
    const attack = pickAttack(def.attacks, Math.max(0, d - target.radius), e.attackReadyAt, this.time);
    if (attack === null) return;
    if (this.tokens.acquire(e.id)) {
      this.beginAttack(e, attack, target);
      return;
    }
    e.circling = true;
    this.steerToward(e, def, ringSteer(e.pos, target.pos, e.strafe));
  }

  /**
   * Ranged chase: approach beyond the keep band, back off inside it, strafe within it (kinds without a band close in
   * until an attack can reach); start the first ready attack only while the eye → chest sight line is open (Req 28.4).
   * A blocked line keeps the strafe going until it clears.
   */
  private decideRanged(e: EnemyRuntime, def: EnemyDef, target: HurtVolume): void {
    const dx = target.pos.x - e.pos.x;
    const dz = target.pos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    const gap = Math.max(0, d - target.radius);
    const ux = d > 1e-6 ? dx / d : 0;
    const uz = d > 1e-6 ? dz / d : 0;
    const reachable = def.attacks.some((a) => gap <= a.useRange[1]);
    const move = def.keepRange !== undefined ? keepRangeMove(d, def.keepRange) : reachable ? null : 'approach';
    if (move === 'approach') this.steerToward(e, def, { x: ux, z: uz });
    else if (move === 'retreat') this.steerToward(e, def, { x: -ux, z: -uz });
    else if (move === 'strafe') {
      this.steerToward(e, def, { x: uz * e.strafe * STRAFE_SPEED_FRACTION, z: -ux * e.strafe * STRAFE_SPEED_FRACTION });
    } else e.steer = { ...STILL };
    const attack = pickAttack(def.attacks, gap, e.attackReadyAt, this.time);
    if (attack !== null && this.hasSight(e, def, target)) this.beginAttack(e, attack, target);
  }

  /** Whether the eye → chest ray reaches the target without hitting a solid (terrain or collider). */
  private hasSight(e: EnemyRuntime, def: EnemyDef, target: HurtVolume): boolean {
    if (this.world === null) return true;
    const line = sightLine(e.pos, def.height, target.pos, target.height);
    if (line === null) return true;
    const hit = this.world.raycast(copyV3(line.origin), copyV3(line.dir), line.distance, { mask: 'solid' });
    return sightClear(line, hit?.distance ?? null);
  }

  /**
   * Starts `attack`: its Telegraph runs from now to the first HitEvent. A target-aimed attack locks the target's feet
   * as the centre of its ground shapes. 'enemy:telegraph' asks the Audio_System for the ready sound (Req 26.5).
   */
  private beginAttack(e: EnemyRuntime, attack: EnemyAttackDef, target: HurtVolume): void {
    if (!this.setState(e, 'attack')) return;
    e.attack = startAttack(attack);
    e.aim = attack.aim === 'target' ? copyV3(target.pos) : null;
    if (attack.cooldown > 0) e.attackReadyAt[attack.id] = this.time + attack.cooldown;
    this.bus.emit('enemy:telegraph', {
      entityId: e.id,
      kind: e.def,
      attackId: attack.id,
      telegraph: attack.telegraph.kind,
      strong: attack.telegraph.strong,
      seconds: attack.telegraph.duration,
      position: copyV3(e.aim ?? e.pos),
      yaw: e.yaw,
    });
  }

  /**
   * Return (Req 28.5): gives back the token, full HP and an empty stagger meter at once, then heads home. An
   * Element_Shield and drones come back with the HP (design: a broken shield returns only this way).
   */
  private startReturn(e: EnemyRuntime, def: EnemyDef): void {
    if (!this.setState(e, 'return')) return;
    this.tokens.release(e.id);
    e.attack = null;
    e.aim = null;
    e.hp = e.maxHp;
    e.stagger = 0;
    e.unseen = 0;
    if (def.shield !== undefined) {
      e.element = { ...e.element, mark: null, shield: freshShield(def.shield) };
      e.shieldSince = this.time;
    }
    this.restoreDrones(e);
    this.aimHome(e, def);
  }

  private aimHome(e: EnemyRuntime, def: EnemyDef): void {
    const dx = e.spawnPos.x - e.pos.x;
    const dz = e.spawnPos.z - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) this.steerToward(e, def, { x: dx / d, z: dz / d });
    else e.steer = { ...STILL };
  }

  /**
   * Sets the steer from `desired` (fraction of the move speed): separation steering away from close neighbours is
   * added (capped at full speed, Req 28.7), then the direction is turned onto the open probe direction nearest to it
   * (0°, else ±40°; Req 28.8). With every probe blocked, or nothing to do, the enemy stands (the move step still
   * turns it toward its goal).
   */
  private steerToward(e: EnemyRuntime, def: EnemyDef, desired: Planar): void {
    if (!(Math.hypot(desired.x, desired.z) > 1e-6) || !(def.moveSpeed > 0)) {
      e.steer = { ...STILL };
      return;
    }
    const sep = separationSteer(this.bodyOf(e), this.neighbours(e));
    const v = capLength({ x: desired.x + sep.x, z: desired.z + sep.z }, 1);
    const mag = Math.hypot(v.x, v.z);
    if (!(mag > 1e-6)) {
      e.steer = { ...STILL };
      return;
    }
    const dir = { x: v.x / mag, z: v.z / mag };
    const toward = (choice: number): Planar => (choice === 0 ? dir : rotateYaw(dir, choice * PROBE_SIDE_RAD));
    const choice = chooseProbe((c) => probeBlockedAt(this.probeEnv, e.pos, def.height, toward(c)), e.detour, e.strafe);
    if (choice === null) {
      e.steer = { ...STILL };
      return;
    }
    e.detour = choice;
    const chosen = toward(choice);
    e.steer = { x: chosen.x * mag, z: chosen.z * mag };
  }

  /**
   * Every tick: a chase faces the target and moves along its steer (a melee one never inside its reach, except
   * while circling); a return faces home and walks there, idle on arrival (kinds that cannot walk arrive where they
   * stand). Progress (Req 28.8, 20.7): while approaching, what the enemy's own walking closed on its goal this tick
   * is added to its progress window; 2 s without 0.5 m turns a chase to return and resets a return to its spawn.
   * Ticks it cannot walk (knockback, rooted) or is not approaching (at its goal, circling, strafing) restart the window.
   */
  private move(e: EnemyRuntime, def: EnemyDef, target: HurtVolume, dt: number): void {
    if (e.state === 'chase') {
      this.turnToward(e, target.pos, dt);
      const before = distanceXZ(e.pos, target.pos);
      const limit = def.melee && !e.circling
        ? Math.max(0, before - this.meleeReach(def, target))
        : Number.POSITIVE_INFINITY;
      const goal = this.approachGoal(e, def, target);
      const tracked = goal !== null && before > goal + ARRIVE_EPS && this.canWalk(e, def);
      this.walk(e, def, dt, limit);
      const after = distanceXZ(e.pos, target.pos);
      if (!tracked || after <= goal + ARRIVE_EPS) {
        e.progress = FRESH_PROGRESS;
        return;
      }
      e.progress = advanceProgress(e.progress, before - after, dt);
      if (progressStalled(e.progress)) this.startReturn(e, def);
      return;
    }
    if (e.state !== 'return') return;
    const home = distanceXZ(e.pos, e.spawnPos);
    const tracked = this.canWalk(e, def);
    if (home > RETURN_ARRIVE_DISTANCE && def.moveSpeed > 0) {
      this.turnToward(e, e.spawnPos, dt);
      this.walk(e, def, dt, home);
    }
    const after = distanceXZ(e.pos, e.spawnPos);
    if (after <= RETURN_ARRIVE_DISTANCE || !(def.moveSpeed > 0)) {
      this.setState(e, 'idle');
      return;
    }
    e.progress = tracked ? advanceProgress(e.progress, home - after, dt) : FRESH_PROGRESS;
    if (progressStalled(e.progress)) this.resetToSpawn(e); // stuck on the way home (design "복구")
  }

  /**
   * The target distance a chase is closing in to, or null when it is not approaching: a melee enemy's reach (not
   * while circling), a ranged one's keep band's far edge, or for a ranged kind without a band its longest attack.
   */
  private approachGoal(e: EnemyRuntime, def: EnemyDef, target: HurtVolume): number | null {
    if (def.melee) return e.circling ? null : this.meleeReach(def, target);
    if (def.keepRange !== undefined) return def.keepRange[1];
    let longest = 0;
    for (const a of def.attacks) longest = Math.max(longest, a.useRange[1]);
    return longest + target.radius;
  }

  /**
   * Whether the enemy can walk by itself this tick: it has a move speed, no knockback slide, no poise-breaking
   * flinch holds it, and it is not rooted.
   */
  private canWalk(e: EnemyRuntime, def: EnemyDef): boolean {
    return def.moveSpeed > 0 && e.knockTime <= 0 && e.flinchHold <= 0 && this.moveMul(e) > 0;
  }

  /**
   * Moves along the steer at the move speed (× slows), at most `limit` m; not while a knockback slides it or a
   * poise-breaking flinch holds it.
   */
  private walk(e: EnemyRuntime, def: EnemyDef, dt: number, limit: number): void {
    if (e.knockTime > 0 || e.flinchHold > 0) return;
    const mag = Math.hypot(e.steer.x, e.steer.z);
    if (!(mag > 0)) return;
    const step = Math.min(def.moveSpeed * this.moveMul(e) * mag * dt, limit);
    if (!(step > 0)) return;
    e.pos.x += (e.steer.x / mag) * step;
    e.pos.z += (e.steer.z / mag) * step;
  }

  /** Centre distance at which a melee enemy stops and attacks: its reach to the target's surface, less a margin. */
  private meleeReach(def: EnemyDef, target: HurtVolume): number {
    return Math.max(0, def.attackRange + target.radius - APPROACH_MARGIN);
  }

  /** A full stagger meter (Req 26.9) or a pending Reaction Stagger starts as soon as the AI state allows one. */
  private pendingStagger(e: EnemyRuntime, def: EnemyDef): void {
    if (e.stagger >= def.staggerThreshold && aiTransition(e.state, 'stagger')) this.enterStagger(e, ENEMY_STAGGER_SECONDS);
    this.stunTick(e);
  }

  /**
   * Plays the attack clip: tracks the target during the Telegraph, then, at each HitEvent's clip time (never before
   * the Telegraph ends), judges it against the Active_Character (the receiver ignores it during Dodge i-frames) or
   * launches its projectile.
   */
  private attackTick(e: EnemyRuntime, def: EnemyDef, player: HitReceiver, target: HurtVolume, dt: number): void {
    const p = e.attack;
    if (p === null) {
      this.setState(e, 'recovery');
      return;
    }
    const first = p.def.hits[0];
    if (first !== undefined && p.t < first.t) this.turnToward(e, target.pos, dt);
    const due = advanceAttack(p, dt);
    if (due.length > 0) {
      const attacker = this.attackerFor(e, def);
      for (const index of due) {
        const hit = p.def.hits[index];
        if (hit?.shape.kind === 'projectile') this.launch(e, def, attacker, p.def.id, index, hit, target);
        else judgeHitEvent(p, index, attacker, [player]);
      }
    }
    if (attackFinished(p)) {
      e.attack = null;
      e.aim = null;
      this.setState(e, 'recovery');
    }
  }

  /** A projectile HitEvent: from the body's chest height toward the target's chest, swept every tick. */
  private launch(
    e: EnemyRuntime, def: EnemyDef, attacker: Attacker, attackId: EnemyAttackDef['id'], index: number, hit: HitEvent,
    target: HurtVolume,
  ): void {
    const from = { x: e.pos.x, y: e.pos.y + def.height * PROJECTILE_HEIGHT_FRACTION, z: e.pos.z };
    const to = { x: target.pos.x, y: target.pos.y + target.height * PROJECTILE_HEIGHT_FRACTION, z: target.pos.z };
    const dir = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    this.projectiles.spawn({ attacker: { ...attacker, origin: { pos: e.pos, yaw: e.yaw } }, attackId, hitIndex: index, hit, from, dir });
  }

  /**
   * Enemy hits: computeDamage kind 'enemy', ATK scaled once through the level (level 1 for fixed guardian Elites),
   * no crits (Req 28.10). Shapes sit in the attacker's frame, centred on the locked target point for target-aimed
   * attacks.
   */
  private attackerFor(e: EnemyRuntime, def: EnemyDef): Attacker {
    return {
      id: e.id,
      origin: { pos: e.aim ?? e.pos, yaw: e.yaw },
      stats: {
        baseAtk: def.atk,
        level: scaledDamageLevel(def, e.level),
        equipAtkPct: 0,
        abilityUpgradePct: 0,
        equipDmgPct: 0,
        critChance: 0,
      },
      kind: 'enemy',
      element: null,
      roll: () => 0,
    };
  }

  private receiverFor(e: EnemyRuntime, def: EnemyDef): HitReceiver {
    return {
      id: e.id,
      hurtVolume: () => ({ pos: e.pos, radius: def.radius, height: def.height }),
      immune: () => e.state === 'dead',
      sample: (direction) => ({
        def: def.def,
        // An intact front guard covers hits from its frontal sector; computeDamage cuts Normal ones ×0.3 (Req 28.11).
        frontGuard: e.guard === 'up' && def.frontGuard !== undefined && direction !== undefined
          && guardCovers(e.yaw, direction, def.frontGuard.arcDeg),
        shieldElement: e.element.shield?.element ?? null,
        vulnerable: false,
        terraMarked: activeMark(e.element, this.time)?.element === 'terra',
      }),
      receive: (hit) => this.onHit(e, def, hit),
    };
  }

  /**
   * HP first; a lethal hit kills at once. Otherwise the hit's Element (applyElement, Req 24.2), a front guard break
   * (Ember or Charged_Attack, Req 28.11), then stagger gain, flinch, knockback and aggro.
   */
  private onHit(e: EnemyRuntime, def: EnemyDef, hit: ResolvedHit): void {
    if (e.state === 'dead') return;
    // An Element_Shield takes the hit first (same Element already ×0.25 in computeDamage), HP the rest (Req 25.10).
    e.hp = Math.max(0, e.hp - this.shieldFirst(e, hit.amount, 1));
    // Every hit flinches for 0.2 s without an AI transition (Req 26.1). One at or above the poise also holds the
    // body still for it, except mid-attack, where it stays additive and the Telegraph / clip runs on.
    e.flinch = ENEMY_FLINCH_SECONDS;
    if (hit.stagger >= def.poise && e.state !== 'attack') e.flinchHold = ENEMY_FLINCH_SECONDS;
    if (e.hp <= 0) {
      this.kill(e);
      return;
    }
    if (hit.element !== null) {
      // Element_System: mark / reaction with spread and chains, then the reaction effects (Req 24.2, 25.5–25.7).
      this.reactions.apply(e.id, hit.element, hit.elementSource ?? 'enemy', {
        damage: hit.amount,
        reactor: hit.attackerStats ?? null,
      });
      if ((e.state as AiState) === 'dead') return; // the reaction's own damage finished it
    }
    if (e.guard === 'up' && def.frontGuard !== undefined && breaksGuard(def.frontGuard, hit)) {
      e.guard = 'broken';
      this.guardBreakTick(e, def);
    }
    this.weakSpotHit(e, def, hit);
    e.stagger += hit.stagger;
    if (hit.knockback > 0 && def.movement.kind !== 'anchored') { // an anchored guardian is rooted: no slide
      const speed = hit.knockback / ENEMY_KNOCKBACK_SECONDS;
      e.vel = { x: hit.direction.x * speed, y: 0, z: hit.direction.z * speed };
      e.knockTime = ENEMY_KNOCKBACK_SECONDS;
    }
    this.noticeHit(e); // a hit counts as detection
  }

  /**
   * A back weak spot (Rootbound Warden's glowing root): a hit carrying its Element from inside the sector behind the
   * facing starts its Stagger (2 s) as soon as the AI state allows one, like a Reaction Stagger, and emits
   * 'enemy:weakSpot' for the hit effect.
   */
  private weakSpotHit(e: EnemyRuntime, def: EnemyDef, hit: ResolvedHit): void {
    for (const effect of def.weakness.effects) {
      if (effect.kind !== 'backWeakSpot' || hit.element !== effect.element) continue;
      if (!hitsFromBehind(e.yaw, hit.direction, effect.arcDeg)) continue;
      e.stunUntil = Math.max(e.stunUntil, this.time + effect.staggerSeconds);
      this.stunTick(e);
      this.bus.emit('enemy:weakSpot', { entityId: e.id, kind: e.def, seconds: effect.staggerSeconds });
    }
  }

  /** Being hit alerts an idle, patrolling or returning enemy (Req 28.3) and restarts an engaged one's lost-target clock. */
  private noticeHit(e: EnemyRuntime): void {
    e.unseen = 0;
    if (alertsOn(e.state, 'hit')) this.alert(e);
  }

  /**
   * Applies `element` from `source` without a hit (environment devices, tests): the same Element_System path as a
   * hit's Element, with no trigger damage and no reactor. A dead or unknown enemy is ignored.
   */
  applyElement(id: EntityId, element: ElementId, source: ElementSource): void {
    const e = this.enemies.get(id);
    if (e === undefined || e.state === 'dead') return;
    this.reactions.apply(id, element, source, null);
  }

  /** The enemies as the ReactionSystem's targets. */
  private reactionHost(): ReactionHost {
    const living = (id: EntityId): EnemyRuntime | null => {
      const e = this.enemies.get(id);
      return e === undefined || e.state === 'dead' ? null : e;
    };
    return {
      actors: () => {
        const out: ReactionActor[] = [];
        for (const e of this.enemies.values()) {
          out.push({ id: e.id, pos: e.pos, alive: e.state !== 'dead', def: getEnemyDef(e.def).def, element: e.element });
        }
        return out;
      },
      setElement: (id, next) => {
        const e = this.enemies.get(id);
        if (e !== undefined) e.element = next;
      },
      damage: (id, amount, element) => {
        const e = living(id);
        if (e !== null) this.reactionDamage(e, amount, element);
      },
      stagger: (id, seconds) => {
        const e = living(id);
        if (e !== null && seconds > 0) e.stunUntil = Math.max(e.stunUntil, this.time + seconds);
      },
      root: (id, until) => {
        const e = living(id);
        if (e !== null) e.rootedUntil = Math.max(e.rootedUntil, until);
      },
      slow: (id, mul, until) => {
        const e = living(id);
        if (e === null) return;
        const active = e.slow !== null && this.time < e.slow.until ? e.slow : null;
        e.slow = { mul: Math.min(mul, active?.mul ?? 1), until: Math.max(until, active?.until ?? until) };
      },
    };
  }

  /**
   * Reaction damage: into an Element_Shield ×3 first (Req 25.10), the rest to HP; a damage number, death at 0; it wakes
   * an idle enemy like a hit.
   */
  private reactionDamage(e: EnemyRuntime, amount: number, element: ElementId | null): void {
    if (!(amount > 0)) return;
    e.hp = Math.max(0, e.hp - this.shieldFirst(e, amount, SHIELD_REACTION_MUL));
    const def = getEnemyDef(e.def);
    this.bus.emit('damage:dealt', {
      targetId: e.id, amount, crit: false, element, position: { x: e.pos.x, y: e.pos.y + def.height, z: e.pos.z },
    });
    if (e.hp <= 0) {
      this.kill(e);
      return;
    }
    this.noticeHit(e);
  }

  /** A pending Reaction Stagger starts (or lengthens the current one) as soon as the AI state allows it. */
  private stunTick(e: EnemyRuntime): void {
    const left = e.stunUntil - this.time;
    if (!(left > TIME_EPS)) return;
    if (e.state === 'stagger') e.staggerSeconds = Math.max(e.staggerSeconds, e.stateTime + left);
    else if (aiTransition(e.state, 'stagger')) this.enterStagger(e, left);
  }

  /**
   * A broken front guard's Stagger (3 s, Req 28.11) starts as soon as the AI state allows it; one already running
   * (meter or Reaction) is lengthened to last that long from now instead.
   */
  private guardBreakTick(e: EnemyRuntime, def: EnemyDef): void {
    if (e.guard !== 'broken' || def.frontGuard === undefined) return;
    const seconds = def.frontGuard.breakStagger;
    if (e.state === 'stagger') e.staggerSeconds = Math.max(e.staggerSeconds, e.stateTime + seconds);
    else if (aiTransition(e.state, 'stagger')) this.enterStagger(e, seconds);
    else return;
    e.guard = 'staggered';
  }

  /** Move speed multiplier: 0 while rooted, × the Reaction slow, × the Tide mark's 0.8 (Req 25.4). */
  private moveMul(e: EnemyRuntime): number {
    if (this.time < e.rootedUntil) return 0;
    const slow = e.slow !== null && this.time < e.slow.until ? e.slow.mul : 1;
    return slow * markModifiers(e.element, this.time).moveSpeedMul;
  }

  private kill(e: EnemyRuntime): void {
    if (!this.setState(e, 'dead')) return;
    this.tokens.release(e.id);
    e.attack = null;
    e.aim = null;
    e.flinchHold = 0;
    e.vel = { x: 0, y: 0, z: 0 };
    e.knockTime = 0;
    this.dropDrones(e.id); // the drones fall with their Elite
    this.bus.emit('enemy:defeated', { entityId: e.id, kind: e.def, campId: e.campId });
  }

  // ── Element_Shield ─────────────────────────────────────────────────────────

  /**
   * `amount` of damage (in HP units) meets the Element_Shield first: `amount × mul` goes into its durability (×3 for
   * Reaction damage), and what the shield could not hold comes back in HP units for HP. A shield that breaks here is
   * gone with its 3 s Stagger (Req 25.11) and a Hit_Stop. Without a shield all of it is for HP.
   */
  private shieldFirst(e: EnemyRuntime, amount: number, mul: number): number {
    const shield = e.element.shield;
    if (shield === null || !(amount > 0) || !(mul > 0)) return amount;
    const into = amount * mul;
    const absorbed = Math.min(shield.durability, into);
    const { next, broken } = damageShield(e.element, absorbed);
    e.element = next;
    if (broken) {
      e.stunUntil = Math.max(e.stunUntil, this.time + SHIELD_BREAK_STAGGER);
      this.stunTick(e);
      this.setTimeScale?.('hitStop', 0, SHIELD_BREAK_HIT_STOP);
    }
    return Math.round((into - absorbed) / mul);
  }

  /** A rotating Element_Shield follows its switches since it was raised (its durability stays). */
  private rotateShield(e: EnemyRuntime, def: EnemyDef): void {
    const shield = e.element.shield;
    const spec = def.shield;
    if (shield === null || spec?.rotation === undefined) return;
    const element = shieldElementAt(spec.element, spec.rotation, this.time - e.shieldSince);
    if (element !== shield.element) e.element = { ...e.element, shield: { ...shield, element } };
  }

  // ── Drones ─────────────────────────────────────────────────────────────────

  private addDrone(owner: EnemyRuntime, def: DroneDef, k: number): void {
    const angle = (2 * Math.PI * k) / def.count;
    const d: DroneRuntime = {
      id: `${owner.id}_drone_${k + 1}`, owner: owner.id, def, angle, pos: dronePoint(owner.pos, def, angle), prevPos: dronePoint(owner.pos, def, angle),
      hp: def.hp, alive: true, attack: null, readyAt: this.time,
    };
    this.droneMap.set(d.id, d);
    this.receiverMap.set(d.id, this.droneReceiver(d));
  }

  /** Back to full HP around the owner, no bolt in progress (the owner's return or reset). */
  private restoreDrones(owner: EnemyRuntime): void {
    for (const d of this.droneMap.values()) {
      if (d.owner !== owner.id) continue;
      d.hp = d.def.hp;
      d.attack = null;
      d.readyAt = this.time;
      d.pos = dronePoint(owner.pos, d.def, d.angle);
      d.prevPos = copyV3(d.pos);
      if (!d.alive) {
        d.alive = true;
        this.receiverMap.set(d.id, this.droneReceiver(d));
      }
    }
  }

  /** Removes the drones of `owner` (its death or removal). */
  private dropDrones(owner: EntityId): void {
    for (const [id, d] of this.droneMap) {
      if (d.owner !== owner) continue;
      this.droneMap.delete(id);
      this.receiverMap.delete(id);
    }
  }

  /**
   * Every tick: drones circle their living, awake owner; while it chases or attacks each fires its bolt when ready, the
   * target within reach and in sight. `frozen` keeps them where they are.
   */
  private tickDrones(dt: number, frozen: boolean, target: HurtVolume): void {
    for (const d of this.droneMap.values()) {
      d.prevPos = copyV3(d.pos);
      const owner = this.enemies.get(d.owner);
      if (frozen || !d.alive || owner === undefined || owner.state === 'dead' || owner.asleep) continue;
      d.angle = wrapAngle(d.angle + DRONE_ORBIT_RATE * dt);
      d.pos = dronePoint(owner.pos, d.def, d.angle);
      const attack = d.def.attack;
      if (d.attack === null) {
        const inReach = distance(d.pos, targetChest(target)) <= attack.useRange[1] + target.radius;
        if (!DRONE_FIRING.has(owner.state) || this.time < d.readyAt || !inReach || !this.droneSight(d, target)) continue;
        d.attack = startAttack(attack);
        d.readyAt = this.time + attack.cooldown;
        this.bus.emit('enemy:telegraph', {
          entityId: d.id, kind: owner.def, attackId: attack.id, telegraph: attack.telegraph.kind, strong: attack.telegraph.strong,
          seconds: attack.telegraph.duration, position: copyV3(d.pos), yaw: owner.yaw,
        });
      }
      const p = d.attack;
      const due = advanceAttack(p, dt);
      if (due.length > 0) {
        const def = getEnemyDef(owner.def);
        const attacker = { ...this.attackerFor(owner, def), id: d.id, origin: { pos: d.pos, yaw: owner.yaw } };
        for (const index of due) {
          const hit = p.def.hits[index];
          if (hit?.shape.kind !== 'projectile') continue;
          const to = targetChest(target);
          const dir = { x: to.x - d.pos.x, y: to.y - d.pos.y, z: to.z - d.pos.z };
          this.projectiles.spawn({ attacker, attackId: p.def.id, hitIndex: index, hit, from: copyV3(d.pos), dir });
        }
      }
      if (attackFinished(p)) d.attack = null;
    }
  }

  /** The drone → target chest line is open (no solid in between). */
  private droneSight(d: DroneRuntime, target: HurtVolume): boolean {
    if (this.world === null) return true;
    const to = targetChest(target);
    const dx = to.x - d.pos.x;
    const dy = to.y - d.pos.y;
    const dz = to.z - d.pos.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-6)) return true;
    const hit = this.world.raycast(copyV3(d.pos), { x: dx / len, y: dy / len, z: dz / len }, len, { mask: 'solid' });
    return hit === null || hit.distance >= len - target.radius;
  }

  private droneReceiver(d: DroneRuntime): HitReceiver {
    const r = d.def.radius;
    return {
      id: d.id,
      hurtVolume: () => ({ pos: { x: d.pos.x, y: d.pos.y - r, z: d.pos.z }, radius: r, height: 2 * r }),
      immune: () => !d.alive,
      sample: () => ({ def: d.def.def, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
      receive: (hit) => {
        if (!d.alive) return;
        d.hp = Math.max(0, d.hp - hit.amount);
        if (d.hp > 0) return;
        d.alive = false;
        d.attack = null;
        this.receiverMap.delete(d.id);
      },
    };
  }

  private alert(e: EnemyRuntime): void {
    if (this.setState(e, 'alert')) this.bus.emit('enemy:alerted', { entityId: e.id, kind: e.def, campId: e.campId });
  }

  private enterStagger(e: EnemyRuntime, seconds: number): void {
    this.tokens.release(e.id);
    e.attack = null;
    e.aim = null;
    if (this.setState(e, 'stagger')) e.staggerSeconds = seconds;
  }

  /**
   * Changes state only along an AI_TRANSITIONS edge; resets the state clock, the steer (the next decision picks
   * one), circling and the progress window.
   */
  private setState(e: EnemyRuntime, to: AiState): boolean {
    if (!aiTransition(e.state, to)) return false;
    e.state = to;
    e.stateTime = 0;
    e.steer = { ...STILL };
    e.circling = false;
    e.progress = FRESH_PROGRESS;
    return true;
  }

  /**
   * Moves by the knockback velocity while the slide lasts. A slide never pushes the body up terrain steeper than
   * walkable or onto ground more than a step above its feet (a cliff or room wall), nor over an edge onto ground more
   * than KNOCKBACK_MAX_DROP below them (a platform's rim: the Observatory's roof, stairs and dome): it stops there instead.
   */
  private slide(e: EnemyRuntime, dt: number): void {
    if (e.knockTime <= 0) return;
    const s = Math.min(dt, e.knockTime);
    const x = e.pos.x + e.vel.x * s;
    const z = e.pos.z + e.vel.z * s;
    const steep = (this.terrain.slopeDeg?.(x, z) ?? 0) > MAX_WALKABLE_SLOPE_DEG;
    const step = this.groundY({ x, y: e.pos.y, z }) - e.pos.y;
    if (steep || step > KNOCKBACK_MAX_RISE || step < -KNOCKBACK_MAX_DROP) {
      e.knockTime = 0;
      e.vel = { x: 0, y: 0, z: 0 };
      return;
    }
    e.pos.x = x;
    e.pos.z = z;
    e.knockTime -= s;
    if (e.knockTime <= TIME_EPS) {
      e.knockTime = 0;
      e.vel = { x: 0, y: 0, z: 0 };
    }
  }

  /** Turns toward `to` at the shared turn rate, or an anchored kind's own (Rootbound Warden 60°/s). */
  private turnToward(e: EnemyRuntime, to: Readonly<Vec3>, dt: number): void {
    const dx = to.x - e.pos.x;
    const dz = to.z - e.pos.z;
    if (Math.hypot(dx, dz) < 1e-6) return;
    const delta = angleDelta(e.yaw, yawFromDir(dx, dz));
    const movement = getEnemyDef(e.def).movement;
    const rate = movement.kind === 'anchored' ? movement.turnRateDeg * DEG2RAD : ENEMY_TURN_RATE;
    const max = rate * dt;
    e.yaw = wrapAngle(e.yaw + Math.max(-max, Math.min(max, delta)));
  }

  private groundY(p: Readonly<Vec3>): number {
    const h = this.ground !== null ? this.ground(p) : this.terrain.heightAt(p.x, p.z);
    return Number.isFinite(h) ? h : p.y;
  }
}

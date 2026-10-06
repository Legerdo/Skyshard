// Caelith's full encounter (design "Boss Caelith"; Req 6.1–6.14, 2.4). Data driven: numbers from src/data/boss,
// Phase / Starshell rules from src/logic/boss, the next action from ./bossBrain.
// - States: dormant → intro (cin_boss_intro on the first entry) → idle ⇄ telegraph → attack → recovery, stagger
//   (vulnerable windows), disabled (Starshell broken), transition (3 s between Phases) → dead.
// - Attacks (CAELITH_ACTIONS / CAELITH_GEOMETRY): every judgement is a hazard placed when the action starts, whose
//   Telegraph shows from `shownAt` and which is judged at `at`; a shown Telegraph is never cancelled, moved or resized
//   (Req 6.9). slashCombo (3 front sectors), starShards (3 aim lines, then shards at 22 m/s), groundSlam (6 m circle),
//   dash (20 m × 3 m line, then a rush along it), sectorBlast (4 of the 8 arena sectors, 0.4 s apart), summonCrystals
//   (fills the empty sockets), starfall (5 circles of 3 m), astralSweep (1.2 s leap, then a ring 0.8 m high and 1.5 m
//   thick at 14 m/s: feet above 0.8 m or Dodge i-frames pass it, Req 6.8). Hits resolve through computeDamage (kind
//   'enemy', ATK 120, level 1, no crits) against the target's DEF; a target in Dodge i-frames is told it evaded
//   (Perfect_Dodge). One volley (starfall's circles, a shard) hits a target once.
// - Scheduling: BossBrain picks at the end of each wait (Phase interval ± 0.3 s); no Telegraph starts within 1.0 s of a
//   strong attack's end (Caelith's or a crystal pulse). Phase 1's combo (every 3rd decision) chains groundSlam after
//   slashCombo, then 3 s `stagger`; the Final Phase's Astral Sweep is followed by a 2.5 s `stagger`.
// - Phases (Req 6.1, 6.10): HP stops at the Phase floor (65 % / 30 %) and the overflow is discarded until the
//   transition ends. Reaching the floor mid-attack lets the attack play out; otherwise (stagger, disabled included)
//   the transition starts at once: 'boss:phaseChanged', every hazard / shard / ring / lava rift cleared, neither side
//   takes damage for 3 s, the Phase's music and (Final) the starlit sky switch; then the new pool, interval and
//   Starshell apply.
// - Starshell (Req 6.3–6.5): raised after the Phase 2 transition (1,200) and the Final one (900) with an Element from
//   the `boss` stream, rotating every 12 s (nextStarshellElement). It takes every hit instead of HP (overflow
//   discarded): the Element_System treats Caelith as permanently marked with its Element, so same-Element hits deal
//   ×0.25 (computeDamage) and Reaction damage goes in ×3; it is never consumed. Broken: Hit_Stop, `disabled` 6 s at
//   ×1.5 (after the attack in progress), then it regrows with a new Element at full durability and the 12 s clock
//   restarts. During a vulnerable `stagger` it is suppressed: hits go to HP ×1.5, the clock pauses, and it comes back
//   as it was.
// - Shard_Crystals (Req 6.6): one per Element on the four pedestals, HP 300, DEF 0, targets of the party's hits.
//   Broken with Caelith within 6 m, its Element is applied to Caelith through the Element_System (Reaction effects,
//   'reaction' events) plus a 150 burst: ×3 into a reacting Starshell, ×0.25 into a matching one, else to HP. Standing,
//   a crystal with a Party character within 3 m pulses a 3 m ring 0.8 s after its Telegraph, at most every 6 s. A
//   re-summon fills only empty sockets. They stay across a transition and are removed by begin() and the defeat.
// - Retry and defeat (Req 6.13, 6.14): begin(fromPhase) resets HP to the Phase's checkpoint, heals the party
//   (`healParty`), clears cooldowns and forced-event counters, re-raises the Phase's Starshell and removes the
//   crystals (re-summoned by the first action). halt() stops the fight on a Party_Wipe until the Defeat choice. At HP
//   0: `dead`, every hazard cleared at once, then 'boss:defeated' (the Cinematic_System plays the ending).
// Caelith floats CAELITH.hover above the arena floor and is a dynamic cylinder collider while it stands there.
// RuntimeState.boss mirrors Phase and HP. Pure TypeScript: no three.js / DOM.

import { resolveHit, type Attacker, type HitReceiver, type ResolvedHit } from '../combat/attackRuntime';
import { hitShapeOverlaps, type HurtVolume } from '../combat/hitShapes';
import type { SetTimeScale } from '../combat/perfectDodge';
import type { GameEventBus } from '../core/gameEvents';
import { angleDelta, copyV3, DEG2RAD, dirFromYaw, wrapAngle, yawFromDir } from '../core/math';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../core/types';
import {
  ARENA, BOSS_ATTACKS, CAELITH, CAELITH_ACTIONS, CAELITH_GEOMETRY, SHARD_CRYSTAL, STARSHELL,
  type CaelithAttack, type CaelithAttackId,
} from '../data/boss';
import type { HitEvent } from '../data/combatTypes';
import { ELEMENT_IDS, type ElementId, type EntityId, type ReactionId } from '../data/ids';
import { SANCTUM } from '../data/sanctum';
import { ReactionSystem } from '../element/reactionSystem';
import {
  bossPhaseDef, nextStarshellElement, PHASE_THRESHOLDS, phaseFloorHp, phaseStartHp, starshellMax, stepStarshell,
  type BossPhase,
} from '../logic/boss';
import { SHIELD_REACTION_MUL, VULNERABLE_MUL } from '../logic/damage';
import { applyElement, emptyTarget, previewReaction, type ElementTarget } from '../logic/element';
import { HIT_FEEL } from '../logic/hitFeel';
import type { Collider, CollisionWorld } from '../physics/types';
import type { RuntimeState } from '../save/runtimeState';
import { BossBrain } from './bossBrain';
import type {
  BossRingSnapshot, BossState, BossTelegraph, BossTelegraphShape, CaelithSnapshot, CrystalSnapshot,
} from './bossSnapshot';

/** Entity id of Caelith in hits and events. */
export const CAELITH_ENTITY_ID = 'caelith';
/** Entity id of the Shard_Crystal of `element`. */
export const crystalEntityId = (element: ElementId): EntityId => `caelith_crystal_${element}`;

const TIME_EPS = 1e-9;
/** Hit_Stop when the Starshell breaks (Req 26.3: 50–90 ms of real time; logic/hitFeel). */
export const STARSHELL_BREAK_HIT_STOP = HIT_FEEL.starshellBreak.hitStop;
/** Knockback of a crystal pulse (m). */
const PULSE_KNOCKBACK = 2;
/** Crystal pulses reach this far above the floor. */
const LINE_REACH = 3;

/** Phase notches of the HUD bar: where Phase 2 and the Final Phase begin. */
const THRESHOLDS: readonly number[] = [PHASE_THRESHOLDS.p2, PHASE_THRESHOLDS.p3];

/** The arena the encounter plays on: its floor centre (top surface), radius and the crystal sockets. */
export interface EncounterArena {
  readonly center: Readonly<Vec3>;
  readonly radius: number;
  /** Where each Element's crystal stands (pedestal top). */
  readonly sockets: readonly { readonly element: ElementId; readonly pos: Readonly<Vec3> }[];
}

/** The Sanctum's arena: SANCTUM.arena with its pedestals' tops as sockets. */
export const SANCTUM_ENCOUNTER_ARENA: EncounterArena = {
  center: SANCTUM.arena.center,
  radius: SANCTUM.arena.radius,
  sockets: SANCTUM.arena.pedestals.map((p) => ({ element: p.element, pos: { x: p.pos.x, y: p.pos.y + p.height, z: p.pos.z } })),
};

export interface BossEncounterOptions {
  bus: GameEventBus;
  /** The `boss` RNG stream: the draws, the waits, the Starshell Elements and the attack placements. */
  rng: Rng;
  world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic'>;
  /** Id of Caelith's body collider. */
  colliderId: number;
  /** Default SANCTUM_ENCOUNTER_ARENA. */
  arena?: EncounterArena;
  runtime: Pick<RuntimeState, 'boss'> & Partial<Pick<RuntimeState, 'zones'>>;
  /** GameState writes: the highest Phase reached and the defeat. */
  record: { reachedPhase(phase: BossPhase): void; defeated(): void };
  /** begin(): every party character back to full HP (Party_System restoreAll). */
  healParty?: () => void;
  /** GameState.codex: Reactions on Caelith are recorded like any other. */
  codex?: ReactionId[];
  /** GameLoop.setTimeScale: the Starshell break's and steamBurst's Hit_Stop; omitted headless. */
  setTimeScale?: SetTimeScale;
}

export interface BossTick {
  dt: number;
  /** The Active_Character. */
  target: HitReceiver;
  /** Nothing moves or attacks this tick (cinematic, recovery fade). */
  frozen: boolean;
}

type HazardEffect = 'strike' | 'shards' | 'ring';

/** A placed judgement with its Telegraph (absolute clock times). */
interface Hazard {
  readonly id: number;
  readonly attack: CaelithAttack | 'crystalPulse';
  /** Judgement index in BOSS_ATTACKS[attack].dmgMul. */
  readonly index: number;
  readonly shape: BossTelegraphShape;
  readonly center: Vec3;
  readonly yaw: number;
  readonly radius: number;
  readonly angleDeg: number;
  readonly length: number;
  readonly width: number;
  readonly sector: number;
  readonly shownAt: number;
  readonly at: number;
  readonly strong: boolean;
  readonly effect: HazardEffect;
  readonly dmgMul: number;
  readonly knockback: number;
  /** Hazards of one volley share it: a target is hit at most once per volley. */
  readonly volley: Set<EntityId>;
}

interface Shard {
  pos: Vec3;
  readonly dir: Vec3;
  travelled: number;
  evaded: boolean;
}

interface Ring {
  readonly center: Vec3;
  radius: number;
  readonly reach: number;
  hit: boolean;
}

interface Action {
  readonly attack: CaelithAttack;
  readonly combo: boolean;
  /** Seconds since the action started. */
  t: number;
  readonly firstAt: number;
  /** Dash: where the rush starts and ends. */
  readonly from: Vec3;
  readonly to: Vec3;
  summoned: boolean;
}

interface Crystal {
  readonly element: ElementId;
  readonly pos: Vec3;
  hp: number;
  alive: boolean;
  pulseReadyAt: number;
  readonly receiver: HitReceiver;
}

interface Shell {
  element: ElementId;
  durability: number;
  readonly max: number;
  nextRotateAt: number;
}

/** A dummy HitEvent carrying the multiplier and push of one boss judgement into resolveHit. */
const bossHitEvent = (dmgMul: number, knockback: number): HitEvent => ({
  t: 0, shape: { kind: 'groundCircle', radius: 0, delay: 0 }, dmgMul, appliesElement: false, poise: 0, knockback, energy: null,
});

const flatDist = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Horizontal unit vector from `from` toward `to`; `yaw`'s direction when they coincide. */
function towards(from: Readonly<Vec3>, to: Readonly<Vec3>, yaw: number): Vec3 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { x: dx / d, y: 0, z: dz / d } : dirFromYaw(yaw);
}

/** Compass bearing (deg, 0 north / −z, clockwise) of an arena sector's centre, as a yaw. */
const sectorYaw = (index: number): number => {
  const r = index * (360 / ARENA.sectors) * DEG2RAD;
  return yawFromDir(Math.sin(r), -Math.cos(r));
};

export class BossEncounter {
  private readonly o: BossEncounterOptions;
  private readonly arena: EncounterArena;
  private readonly floorY: number;
  private readonly home: Vec3;
  private readonly brain: BossBrain;
  private readonly reactions: ReactionSystem;
  private readonly receiverImpl: HitReceiver;
  private readonly crystalList: Crystal[];
  private current: BossState = 'dormant';
  private phaseNow: BossPhase = 1;
  private hpNow: number = CAELITH.maxHp;
  private posNow: Vec3;
  private prevPosNow: Vec3;
  private yawNow: number;
  private prevYawNow: number;
  /** Encounter clock (s): advances while the fight runs (not frozen, not halted). */
  private clock = 0;
  private stateTime = 0;
  /** Length of the current stagger / disabled / transition / recovery. */
  private stateLength = 0;
  private decideAt = 0;
  private action: Action | null = null;
  private pendingPhase: BossPhase | null = null;
  private pendingDisabled = false;
  private readonly hazards: Hazard[] = [];
  private readonly shards: Shard[] = [];
  private ring: Ring | null = null;
  private shell: Shell | null = null;
  /** Seconds left on the rotation clock while a vulnerable window suppresses the Starshell, else null. */
  private suppressedFor: number | null = null;
  /** The last Starshell's Element: the next one (regrown or the Final Phase's) differs from it. */
  private lastShellElement: ElementId | null = null;
  private lastStrongEnd = Number.NEGATIVE_INFINITY;
  /** Element_Marks and Reaction rate limits on Caelith (the Starshell is added as its shield when it stands). */
  private marks: ElementTarget = emptyTarget();
  private serial = 0;
  private haltedNow = false;
  private breaks = 0;
  private solid = false;
  private target: HitReceiver | null = null;

  constructor(options: BossEncounterOptions) {
    this.o = options;
    this.arena = options.arena ?? SANCTUM_ENCOUNTER_ARENA;
    const a = this.arena.center;
    this.floorY = a.y;
    this.home = { x: a.x, y: a.y + CAELITH.hover, z: a.z + 6 };
    this.posNow = copyV3(this.home);
    this.prevPosNow = copyV3(this.home);
    this.yawNow = yawFromDir(0, -1); // facing the entrance
    this.prevYawNow = this.yawNow;
    this.brain = new BossBrain(options.rng);
    this.reactions = new ReactionSystem({
      bus: options.bus,
      now: () => this.clock,
      codex: options.codex,
      setTimeScale: options.setTimeScale,
      zones: options.runtime.zones,
      host: {
        actors: () => [{ id: CAELITH_ENTITY_ID, pos: this.posNow, alive: this.takesDamage(), def: CAELITH.def, element: this.elementTarget() }],
        setElement: (_id, next) => {
          this.marks = { mark: next.mark, shield: null, lastReactionAt: { ...next.lastReactionAt } };
        },
        damage: (_id, amount, element) => this.reactionDamage(amount, element),
        // Caelith is not staggered, rooted or slowed by Reactions (its own windows are the design's).
        stagger: () => {},
        root: () => {},
        slow: () => {},
      },
    });
    this.receiverImpl = {
      id: CAELITH_ENTITY_ID,
      hurtVolume: () => ({ pos: this.posNow, radius: CAELITH.radius, height: CAELITH.height }),
      immune: () => !this.takesDamage(),
      sample: () => ({
        def: CAELITH.def,
        frontGuard: false,
        shieldElement: this.activeShell()?.element ?? null,
        vulnerable: this.vulnerable && this.activeShell() === null,
        terraMarked: this.marks.mark !== null && this.marks.mark.element === 'terra' && this.clock < this.marks.mark.expiresAt,
      }),
      receive: (hit) => this.receiveHit(hit),
    };
    this.crystalList = this.arena.sockets.map((s) => this.makeCrystal(s.element, s.pos));
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  get state(): BossState {
    return this.current;
  }

  get phase(): BossPhase {
    return this.phaseNow;
  }

  get hp(): number {
    return this.hpNow;
  }

  /** Encounter clock (s). */
  get time(): number {
    return this.clock;
  }

  /** Fighting (not dormant, not in the intro, not dead). */
  get active(): boolean {
    return this.current !== 'dormant' && this.current !== 'intro' && this.current !== 'dead';
  }

  /** The encounter is on: the intro or the fight. */
  get engaged(): boolean {
    return this.current !== 'dormant' && this.current !== 'dead';
  }

  /** Stopped by a Party_Wipe until begin() / sleep(). */
  get halted(): boolean {
    return this.haltedNow;
  }

  /** Damage taken ×1.5 now: a vulnerable `stagger` window or `disabled` (Req 6.2, 6.5, 6.8). */
  get vulnerable(): boolean {
    return !this.haltedNow && (this.current === 'stagger' || this.current === 'disabled');
  }

  /** Caelith as a target of the party's hits. */
  receiver(): HitReceiver {
    return this.receiverImpl;
  }

  /** The standing Shard_Crystals as targets of the party's hits. */
  *crystalReceivers(): Iterable<HitReceiver> {
    for (const c of this.crystalList) if (c.alive) yield c.receiver;
  }

  /** Design interface: a party hit on Caelith (ignored while it takes no damage). */
  applyHit(hit: ResolvedHit): void {
    if (!this.receiverImpl.immune()) this.receiverImpl.receive(hit);
  }

  /** Previous and current pose for render interpolation. */
  pose(): { prev: Readonly<Vec3>; pos: Readonly<Vec3>; prevYaw: number; yaw: number } {
    return { prev: this.prevPosNow, pos: this.posNow, prevYaw: this.prevYawNow, yaw: this.yawNow };
  }

  /** Telegraphs showing now (Caelith's attacks and the crystal pulses). */
  telegraphs(): BossTelegraph[] {
    const out: BossTelegraph[] = [];
    for (const h of this.hazards) {
      if (this.clock < h.shownAt - TIME_EPS || this.clock >= h.at - TIME_EPS) continue;
      out.push({
        id: h.id,
        attack: h.attack === 'crystalPulse' ? 'shardCrystal_pulse' : BOSS_ATTACKS[h.attack].id,
        shape: h.shape, center: h.center, yaw: h.yaw, radius: h.radius, angleDeg: h.angleDeg, length: h.length,
        width: h.width, sector: h.sector,
        remaining: Math.max(0, h.at - this.clock),
        duration: h.at - h.shownAt,
        strong: h.strong,
      });
    }
    return out;
  }

  snapshot(): CaelithSnapshot {
    const a = this.action;
    const shell = this.activeShell();
    const telegraphs = this.telegraphs();
    let telegraphRemaining = 0;
    for (const t of telegraphs) {
      if (t.attack === 'shardCrystal_pulse') continue;
      telegraphRemaining = telegraphRemaining === 0 ? t.remaining : Math.min(telegraphRemaining, t.remaining);
    }
    const ring: BossRingSnapshot | null = this.ring === null ? null : {
      center: this.ring.center, radius: this.ring.radius, thickness: CAELITH_GEOMETRY.astral.thickness, height: CAELITH_GEOMETRY.astral.height,
    };
    const timed = this.current === 'stagger' || this.current === 'disabled' || this.current === 'transition' || this.current === 'recovery';
    return {
      name: CAELITH.name,
      state: this.current,
      phase: this.phaseNow,
      hp: this.hpNow,
      maxHp: CAELITH.maxHp,
      thresholds: THRESHOLDS,
      attack: a === null ? null : BOSS_ATTACKS[a.attack].id,
      telegraphRemaining,
      starshell: shell === null ? null : { element: shell.element, durability: shell.durability, max: shell.max },
      vulnerable: this.vulnerable,
      crystals: this.crystalList.filter((c) => c.alive).map((c) => this.crystalSnapshot(c)),
      pos: this.posNow,
      yaw: this.yawNow,
      attackTime: a?.t ?? 0,
      stateTime: this.stateTime,
      stateRemaining: timed ? Math.max(0, this.stateLength - this.stateTime) : 0,
      telegraphs,
      ring,
      shards: this.shards.map((s) => s.pos),
      music: bossPhaseDef(this.phaseNow).music,
      skyPreset: this.phaseNow === 3 ? 'starNight' : 'dusk',
      starshellSuppressed: this.shell !== null && this.suppressedFor !== null,
      starshellBreaks: this.breaks,
      halted: this.haltedNow,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * The arena's first entry: Caelith stands at its home facing the entrance, immune and still, while the intro
   * cinematic plays; `begin()` starts the fight. Only from dormant.
   */
  intro(fromPhase: BossPhase): void {
    if (this.current !== 'dormant') return;
    this.reset(fromPhase);
    this.setState('intro');
    this.setSolid(true);
  }

  /**
   * Starts (or restarts) the fight at `fromPhase`'s checkpoint (Req 6.13): HP at the Phase start (100 / 65 / 30 %),
   * the whole party healed, Caelith home, cooldowns and forced-event counters cleared, the Phase's Starshell fresh
   * (Phase 2+), no crystals (the first action summons them), the first action after CAELITH.openingWait. The intro
   * is not replayed.
   */
  begin(fromPhase: BossPhase): void {
    this.reset(fromPhase);
    this.o.healParty?.();
    this.setState('idle');
    this.decideAt = this.clock + CAELITH.openingWait;
    this.setSolid(true);
    this.o.record.reachedPhase(fromPhase);
    this.mirror();
  }

  /** A Party_Wipe: the fight stops (hazards cleared) until the Defeat choice calls begin() or sleep(). */
  halt(): void {
    if (!this.active) return;
    this.clearHazards();
    this.action = null;
    this.haltedNow = true;
    this.setState('idle');
  }

  /** Back to dormant (the party left for the Waystone): the fight restarts from its Phase on the next entry. */
  sleep(): void {
    if (this.current === 'dead') return;
    this.clearHazards();
    this.action = null;
    this.pendingPhase = null;
    this.haltedNow = false;
    for (const c of this.crystalList) c.alive = false;
    this.setState('dormant');
    this.setSolid(false);
    this.o.runtime.boss = null;
  }

  tick(ctx: BossTick): void {
    const { dt } = ctx;
    this.prevPosNow = copyV3(this.posNow);
    this.prevYawNow = this.yawNow;
    this.target = ctx.target;
    if (!(Number.isFinite(dt) && dt > 0) || this.current === 'dormant') return;
    if (this.current === 'dead') {
      this.stateTime += dt;
      return;
    }
    if (ctx.frozen || this.haltedNow) return;
    this.stateTime += dt;
    if (this.current === 'intro') return; // waits for begin()
    this.clock += dt;
    this.reactions.tick();
    if (this.defeated()) return; // a lava rift finished it
    const target = ctx.target;
    this.moveShards(dt, target);
    this.moveRing(dt, target);
    this.resolveHazards(target);
    this.crystalPulses(target);
    this.stateTick(dt, target);
    this.rotateShell();
    if (this.solid) this.upsertBody();
    this.mirror();
  }

  // ── State machine ───────────────────────────────────────────────────────────

  private stateTick(dt: number, target: HitReceiver): void {
    switch (this.current) {
      case 'transition':
        if (this.stateTime >= this.stateLength - TIME_EPS) this.endTransition();
        break;
      case 'idle':
        this.idle(dt, target);
        break;
      case 'telegraph':
      case 'attack':
        this.actionTick(dt);
        break;
      case 'recovery':
        if (this.stateTime >= this.stateLength - TIME_EPS) this.toIdle();
        break;
      case 'stagger':
        if (this.stateTime >= this.stateLength - TIME_EPS) this.endStagger();
        break;
      case 'disabled':
        if (this.stateTime >= this.stateLength - TIME_EPS) this.endDisabled();
        break;
      default:
        break;
    }
  }

  /** Waits out the interval facing the target, then asks the brain; with no candidate it adjusts its distance. */
  private idle(dt: number, target: HitReceiver): void {
    const t = target.hurtVolume().pos;
    const d = flatDist(t, this.posNow);
    this.turnToward(t, dt);
    // The wait, and never a new Telegraph within 1.0 s of a strong attack's end (a crystal pulse's too).
    if (this.clock < Math.max(this.decideAt, this.lastStrongEnd + CAELITH.strongGap) - TIME_EPS) return;
    const decision = this.brain.decide({ phase: this.phaseNow, distance: d, now: this.clock, crystalsAlive: this.crystalsAlive() });
    if (decision !== null) {
      this.startAction(decision.attack, decision.combo, target);
      return;
    }
    // Too close for starShards / dash and slashCombo spent, or between 6 and 8 m: close in to slash range, else back off.
    const step = CAELITH.moveSpeed * dt;
    if (d > CAELITH.slashRange) this.moveToward(t, Math.min(step, d - (CAELITH.slashRange - 1.5)));
    else this.moveAway(t, step);
  }

  private startAction(attack: CaelithAttack, combo: boolean, target: HitReceiver): void {
    const t = target.hurtVolume().pos;
    // The facing is fixed as the Telegraph shows (it never moves afterwards).
    if (attack !== 'summonCrystals' && flatDist(t, this.posNow) > 1e-6) this.yawNow = yawFromDir(t.x - this.posNow.x, t.z - this.posNow.z);
    const def = CAELITH_ACTIONS[attack];
    const firstAt = def.judgements[0]?.at ?? 0;
    const from = this.floorPoint(this.posNow);
    let to = from;
    if (attack === 'dash') to = this.clampInside(from, dirFromYaw(this.yawNow), CAELITH_GEOMETRY.dash.length);
    this.action = { attack, combo, t: 0, firstAt, from, to, summoned: false };
    this.placeHazards(attack, t, from, to);
    this.setState('telegraph');
  }

  /** The action's own timeline: telegraph → attack at its first judgement; the dash rush, the leap, the summon. */
  private actionTick(dt: number): void {
    const a = this.action;
    if (a === null) {
      this.toIdle();
      return;
    }
    a.t += dt;
    const def = CAELITH_ACTIONS[a.attack];
    if (this.current === 'telegraph' && a.t >= a.firstAt - TIME_EPS) this.setState('attack');
    if (a.attack === 'dash') {
      const start = def.judgements[0]?.at ?? 0;
      const k = Math.max(0, Math.min(1, (a.t - start) / CAELITH_GEOMETRY.dash.rushSeconds));
      if (a.t >= start - TIME_EPS) {
        this.posNow = { x: a.from.x + (a.to.x - a.from.x) * k, y: this.floorY + CAELITH.hover, z: a.from.z + (a.to.z - a.from.z) * k };
      }
    }
    if (a.attack === 'astralSweep') {
      const k = Math.max(0, Math.min(1, a.t / a.firstAt));
      this.posNow = { ...this.posNow, y: this.floorY + CAELITH.hover + CAELITH_GEOMETRY.astral.leapHeight * Math.sin(Math.PI * k) };
    }
    if (a.attack === 'summonCrystals' && !a.summoned && a.t >= a.firstAt - TIME_EPS) {
      a.summoned = true;
      this.summonCrystals();
    }
    const ringDone = a.attack !== 'astralSweep' || (a.t >= a.firstAt - TIME_EPS && this.ring === null);
    if (a.t >= def.activeEnd - TIME_EPS && ringDone && !this.hazards.some((h) => h.attack === a.attack)) this.endActive(a);
  }

  /** The active part is over: a pending transition or Starshell break first, then the combo, recovery or window. */
  private endActive(a: Action): void {
    const strength = BOSS_ATTACKS[a.attack].strength;
    if (strength === 'strong') this.lastStrongEnd = this.clock;
    this.action = null;
    this.posNow = { ...this.posNow, y: this.floorY + CAELITH.hover };
    if (this.pendingPhase !== null) {
      this.startTransition();
      return;
    }
    if (this.pendingDisabled) {
      this.startDisabled();
      return;
    }
    if (a.combo && a.attack === 'slashCombo') {
      // Phase 1: groundSlam follows the combo at once (its own 1.0 s Telegraph), then the 3 s window.
      this.brain.started('groundSlam', this.clock);
      const target = this.target;
      if (target !== null) {
        this.startAction('groundSlam', true, target);
        return;
      }
    }
    if (a.combo && a.attack === 'groundSlam') {
      this.startStagger(CAELITH.comboStaggerSeconds);
      return;
    }
    if (a.attack === 'astralSweep') {
      this.startStagger(CAELITH.astralStaggerSeconds);
      return;
    }
    const recovery = CAELITH_ACTIONS[a.attack].recovery;
    if (recovery <= 0) {
      this.toIdle();
      return;
    }
    this.setState('recovery', recovery);
  }

  /** Idle until the next decision: the Phase wait (the 1.0 s floor after a strong attack is checked in idle()). */
  private toIdle(): void {
    this.setState('idle');
    this.decideAt = this.clock + this.brain.wait(this.phaseNow);
  }

  /** A vulnerable window (Req 6.2, 6.8): ×1.5 damage, the Starshell suppressed and its clock paused. */
  private startStagger(seconds: number): void {
    const shell = this.shell;
    if (shell !== null && this.suppressedFor === null) this.suppressedFor = Math.max(0, shell.nextRotateAt - this.clock);
    this.setState('stagger', seconds);
  }

  /** The window closes: the Starshell comes back with the Element and durability it had. */
  private endStagger(): void {
    this.unsuppress();
    this.toIdle();
  }

  private unsuppress(): void {
    const shell = this.shell;
    if (shell !== null && this.suppressedFor !== null) shell.nextRotateAt = this.clock + this.suppressedFor;
    this.suppressedFor = null;
  }

  /** The Starshell broke: 6 s `disabled` at ×1.5 (Req 6.5). */
  private startDisabled(): void {
    this.pendingDisabled = false;
    this.action = null;
    this.setState('disabled', STARSHELL.disabledSeconds);
  }

  /** It regrows with a new Element at full durability; the 12 s clock restarts. */
  private endDisabled(): void {
    this.raiseShell(this.lastShellElement);
    this.toIdle();
  }

  /** A fresh Starshell of the current Phase (none in Phase 1): an Element other than `previous`, full durability. */
  private raiseShell(previous: ElementId | null): void {
    const max = starshellMax(this.phaseNow);
    if (!(max > 0)) {
      this.shell = null;
      return;
    }
    const element = previous === null ? this.o.rng.pick(ELEMENT_IDS) : nextStarshellElement(previous, this.o.rng);
    this.shell = { element, durability: max, max, nextRotateAt: this.clock + STARSHELL.rotateSeconds };
    this.lastShellElement = element;
    this.suppressedFor = null;
  }

  /** The Starshell standing now: present and not suppressed by a vulnerable window. */
  private activeShell(): Shell | null {
    return this.suppressedFor === null ? this.shell : null;
  }

  private rotateShell(): void {
    const shell = this.activeShell();
    if (shell === null || this.current === 'transition') return;
    const next = stepStarshell({ element: shell.element, nextRotateAt: shell.nextRotateAt }, this.clock, this.o.rng);
    shell.element = next.element;
    shell.nextRotateAt = next.nextRotateAt;
    this.lastShellElement = next.element;
  }

  // ── Phases, defeat ──────────────────────────────────────────────────────────

  private startTransition(): void {
    const to = this.pendingPhase;
    this.pendingPhase = null;
    this.pendingDisabled = false;
    if (to === null || to <= this.phaseNow) {
      this.toIdle();
      return;
    }
    const from = this.phaseNow as 1 | 2;
    this.phaseNow = to;
    this.action = null;
    this.clearHazards();
    // A running window or `disabled` ends with the transition; the old Starshell goes (the new Phase raises its own).
    this.shell = null;
    this.suppressedFor = null;
    this.posNow = { ...this.posNow, y: this.floorY + CAELITH.hover };
    this.setState('transition', CAELITH.transitionSeconds);
    this.o.bus.emit('boss:phaseChanged', { bossId: 'caelith', from, to: to as 2 | 3 });
    this.o.record.reachedPhase(to);
  }

  /** The new Phase's pool, interval and Starshell apply. */
  private endTransition(): void {
    this.raiseShell(this.lastShellElement);
    // Phase 2 opens with summonCrystals; the Final Phase keeps the standing crystals (re-summoned below 2).
    this.brain.reset(this.phaseNow, this.clock, this.phaseNow === 2);
    for (const c of this.crystalList) c.pulseReadyAt = this.clock;
    this.toIdle();
  }

  private die(): void {
    this.hpNow = 0;
    this.action = null;
    this.pendingPhase = null;
    this.pendingDisabled = false;
    this.clearHazards();
    for (const c of this.crystalList) c.alive = false;
    this.shell = null;
    this.suppressedFor = null;
    this.posNow = { ...this.posNow, y: this.floorY + CAELITH.hover };
    this.setState('dead');
    this.setSolid(false);
    this.o.bus.emit('boss:defeated', { bossId: 'caelith' });
    this.o.record.defeated();
    this.mirror();
  }

  /** `fromPhase`'s checkpoint: its start HP, Caelith home facing the entrance, nothing placed. */
  private reset(fromPhase: BossPhase): void {
    this.phaseNow = fromPhase;
    this.hpNow = phaseStartHp(CAELITH.maxHp, fromPhase);
    this.posNow = copyV3(this.home);
    this.prevPosNow = copyV3(this.home);
    this.yawNow = yawFromDir(0, -1);
    this.prevYawNow = this.yawNow;
    this.action = null;
    this.pendingPhase = null;
    this.pendingDisabled = false;
    this.haltedNow = false;
    this.clearHazards();
    for (const c of this.crystalList) {
      c.alive = false;
      c.hp = SHARD_CRYSTAL.hp;
    }
    this.marks = emptyTarget();
    this.lastStrongEnd = Number.NEGATIVE_INFINITY;
    this.shell = null;
    this.suppressedFor = null;
    this.lastShellElement = null;
    this.raiseShell(null);
    // The crystals were removed: Phase 2+ summons them as its first action.
    this.brain.reset(fromPhase, this.clock, fromPhase >= 2);
  }

  /** Every hazard, shard, ring and lava rift of the fight goes (a favourable transition, the defeat, a wipe). */
  private clearHazards(): void {
    this.hazards.length = 0;
    this.shards.length = 0;
    this.ring = null;
    this.reactions.clear();
  }

  private takesDamage(): boolean {
    if (this.haltedNow) return false;
    switch (this.current) {
      case 'idle': case 'telegraph': case 'attack': case 'recovery': case 'stagger': case 'disabled':
        return true;
      default:
        return false;
    }
  }

  /** Dead now (a method, so checks after calls that may kill it are not narrowed away). */
  private defeated(): boolean {
    return this.current === 'dead';
  }

  private inAttack(): boolean {
    return this.current === 'telegraph' || this.current === 'attack';
  }

  // ── Damage taken ────────────────────────────────────────────────────────────

  /** A party hit: into the Starshell while it stands, else HP; then its Element through the Element_System. */
  private receiveHit(hit: ResolvedHit): void {
    if (!this.takesDamage()) return;
    if (hit.amount > 0) this.damage(hit.amount);
    if (hit.element !== null && this.takesDamage()) {
      this.reactions.apply(CAELITH_ENTITY_ID, hit.element, hit.elementSource ?? 'enemy', { damage: hit.amount, reactor: hit.attackerStats ?? null });
    }
  }

  /** Reaction damage: ×3 into the Starshell (Req 6.4), else HP (×1.5 while vulnerable), with its damage number. */
  private reactionDamage(amount: number, element: ElementId | null): void {
    if (!(amount > 0) || !this.takesDamage()) return;
    const shell = this.activeShell();
    const dealt = shell !== null ? amount * SHIELD_REACTION_MUL : this.vulnerable ? amount * VULNERABLE_MUL : amount;
    this.damage(dealt);
    this.o.bus.emit('damage:dealt', {
      targetId: CAELITH_ENTITY_ID, amount: Math.round(dealt), crit: false, element,
      position: { x: this.posNow.x, y: this.posNow.y + CAELITH.height, z: this.posNow.z },
    });
  }

  /** Final damage (multipliers applied): the Starshell takes it all while it stands, else HP with the Phase floor. */
  private damage(amount: number): void {
    const shell = this.activeShell();
    if (shell !== null) {
      shell.durability = Math.max(0, shell.durability - amount);
      if (shell.durability <= 0) this.breakShell();
      return;
    }
    this.damageHp(amount);
  }

  private breakShell(): void {
    this.shell = null;
    this.suppressedFor = null;
    this.breaks++;
    this.o.setTimeScale?.('hitStop', 0, STARSHELL_BREAK_HIT_STOP);
    // A shown attack plays out first (Req 6.9), then `disabled`.
    if (this.inAttack()) this.pendingDisabled = true;
    else this.startDisabled();
  }

  /** HP stops at the Phase floor until its transition ends (Req 6.1); 0 in the Final Phase defeats Caelith. */
  private damageHp(amount: number): void {
    if (this.phaseNow === 3) {
      this.hpNow = Math.max(0, this.hpNow - amount);
      if (this.hpNow <= 0) this.die();
      else this.mirror();
      return;
    }
    const floor = phaseFloorHp(CAELITH.maxHp, this.phaseNow);
    this.hpNow = Math.max(floor, this.hpNow - amount);
    if (this.hpNow <= floor && this.pendingPhase === null) {
      this.pendingPhase = (this.phaseNow + 1) as BossPhase;
      if (!this.inAttack()) this.startTransition();
    }
    this.mirror();
  }

  /** Caelith's Element state with the standing Starshell as its permanent shield mark. */
  private elementTarget(): ElementTarget {
    const shell = this.activeShell();
    return {
      mark: this.marks.mark,
      shield: shell === null ? null : { element: shell.element, durability: shell.durability, max: shell.max },
      lastReactionAt: this.marks.lastReactionAt,
    };
  }

  // ── Shard_Crystals ──────────────────────────────────────────────────────────

  private makeCrystal(element: ElementId, pos: Readonly<Vec3>): Crystal {
    const crystal: Crystal = {
      element, pos: copyV3(pos), hp: SHARD_CRYSTAL.hp, alive: false, pulseReadyAt: 0,
      receiver: {
        id: crystalEntityId(element),
        hurtVolume: (): HurtVolume => ({ pos: crystal.pos, radius: SHARD_CRYSTAL.radius, height: SHARD_CRYSTAL.height }),
        immune: () => !crystal.alive || !this.takesDamage(),
        sample: () => ({ def: SHARD_CRYSTAL.def, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
        receive: (hit) => this.crystalHit(crystal, hit),
      },
    };
    return crystal;
  }

  private crystalsAlive(): number {
    return this.crystalList.filter((c) => c.alive).length;
  }

  /** Fills the empty sockets only: each Element at most once (design Shard_Crystal). */
  private summonCrystals(): void {
    for (const c of this.crystalList) {
      if (c.alive) continue;
      c.alive = true;
      c.hp = SHARD_CRYSTAL.hp;
      c.pulseReadyAt = this.clock;
    }
  }

  private crystalHit(c: Crystal, hit: ResolvedHit): void {
    if (!c.alive || !this.takesDamage() || !(hit.amount > 0)) return;
    c.hp = Math.max(0, c.hp - hit.amount);
    if (c.hp > 0) return;
    c.alive = false;
    if (flatDist(c.pos, this.posNow) <= SHARD_CRYSTAL.markRadius) this.markFromCrystal(c.element, hit);
  }

  /**
   * A crystal broke with Caelith within 6 m (Req 6.6): the burst (×3 into a reacting Starshell, ×0.25 into a matching
   * one, else HP) and its Element through the Element_System with the breaker as the reactor.
   */
  private markFromCrystal(element: ElementId, hit: ResolvedHit): void {
    const outcome = applyElement(this.elementTarget(), element, this.clock);
    const burst = SHARD_CRYSTAL.breakDamage;
    const dealt = outcome.kind === 'shieldHit' ? burst * outcome.shieldMul : this.vulnerable && this.activeShell() === null ? burst * VULNERABLE_MUL : burst;
    this.damage(dealt);
    this.o.bus.emit('damage:dealt', {
      targetId: CAELITH_ENTITY_ID, amount: Math.round(dealt), crit: false, element,
      position: { x: this.posNow.x, y: this.posNow.y + CAELITH.height, z: this.posNow.z },
    });
    if (this.takesDamage()) this.reactions.apply(CAELITH_ENTITY_ID, element, 'environment', { damage: 0, reactor: hit.attackerStats ?? null });
  }

  /** A crystal with a Party character within 3 m pulses (0.8 s Telegraph), at most every 6 s. */
  private crystalPulses(target: HitReceiver): void {
    if (!this.takesDamage() || this.clock < this.lastStrongEnd + CAELITH.strongGap - TIME_EPS) return;
    const feet = target.hurtVolume().pos;
    for (const c of this.crystalList) {
      if (!c.alive || this.clock < c.pulseReadyAt - TIME_EPS) continue;
      if (flatDist(feet, c.pos) > SHARD_CRYSTAL.triggerRadius || Math.abs(feet.y - this.floorY) > LINE_REACH) continue;
      c.pulseReadyAt = this.clock + SHARD_CRYSTAL.pulseEvery;
      this.addHazard({
        attack: 'crystalPulse', index: 0, shape: 'circle', center: this.floorPoint(c.pos), radius: SHARD_CRYSTAL.pulseRadius,
        shownAt: this.clock, at: this.clock + SHARD_CRYSTAL.pulseTelegraph, strong: true, dmgMul: SHARD_CRYSTAL.pulseDmgMul,
        knockback: PULSE_KNOCKBACK,
      });
    }
  }

  private crystalSnapshot(c: Crystal): CrystalSnapshot {
    const near = this.takesDamage() && flatDist(c.pos, this.posNow) <= SHARD_CRYSTAL.markRadius;
    return {
      element: c.element, hp: c.hp, maxHp: SHARD_CRYSTAL.hp, pos: c.pos,
      reaction: this.takesDamage() ? previewReaction(this.elementTarget(), c.element, this.clock) : null,
      caelithNear: near,
    };
  }

  // ── Hazards ─────────────────────────────────────────────────────────────────

  private addHazard(h: {
    attack: Hazard['attack']; index: number; shape: BossTelegraphShape; center: Vec3; yaw?: number; radius?: number; angleDeg?: number;
    length?: number; width?: number; sector?: number; shownAt: number; at: number; strong: boolean; effect?: HazardEffect;
    dmgMul: number; knockback: number; volley?: Set<EntityId>;
  }): void {
    this.serial += 1;
    this.hazards.push({
      id: this.serial, attack: h.attack, index: h.index, shape: h.shape, center: h.center, yaw: h.yaw ?? 0, radius: h.radius ?? 0,
      angleDeg: h.angleDeg ?? 0, length: h.length ?? 0, width: h.width ?? 0, sector: h.sector ?? -1, shownAt: h.shownAt, at: h.at,
      strong: h.strong, effect: h.effect ?? 'strike', dmgMul: h.dmgMul, knockback: h.knockback, volley: h.volley ?? new Set(),
    });
  }

  /** The action's judgements with their fixed areas (design 공격 정의). */
  private placeHazards(attack: CaelithAttack, targetFeet: Readonly<Vec3>, from: Vec3, to: Vec3): void {
    const def = CAELITH_ACTIONS[attack];
    const table = BOSS_ATTACKS[attack];
    const strong = table.strength === 'strong';
    const now = this.clock;
    const g = CAELITH_GEOMETRY;
    const common = (i: number): { attack: CaelithAttack; index: number; shownAt: number; at: number; strong: boolean; dmgMul: number; knockback: number } => {
      const j = def.judgements[i] ?? { shownAt: 0, at: 0 };
      return { attack, index: i, shownAt: now + j.shownAt, at: now + j.at, strong, dmgMul: table.dmgMul[i] ?? 0, knockback: def.knockback };
    };
    switch (attack) {
      case 'slashCombo':
        for (let i = 0; i < def.judgements.length; i++) {
          this.addHazard({ ...common(i), shape: 'sector', center: from, yaw: this.yawNow, radius: g.slash.radius, angleDeg: g.slash.angleDeg });
        }
        break;
      case 'starShards': {
        const volley = new Set<EntityId>();
        for (let k = 0; k < g.shards.count; k++) {
          const yaw = wrapAngle(this.yawNow + (k - (g.shards.count - 1) / 2) * g.shards.spreadDeg * DEG2RAD);
          this.addHazard({ ...common(0), shape: 'aim', center: from, yaw, length: g.shards.maxRange * 0.65, width: g.shards.aimWidth, effect: 'shards', volley });
        }
        break;
      }
      case 'groundSlam':
        this.addHazard({ ...common(0), shape: 'circle', center: from, radius: g.slam.radius });
        break;
      case 'dash':
        this.addHazard({ ...common(0), shape: 'line', center: from, yaw: this.yawNow, length: flatDist(from, to), width: g.dash.width });
        break;
      case 'sectorBlast': {
        const sectors = this.pickSectors(targetFeet);
        sectors.forEach((sector, i) => {
          this.addHazard({ ...common(i), shape: 'arenaSector', center: this.floorPoint(this.arena.center), yaw: sectorYaw(sector), radius: this.arena.radius, angleDeg: 360 / ARENA.sectors, sector });
        });
        break;
      }
      case 'starfall': {
        const volley = new Set<EntityId>();
        for (const p of this.starfallPoints(targetFeet)) this.addHazard({ ...common(0), shape: 'circle', center: p, radius: g.starfall.radius, volley });
        break;
      }
      case 'astralSweep':
        this.addHazard({ ...common(0), shape: 'ring', center: from, radius: 0, effect: 'ring' });
        break;
      case 'summonCrystals':
        break; // no damage: the crystals appear at the summon's end (actionTick)
    }
  }

  /** 4 of the 8 sectors: the one under the Active_Character first (when on the arena), the others drawn. */
  private pickSectors(feet: Readonly<Vec3>): number[] {
    const all = Array.from({ length: ARENA.sectors }, (_, i) => i);
    const out: number[] = [];
    const under = this.sectorOf(feet);
    if (under !== null) out.push(under);
    while (out.length < CAELITH_GEOMETRY.sectorBlast.zones) {
      const left = all.filter((s) => !out.includes(s));
      out.push(this.o.rng.pick(left));
    }
    return out;
  }

  /** Starfall's five circles: on the Active_Character and four around it, all inside the arena. */
  private starfallPoints(feet: Readonly<Vec3>): Vec3[] {
    const g = CAELITH_GEOMETRY.starfall;
    const limit = this.arena.radius - g.radius;
    const points: Vec3[] = [this.clampToArena(this.floorPoint(feet), limit)];
    for (let k = 1; k < g.count; k++) {
      const angle = this.o.rng.range(0, Math.PI * 2);
      const d = this.o.rng.range(g.spreadMin, g.spreadMax);
      points.push(this.clampToArena({ x: feet.x + Math.sin(angle) * d, y: this.floorY, z: feet.z + Math.cos(angle) * d }, limit));
    }
    return points;
  }

  /** Judges every hazard due now against the Active_Character; spent hazards leave the list. */
  private resolveHazards(target: HitReceiver): void {
    if (this.hazards.length === 0) return;
    const due = this.hazards.filter((h) => this.clock >= h.at - TIME_EPS);
    if (due.length === 0) return;
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (h !== undefined && this.clock >= h.at - TIME_EPS) this.hazards.splice(i, 1);
    }
    for (const h of due) {
      if (h.effect === 'shards') this.fireShard(h);
      else if (h.effect === 'ring') this.launchRing(h);
      else this.strike(h, target);
      if (h.attack === 'crystalPulse') this.lastStrongEnd = Math.max(this.lastStrongEnd, this.clock); // a strong attack
    }
  }

  private strike(h: Hazard, target: HitReceiver): void {
    if (h.volley.has(target.id)) return;
    const vol = target.hurtVolume();
    if (!this.overlaps(h, vol)) return;
    h.volley.add(target.id);
    this.land(target, h.attack, h.index, h.dmgMul, h.knockback, h.shape === 'sector' || h.shape === 'line' ? this.posNow : h.center, h.yaw);
  }

  /** Whether hazard `h` touches the hurt capsule `vol` now. */
  private overlaps(h: Hazard, vol: HurtVolume): boolean {
    const feet = vol.pos;
    const top = feet.y + Math.max(vol.height, 2 * vol.radius);
    const reach = CAELITH_GEOMETRY.groundReach;
    switch (h.shape) {
      case 'circle':
        return feet.y <= this.floorY + reach && top >= this.floorY - 0.5 && flatDist(feet, h.center) - vol.radius <= h.radius;
      case 'sector':
        return hitShapeOverlaps({ kind: 'arc', radius: h.radius, angleDeg: h.angleDeg, height: CAELITH_GEOMETRY.slash.height }, { pos: h.center, yaw: h.yaw }, vol);
      case 'line': {
        if (feet.y > this.floorY + LINE_REACH) return false;
        const f = dirFromYaw(h.yaw);
        const px = feet.x - h.center.x;
        const pz = feet.z - h.center.z;
        const along = Math.max(0, Math.min(h.length, px * f.x + pz * f.z));
        return Math.hypot(px - f.x * along, pz - f.z * along) <= h.width / 2 + vol.radius;
      }
      case 'arenaSector':
        return feet.y <= this.floorY + reach && this.sectorOf(feet) === h.sector;
      default:
        return false;
    }
  }

  /** One boss judgement landing on `target` (or passing its Dodge i-frames). */
  private land(target: HitReceiver, attack: Hazard['attack'], index: number, dmgMul: number, knockback: number, from: Readonly<Vec3>, yaw: number): void {
    if (target.immune()) {
      target.evade?.(CAELITH_ENTITY_ID);
      return;
    }
    const direction = towards(from, target.hurtVolume().pos, yaw);
    const attackId: CaelithAttackId | 'atk_caelith_crystalPulse' = attack === 'crystalPulse' ? 'atk_caelith_crystalPulse' : BOSS_ATTACKS[attack].id;
    const resolved = resolveHit(this.attacker(), attackId, index, bossHitEvent(dmgMul, knockback), target.sample(direction), 0, direction);
    target.receive(resolved);
  }

  private fireShard(h: Hazard): void {
    const dir = dirFromYaw(h.yaw);
    const g = CAELITH_GEOMETRY.shards;
    this.shards.push({
      pos: { x: this.posNow.x + dir.x * CAELITH.radius, y: this.floorY + g.launchHeight, z: this.posNow.z + dir.z * CAELITH.radius },
      dir, travelled: 0, evaded: false,
    });
  }

  /** Moves the shards; one hits the target where its path this tick passes through the capsule. */
  private moveShards(dt: number, target: HitReceiver): void {
    if (this.shards.length === 0) return;
    const g = CAELITH_GEOMETRY.shards;
    const vol = target.hurtVolume();
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      if (s === undefined) continue;
      const from = s.pos;
      const step = g.speed * dt;
      const to = { x: from.x + s.dir.x * step, y: from.y, z: from.z + s.dir.z * step };
      s.travelled += step;
      s.pos = to;
      if (segmentTouchesCapsule(from, to, g.radius, vol.pos, vol.radius, vol.height)) {
        if (target.immune()) {
          if (!s.evaded) target.evade?.(CAELITH_ENTITY_ID);
          s.evaded = true;
        } else {
          this.land(target, 'starShards', 0, BOSS_ATTACKS.starShards.dmgMul[0], CAELITH_ACTIONS.starShards.knockback, from, yawFromDir(s.dir.x, s.dir.z));
          this.shards.splice(i, 1);
          continue;
        }
      }
      if (s.travelled >= g.maxRange) this.shards.splice(i, 1);
    }
  }

  private launchRing(h: Hazard): void {
    const reach = flatDist(h.center, this.arena.center) + this.arena.radius + CAELITH_GEOMETRY.astral.thickness;
    this.ring = { center: h.center, radius: 0, reach, hit: false };
  }

  /**
   * The Astral Sweep ring grows at 14 m/s; the band it swept this tick hits a capsule whose feet are at most 0.8 m
   * above the floor, unless Dodge i-frames let it pass (Req 6.8). Once per sweep.
   */
  private moveRing(dt: number, target: HitReceiver): void {
    const ring = this.ring;
    if (ring === null) return;
    const g = CAELITH_GEOMETRY.astral;
    const before = ring.radius;
    ring.radius += g.speed * dt;
    if (!ring.hit) {
      const vol = target.hurtVolume();
      const d = flatDist(vol.pos, ring.center);
      const swept = d + vol.radius >= before - g.thickness && d - vol.radius <= ring.radius;
      const low = vol.pos.y - this.floorY <= g.height;
      if (swept && low) {
        ring.hit = true;
        this.land(target, 'astralSweep', 0, BOSS_ATTACKS.astralSweep.dmgMul[0], CAELITH_ACTIONS.astralSweep.knockback, ring.center, this.yawNow);
      }
    }
    if (ring.radius - g.thickness >= ring.reach) this.ring = null;
  }

  private attacker(): Attacker {
    return {
      id: CAELITH_ENTITY_ID,
      origin: { pos: this.posNow, yaw: this.yawNow },
      stats: { baseAtk: CAELITH.atk, level: CAELITH.damageLevel, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind: 'enemy',
      element: null,
      roll: () => 0,
    };
  }

  // ── Geometry, movement ──────────────────────────────────────────────────────

  private floorPoint(p: Readonly<Vec3>): Vec3 {
    return { x: p.x, y: this.floorY, z: p.z };
  }

  /** Arena floor sector (0–7, 0 north at the entrance, clockwise) under (x, z), or null off the disc. */
  private sectorOf(p: Readonly<Vec3>): number | null {
    const c = this.arena.center;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    if (!(Math.hypot(dx, dz) <= this.arena.radius)) return null;
    let deg = dx === 0 && dz === 0 ? 0 : (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const size = 360 / ARENA.sectors;
    return Math.floor(((deg + size / 2) % 360) / size);
  }

  private clampToArena(p: Vec3, limit: number): Vec3 {
    const c = this.arena.center;
    const r = Math.hypot(p.x - c.x, p.z - c.z);
    if (r <= limit) return p;
    return { x: c.x + ((p.x - c.x) / r) * limit, y: p.y, z: c.z + ((p.z - c.z) / r) * limit };
  }

  /** The point `length` m from `from` along `dir`, shortened to stay CAELITH.arenaMargin inside the arena edge. */
  private clampInside(from: Vec3, dir: Readonly<Vec3>, length: number): Vec3 {
    const limit = this.arena.radius - CAELITH.arenaMargin;
    let len = length;
    for (let k = 0; k < 40 && len > 0; k++) {
      const p = { x: from.x + dir.x * len, y: from.y, z: from.z + dir.z * len };
      if (flatDist(p, this.arena.center) <= limit) return p;
      len -= length / 40;
    }
    return { ...from };
  }

  private turnToward(to: Readonly<Vec3>, dt: number): void {
    const dx = to.x - this.posNow.x;
    const dz = to.z - this.posNow.z;
    if (Math.hypot(dx, dz) < 1e-6) return;
    const delta = angleDelta(this.yawNow, yawFromDir(dx, dz));
    const max = CAELITH.turnRate * dt;
    this.yawNow = wrapAngle(this.yawNow + Math.max(-max, Math.min(max, delta)));
  }

  private moveToward(to: Readonly<Vec3>, step: number): void {
    const d = towards(this.posNow, to, this.yawNow);
    this.moveBy(d, step);
  }

  private moveAway(from: Readonly<Vec3>, step: number): void {
    const d = towards(from, this.posNow, this.yawNow);
    this.moveBy(d, step);
  }

  /** Moves `step` m along `dir`, staying CAELITH.arenaMargin inside the arena edge. */
  private moveBy(dir: Readonly<Vec3>, step: number): void {
    if (!(step > 0)) return;
    const p = { x: this.posNow.x + dir.x * step, y: this.posNow.y, z: this.posNow.z + dir.z * step };
    this.posNow = this.clampToArena(p, this.arena.radius - CAELITH.arenaMargin);
  }

  private setState(state: BossState, length = 0): void {
    this.current = state;
    this.stateTime = 0;
    this.stateLength = length;
  }

  private body(): Collider {
    return {
      kind: 'cylinder',
      id: this.o.colliderId,
      base: { x: this.posNow.x, y: this.floorY, z: this.posNow.z },
      radius: CAELITH.bodyRadius,
      height: CAELITH.height,
      flags: { climbable: false, walkableTop: false, blocksCamera: false, material: 'crystal' },
    };
  }

  private upsertBody(): void {
    this.o.world.upsertDynamic(this.body());
  }

  private setSolid(solid: boolean): void {
    if (solid) this.upsertBody();
    else if (this.solid) this.o.world.removeDynamic(this.o.colliderId);
    this.solid = solid;
  }

  private mirror(): void {
    this.o.runtime.boss = { id: 'caelith', phase: this.phaseNow, hp: this.hpNow, maxHp: CAELITH.maxHp, stateTime: this.stateTime };
  }
}

/**
 * Whether a sphere of `r` moving from `a` to `b` (horizontally) touches the vertical capsule with feet at `feet`:
 * the 2D distance from the capsule axis to the path is within the radii, and the shard's height is inside the
 * capsule's span widened by both radii.
 */
export function segmentTouchesCapsule(a: Readonly<Vec3>, b: Readonly<Vec3>, r: number, feet: Readonly<Vec3>, radius: number, height: number): boolean {
  const top = feet.y + Math.max(height, 2 * radius);
  if (a.y < feet.y - r || a.y > top + r) return false;
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((feet.x - a.x) * abx + (feet.z - a.z) * abz) / len2)) : 0;
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  return Math.hypot(feet.x - px, feet.z - pz) <= r + radius;
}

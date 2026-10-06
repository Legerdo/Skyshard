// Combat_System for the Active_Character's attacks (design "전투 액션 모델", "Energy·Cooldown·Dodge"; Req 24.1–24.7,
// 24.10–24.13, 20.3, 23.6, 38.6). Runs after the PlayerController each tick (design "Tick 갱신 순서"):
// - An `attack` press taken from the InputBuffer while standing starts Normal hit 1. Inside the current hit's
//   comboWindow, consume('attack') chains the next hit; a press outside the window stays buffered (0.15 s) and
//   chains if the window opens before it expires, otherwise the clip plays out and the next press is hit 1 again.
// - Releasing `attack` after holding it ≥ 0.4 s (heldTime on the released tick) cuts the playing hit and starts
//   the Charged_Attack (Req 24.3).
// - `skill` (E) casts the Skill when its cooldown is 0 (skillReady) and starts the kit's cooldown at the cast; the
//   Party_System counts every cooldown down in sim time (Req 24.4, 23.8). `burst` (Q) casts the Burst only with
//   full Energy (canBurst): Energy goes to 0, 'burst:cast' goes out and the Active_Character is invulnerable
//   during the kit's cut-in (≤ 1.0 s, before the first Burst hit, Req 24.6). Both need the character standing and
//   no Skill or Burst playing, and cut a playing Normal or Charged attack. A `skill` press during the cooldown or
//   a `burst` press without full Energy casts nothing and emits 'ability:refused' (HUD highlight and refusal
//   sound, Req 24.5).
// - Abilities whose params carry `interval` and `seconds` (Isla's arrow rain, Wren's storm eye) repeat each
//   HitEvent round(seconds / interval) times, `interval` s apart, as placed hits with the cast's snapshot; an
//   ability with `fallbackRange` (the arrow rain) is placed on the Lock-on target, else that far ahead of the
//   camera on the ground.
// - Facing at the start of each attack: melee attacks turn within 0.1 s toward the nearest living target within
//   5 m and 60° of the camera's forward (Req 24.12), else face the move input (camera relative) or keep the yaw.
//   Attacks that shoot (Isla) aim at the Lock-on target, else the nearest target in the 30° / 25 m cone, else the
//   camera ray's point (Req 24.13; src/combat/aim), and turn toward it the same way.
// - HitEvents at their clip time `t`: arc / sphere / capsule / line are judged at once against the targets (each
//   target at most once per HitEvent); a projectile is launched from the bow toward the aim (its current body
//   centre for a target) into the ProjectileSystem pool (swept sphere, Req 20.3, 38.6); a groundCircle is placed
//   and judged `delay` s later where it was placed. Projectiles and placed hits keep the owner snapshot and
//   outlive a cancelled attack or a switch (Req 23.6).
// - Hits resolve through computeDamage at the party level with base crit 5% rolled from the combat Rng stream;
//   HitEvents with appliesElement carry the character's Element, which the target applies with applyElement
//   (Req 24.2). Every hit emits 'damage:dealt'.
// - Energy (Req 24.7) goes to the Active_Character at the moment of the event, clamped to its Burst cost by
//   addEnergy: a HitEvent judgement (a projectile, a placed volley) that hits at least one target grants its
//   `energyOnHit` once (Normal 1, Charged 3, filled at data load); a Skill cast grants 6 once, on the first hit of
//   any of its judgements, and then emits 'skill:cast' with hitEnemy true — or with hitEnemy false once all its
//   judgements are made (or cancelled) without a hit; each 'reaction' grants 5 and each 'perfectDodge' 10 to the
//   character it names. Energy lives per character in RuntimeState and does not change on standby.
// - gateInput() wraps the controller's input: movement, sprint and jump are held back until recoveryFrom
//   (movement input after it ends the attack) and Dodge until dodgeCancelFrom (a Dodge then cancels it: the
//   controller leaves the standing mode, Req 24.11). Leaving the standing mode for any reason cancels the attack.
// - While the body climbs (climbAttach, climb, climbLeap, mantle) Normal_Attack, Skill and Burst input is ignored
//   (Req 18.11): no cast, no refusal, buffered attack presses are dropped and a hold that overlaps the climb
//   never charges. Swimming does the same: the weapon is on the back while swimming (design "애니메이션" full-body
//   override), so no attack or ability starts in the water and none is refused there.
// - While the body glides (glideDeploy, glide) only a Skill whose kit has a `glideRise` param (Wren's 소용돌이) can be
//   cast (Req 19.9): the cooldown starts and its hits play as usual, and the body rises `glideRise` m at once
//   (CombatBody.glideRise, stopped under a ceiling). The gliding cast keeps playing while the body glides.
// - A Skill or Burst reaching its first HitEvent reports the caster's feet, facing and params to `onAbilityHit`, where
//   the world places its side effects (Talus's stone pillar, src/world/talusPillars.ts).
// - Echo Altar tiers (task 12.3): a Skill / Burst cast plays the kit at the character's tier (logic/upgrades: params,
//   cooldown, grown hit shapes) and its hits carry the tiers' dmgPct as abilityUpgradePct.
// - Equipment (task 12.4, `equipment` option, read every tick): crit chance and Reaction damage bonuses in the hit
//   stats, the Emberfang wave after Normal hit 4, the Skyreaver launch pulling nearby enemies, Tidecaller puddles
//   under Charged arrow hits, and the Bulwark's longer pillar and stronger push.
// Not here yet: root motion (Kairen's dash moves only the hit capsule) and the other Skill / Burst side effects beyond
// their hits (pull, Talus's shield, stun, heal).

import { angleDelta, copyV3, dirFromYaw, wrapAngle, yawFromDir } from '../core/math';
import type { Rng } from '../core/rng';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { AttackDef, CharacterDef, HitEvent } from '../data/combatTypes';
import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type AttackId, type CharacterId, type EntityId } from '../data/ids';
import { CHARGE_SECONDS } from '../input/actions';
import type { InputState } from '../input/inputState';
import { BASE_CRIT_CHANCE } from '../logic/damage';
import { NO_MODIFIERS, type EquipModifiers } from '../logic/equipment';
import { upgradedAbility } from '../logic/upgrades';
import { hitFeelOfHit } from '../logic/hitFeel';
import type { SetTimeScale } from './perfectDodge';
import { addEnergy, canBurst, energyGain, skillReady, spendBurst } from '../logic/energy';
import type { CollisionQueries } from '../physics/types';
import { cameraRelativeMove } from '../player/controllerInput';
import { isClimbMode, isGlideMode, type ControllerState } from '../player/core/types';
import type { PlayerTickInput } from '../player/playerController';
import type { ProjectilePool } from '../save/runtimeState';
import {
  AIM_TURN_SECONDS, meleeAssistTarget, rangedAim, rangedAimPoint, type AimView, type RangedAim,
} from './aim';
import {
  advanceAttack, attackFinished, beforeRecovery, dodgeCancelOpen, inComboWindow, judgeHitEvent, judgeShape,
  startAttack, type Attacker, type AttackPlayback, type HitReceiver, type HitResult,
} from './attackRuntime';
import type { HitOrigin } from './hitShapes';
import { PLAYER_ENTITY_ID } from './playerReceiver';
import { ProjectileSystem } from './projectiles';

/** Move input shorter than this counts as none. */
const MOVE_EPS = 1e-3;
const NO_MOVE = { x: 0, y: 0 } as const;
const TIME_EPS = 1e-9;
/** Launch height of shots above the feet (bow height). */
export const SHOT_HEIGHT = 1.3;
const NO_AIM: AimView = { lockTarget: null, ray: null };
/** A placed ability without a target finds the ground from this far above to this far below the feet. */
const PLACE_PROBE_UP = 6;
const PLACE_PROBE_DOWN = 12;

/** The Active_Character body the combat system reads and turns. PlayerController satisfies it. */
export interface CombatBody {
  readonly state: Readonly<ControllerState>;
  face(yaw: number): void;
  /**
   * Lifts a gliding body `rise` m at once (PlayerController.glideRise, Req 19.9); returns whether it moved. A body
   * without it takes no gliding Skill cast.
   */
  glideRise?(rise: number): boolean;
}

export interface PlayerCombatOptions {
  bus: GameEventBus;
  /** The combat Rng stream (crit rolls). */
  rng: Rng;
  /** Shared party level (GameState.party.level). */
  level: () => number;
  /** Active_Character (GameState.party.active). */
  character: () => CharacterId;
  /** Terrain and colliders: projectiles stop on them and the camera ray finds its aim point. Default none. */
  world?: Pick<CollisionQueries, 'sweepCapsule' | 'raycast'> | null;
  /** RuntimeState.projectiles; default a fresh pool. */
  projectiles?: ProjectilePool;
  /** RuntimeState.energy (per character, changed here); default all 0. */
  energy?: Record<CharacterId, number>;
  /** RuntimeState.cooldowns (remaining s; started here, counted down by the Party_System); default all 0. */
  cooldowns?: Record<CharacterId, number>;
  /**
   * A Skill or Burst reached its first HitEvent: where the caster stood and faced, and the ability's params, for the
   * side effects placed in the world (Talus's stone pillar, src/world/talusPillars.ts).
   */
  onAbilityHit?(hit: AbilityHit): void;
  /**
   * Task 12.3: Echo Altar tier (0–3) of a character's Skill / Burst (GameState.party.upgrades). A cast plays the
   * upgraded kit (logic/upgrades: params, cooldown, hit shapes) and its hits carry the tiers' abilityUpgradePct.
   * Default 0.
   */
  abilityTier?(id: CharacterId, ability: 'skill' | 'burst'): number;
  /** Task 12.4: a character's equipment modifiers (crit chance, Reaction damage, pillar bonus); default none. */
  equipment?(id: CharacterId): CombatEquipment;
  /**
   * Task 19.6: GameLoop.setTimeScale. A Charged_Attack's final hit and the first landing hit of each Burst cast ask
   * for their Hit_Stop (logic/hitFeel, 50–90 ms real time); Normal hits never do. Omitted headless.
   */
  setTimeScale?: SetTimeScale;
  /** Task 19.5: every landed hit on an enemy (not a device), after its 'damage:dealt' (VFX impact, camera impulse). */
  onHit?(hit: HitResult): void;
}

/** The equipment modifiers PlayerCombat reads (logic/equipment EquipModifiers). */
export type CombatEquipment = Pick<
  EquipModifiers, 'critChanceAdd' | 'reactionDamagePct' | 'pillarBonus' | 'normalFinisherWave' | 'chargedPuddleSeconds' | 'launchPullRadius'
>;

/** The moment a Skill or Burst reaches its first HitEvent (PlayerCombatOptions.onAbilityHit). */
export interface AbilityHit {
  readonly characterId: CharacterId;
  readonly ability: 'skill' | 'burst';
  /** The caster's feet and facing at the hit. */
  readonly origin: { readonly pos: Vec3; readonly yaw: number };
  readonly params: Readonly<Record<string, number>>;
}

export interface PlayerCombatTick {
  /** This tick's InputState (not the gated view): attack, Skill and Burst presses, releases and the raw move input. */
  input: Pick<InputState, 'consumeBuffered' | 'moveVector' | 'released' | 'heldTime' | 'pressed'>;
  body: CombatBody;
  /** Camera yaw of the tick: facing of an attack started while moving, aim assist and aim cone reference. */
  cameraYaw: number;
  /** Lock-on target and camera ray for aimed shots and placed abilities. Default neither. */
  aim?: AimView;
  /** What the hits can land on (living enemies, Caelith). Iterated once per tick. */
  targets: Iterable<HitReceiver>;
  dt: number;
  /** False while input is locked (recovery fade, cinematic): no new attack or ability starts or chains. Default true. */
  acceptInput?: boolean;
}

/** Which of the character's actions is playing (also its DamageKind). */
export type PlayingKind = 'normal' | 'charged' | 'skill' | 'burst';

/** A Skill cast until it is known whether it hit an enemy ('skill:cast' hitEnemy, Energy once). */
interface SkillCast {
  characterId: CharacterId;
  /** Judgements of the cast (HitEvents × volleys) not made yet. */
  pending: number;
  /** 'skill:cast' was emitted. */
  done: boolean;
}

/** Energy bookkeeping of one HitEvent judgement. */
interface HitContext {
  /** energyOnHit of the HitEvent. */
  energy: number;
  /** The Skill cast the judgement belongs to, else null. */
  cast: SkillCast | null;
}

/** A HitEvent judgement placed with the owner snapshot and made at `dueAt` (ground circles, ability volleys). */
interface PlacedHit {
  attacker: Attacker;
  attackId: AttackId;
  index: number;
  hit: HitEvent;
  /** Combat clock time of the judgement. */
  dueAt: number;
  hitIds: Set<EntityId>;
  ctx: HitContext;
}

/** How often each HitEvent of the playing action is judged. */
interface Volleys {
  count: number;
  interval: number;
}

/** Facing correction in progress: from → to over AIM_TURN_SECONDS. */
interface Turn {
  from: number;
  delta: number;
  elapsed: number;
}

const SINGLE: Volleys = { count: 1, interval: 0 };

const shoots = (def: AttackDef): boolean => def.hits.some((h) => h.shape.kind === 'projectile');

/** Volleys of an ability from its params: round(seconds / interval) when both are set, else one. */
export function abilityVolleys(params: Readonly<Record<string, number>>): Volleys {
  const interval = params.interval ?? 0;
  const seconds = params.seconds ?? 0;
  return interval > 0 && seconds > 0 ? { count: Math.max(1, Math.round(seconds / interval)), interval } : SINGLE;
}

const perCharacter = (value: number): Record<CharacterId, number> =>
  Object.fromEntries(CHARACTER_IDS.map((id): [CharacterId, number] => [id, value])) as Record<CharacterId, number>;

/** A hit on an enemy (not an environment device): it counts for Energy and the Skill's first hit. */
const onFoe = (r: HitResult): boolean => r.receiver.device !== true;

/** `a` with its origin (or `origin`) and stats copied, for a judgement made later. */
function snapshot(a: Attacker, origin: HitOrigin = a.origin): Attacker {
  return { ...a, origin: { pos: copyV3(origin.pos), yaw: origin.yaw }, stats: { ...a.stats } };
}

export class PlayerCombat {
  /** Party projectiles in flight (pool). */
  readonly projectiles: ProjectileSystem;
  private readonly bus: GameEventBus;
  private readonly rng: Rng;
  private readonly level: () => number;
  private readonly character: () => CharacterId;
  private readonly world: Pick<CollisionQueries, 'sweepCapsule' | 'raycast'> | null;
  private readonly energy: Record<CharacterId, number>;
  private readonly cooldowns: Record<CharacterId, number>;
  private readonly unsubscribe: (() => void)[];
  private playback: AttackPlayback | null = null;
  private playing: PlayingKind | null = null;
  private step = -1;
  private turn: Turn | null = null;
  private aimed: RangedAim | null = null;
  /** Skill cast of the playing Skill, else null. */
  private cast: SkillCast | null = null;
  private volleys: Volleys = SINGLE;
  /** Where the playing ability's ground circles are placed; null places them at the character. */
  private placeAt: Vec3 | null = null;
  /** Cut-in of the playing Burst (s from clip start). */
  private cutIn = 0;
  private placed: PlacedHit[] = [];
  private clock = 0;
  /** Combat clock of the last tick the body was climbing (a hold begun before it does not charge). */
  private climbedAt = Number.NEGATIVE_INFINITY;
  /** The playing Skill was cast while gliding: it keeps playing while the body glides. */
  private airCast = false;
  /** Params of the playing Skill or Burst (its side effects), else null. */
  private abilityParams: Readonly<Record<string, number>> | null = null;
  private readonly onAbilityHit: ((hit: AbilityHit) => void) | null;
  /** Task 12.3–12.4: Echo Altar tiers and equipment modifiers. */
  private readonly abilityTier: (id: CharacterId, ability: 'skill' | 'burst') => number;
  private readonly equipment: (id: CharacterId) => CombatEquipment;
  /** abilityUpgradePct of the playing Skill or Burst (its tiers' dmgPct). */
  private abilityPct = 0;
  /** Task 19.6: Hit_Stop requests and the per-hit presentation hook. */
  private readonly setTimeScale: SetTimeScale | null;
  private readonly onHitHook: ((hit: HitResult) => void) | null;
  /** The last Burst cast has not landed a hit yet (its first hit asks for the Hit_Stop). */
  private burstStopPending = false;

  constructor(options: PlayerCombatOptions) {
    this.bus = options.bus;
    this.setTimeScale = options.setTimeScale ?? null;
    this.onHitHook = options.onHit ?? null;
    this.onAbilityHit = options.onAbilityHit ?? null;
    this.abilityTier = (id, ability) => options.abilityTier?.(id, ability) ?? 0;
    this.equipment = (id) => options.equipment?.(id) ?? NO_MODIFIERS;
    this.rng = options.rng;
    this.level = options.level;
    this.character = options.character;
    this.world = options.world ?? null;
    this.energy = options.energy ?? perCharacter(0);
    this.cooldowns = options.cooldowns ?? perCharacter(0);
    this.projectiles = new ProjectileSystem({ pool: options.projectiles ?? { active: [] }, world: this.world });
    this.unsubscribe = [
      this.bus.on('reaction', () => this.grant(this.character(), energyGain('reaction'))),
      this.bus.on('perfectDodge', (e) => this.grant(e.characterId, energyGain('perfectDodge'))),
    ];
  }

  /** The attack being played, or null. */
  get attack(): Readonly<AttackPlayback> | null {
    return this.playback;
  }

  /** 'normal', 'charged', 'skill' or 'burst' while one plays, else null. */
  get attackKind(): PlayingKind | null {
    return this.playing;
  }

  /** Index of the playing hit in the Normal_Attack chain (0 = hit 1); −1 when idle or charging. */
  get comboStep(): number {
    return this.step;
  }

  /** Aim chosen when the playing attack started (shooting attacks), else null. */
  get aim(): Readonly<RangedAim> | null {
    return this.aimed;
  }

  /** Placed hits (ground circles, ability volleys) not judged yet. */
  get pendingCircles(): number {
    return this.placed.length;
  }

  /** Movement (and sprint / jump) input is held back: an attack is playing and has not reached recoveryFrom. */
  get locksMovement(): boolean {
    return this.playback !== null && beforeRecovery(this.playback);
  }

  /** The Active_Character is inside its Burst cut-in: enemy hits pass through (Req 24.6). */
  get invulnerable(): boolean {
    const p = this.playback;
    return this.playing === 'burst' && p !== null && p.t < this.cutIn - TIME_EPS;
  }

  /** Current Energy of `id`. */
  energyOf(id: CharacterId): number {
    return this.energy[id];
  }

  /** Remaining Skill cooldown of `id` (s). */
  cooldownOf(id: CharacterId): number {
    return this.cooldowns[id];
  }

  /**
   * Stops the current attack (and its facing correction) without judging its remaining hits. Launched
   * projectiles and placed hits stay (Req 23.6). A Skill whose remaining judgements are all dropped this way
   * without a hit reports 'skill:cast' with hitEnemy false.
   */
  cancel(): void {
    const p = this.playback;
    const cast = this.cast;
    if (p !== null && cast !== null) {
      cast.pending -= p.judged.filter((j) => !j).length * this.volleys.count;
      this.settle(cast);
    }
    this.playback = null;
    this.playing = null;
    this.step = -1;
    this.turn = null;
    this.aimed = null;
    this.cast = null;
    this.volleys = SINGLE;
    this.placeAt = null;
    this.cutIn = 0;
    this.airCast = false;
    this.abilityParams = null;
    this.abilityPct = 0;
  }

  /** cancel() plus every projectile and placed hit (Party_Wipe restart). */
  reset(): void {
    this.cancel();
    const placed = this.placed;
    this.placed = [];
    for (const c of placed) this.judged(c.ctx, false);
    this.projectiles.clear();
  }

  /** Stops listening to the bus. */
  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /**
   * View of `src` for the PlayerController that applies the attack's movement rules; it reads this system's
   * state on every call, so one view can be reused for every tick.
   */
  gateInput(src: PlayerTickInput): PlayerTickInput {
    return {
      moveVector: () => (this.locksMovement ? { ...NO_MOVE } : src.moveVector()),
      down: (a) => (a === 'sprint' && this.locksMovement ? false : src.down(a)),
      pressed: (a) => src.pressed(a),
      isBuffered: (a) => this.letsThrough(a) && src.isBuffered(a),
      get walkToggled() {
        return src.walkToggled;
      },
      consumeBuffered: (a) => src.consumeBuffered(a),
    };
  }

  /** Runs one tick; returns the hits landed this tick (melee, placed hits, projectiles). */
  tick(t: PlayerCombatTick): HitResult[] {
    const dt = Number.isFinite(t.dt) && t.dt > 0 ? t.dt : 0;
    this.clock += dt;
    const climbing = isClimbMode(t.body.state.mode) || t.body.state.mode === 'swim';
    if (climbing) {
      // Req 18.11: Normal_Attack, Skill and Burst input is ignored while climbing (and swimming): no refusal, a
      // buffered attack press is dropped and a hold that overlaps the climb or swim never charges.
      this.climbedAt = this.clock;
      t.input.consumeBuffered('attack');
    }
    const accept = (t.acceptInput ?? true) && !climbing;
    const standing = t.body.state.mode === 'grounded';
    const gliding = isGlideMode(t.body.state.mode);
    const targets = [...t.targets]; // one snapshot for everything judged this tick
    const p = this.playback;
    if (p !== null) {
      const moving = !beforeRecovery(p) && this.moveLength(t) > MOVE_EPS;
      const holds = standing || (gliding && this.airCast);
      if (!holds || moving) this.cancel();
    }

    const id = this.character();
    const kit = CHARACTERS[id];
    const chain = kit.normal;
    const cast = accept && this.castAbility(id, kit, standing, gliding, t, targets);
    if (cast) {
      // The ability took this tick's input.
    } else if (
      accept && standing && !this.abilityPlaying &&
      t.input.released('attack') && t.input.heldTime('attack') >= CHARGE_SECONDS - TIME_EPS &&
      this.clock - t.input.heldTime('attack') > this.climbedAt + TIME_EPS
    ) {
      this.begin(kit.charged, 'charged', -1, t, targets);
    } else if (this.playback !== null) {
      if (
        accept &&
        this.playing === 'normal' &&
        this.step + 1 < chain.length &&
        inComboWindow(this.playback) &&
        t.input.consumeBuffered('attack')
      ) {
        const next = chain[this.step + 1];
        if (next !== undefined) this.begin(next, 'normal', this.step + 1, t, targets);
      }
    } else if (accept && standing && t.input.consumeBuffered('attack')) {
      const first = chain[0];
      if (first !== undefined) this.begin(first, 'normal', 0, t, targets);
    }
    this.stepTurn(t.body, dt);

    const results: HitResult[] = [];
    const playing = this.playback;
    if (playing !== null) {
      const due = advanceAttack(playing, dt, (hit) => hit.t);
      if (due.length > 0) {
        const attacker = this.attacker(t.body.state, this.playing ?? 'normal');
        for (const index of due) results.push(...this.fire(playing, index, attacker, t, targets));
      }
      if (attackFinished(playing)) this.cancel();
    }
    results.push(...this.judgePlaced(targets));
    const shot = this.projectiles.tick(dt, targets);
    results.push(...shot);
    this.placePuddles(shot); // task 12.4: 조수부름 활

    for (const { receiver, hit } of results) {
      if (receiver.device === true) continue; // devices show no damage numbers
      const volume = receiver.hurtVolume();
      this.bus.emit('damage:dealt', {
        targetId: receiver.id,
        amount: hit.amount,
        crit: hit.crit,
        element: hit.element,
        position: { x: volume.pos.x, y: volume.pos.y + volume.height, z: volume.pos.z },
      });
      this.hitFeel(receiver, hit);
    }
    return results;
  }

  /**
   * Task 19.6 (Req 26.3, 26.4): a Charged_Attack's final hit and a Burst cast's first landing hit ask for their Hit_Stop
   * (logic/hitFeel); other hits (Normal_Attack included) never stop the simulation. Then the presentation hook.
   */
  private hitFeel(receiver: HitReceiver, hit: HitResult['hit']): void {
    const burst = hit.kind === 'burst';
    if (!burst || this.burstStopPending) {
      const { hitStop } = hitFeelOfHit(hit.kind, hit.attackId, hit.hitIndex);
      if (hitStop > 0) this.setTimeScale?.('hitStop', 0, hitStop);
      if (burst) this.burstStopPending = false;
    }
    this.onHitHook?.({ receiver, hit });
  }

  /** A Skill or Burst is playing. */
  private get abilityPlaying(): boolean {
    return this.playing === 'skill' || this.playing === 'burst';
  }

  /**
   * This tick's `burst` and `skill` presses (Burst first): a refused press reports 'ability:refused'; an
   * accepted one starts when the character stands and no ability plays. A Skill with a `glideRise` param also
   * starts while gliding and lifts the body (Req 19.9). Returns whether one started.
   */
  private castAbility(
    id: CharacterId, kit: CharacterDef, standing: boolean, gliding: boolean, t: PlayerCombatTick, targets: HitReceiver[],
  ): boolean {
    const canStart = standing && !this.abilityPlaying;
    const rise = gliding && t.body.glideRise !== undefined ? (kit.skill.params.glideRise ?? 0) : 0;
    const canStartSkill = (standing || rise > 0) && !this.abilityPlaying;
    if (t.input.pressed('burst')) {
      const { burst } = kit;
      if (!canBurst(this.energy[id], burst.energyCost)) this.refuse(id, 'burst');
      else if (canStart) {
        this.cancel();
        this.energy[id] = spendBurst();
        this.bus.emit('burst:cast', { characterId: id });
        const up = upgradedAbility(burst, this.abilityTier(id, 'burst')); // task 12.3: Echo Altar tiers
        this.begin(up.attack, 'burst', -1, t, targets, up.params);
        this.abilityPct = up.dmgPct;
        this.cutIn = burst.cutIn;
        this.burstStopPending = true; // task 19.6
        return true;
      }
    }
    if (t.input.pressed('skill')) {
      const { skill } = kit;
      if (!skillReady(this.cooldowns[id])) this.refuse(id, 'skill');
      else if (canStartSkill) {
        this.cancel();
        const up = upgradedAbility(skill, this.abilityTier(id, 'skill')); // task 12.3: Echo Altar tiers
        const pillar = this.equipment(id).pillarBonus; // task 12.4: 원시 방벽 keeps the pillar longer, its impact pushes
        if (pillar !== null && up.params.pillarSeconds !== undefined) {
          up.params.pillarSeconds += pillar.seconds;
          up.attack = { ...up.attack, hits: up.attack.hits.map((h) => ({ ...h, knockback: Math.max(h.knockback, pillar.knockback) })) };
        }
        this.cooldowns[id] = up.cooldown ?? skill.cooldown; // counted down in sim time by the Party_System
        this.begin(up.attack, 'skill', -1, t, targets, up.params);
        this.abilityPct = up.dmgPct;
        this.cast = { characterId: id, pending: up.attack.hits.length * this.volleys.count, done: false };
        if (!standing) {
          this.airCast = true;
          t.body.glideRise?.(rise);
        }
        return true;
      }
    }
    return false;
  }

  private refuse(id: CharacterId, ability: 'skill' | 'burst'): void {
    this.bus.emit('ability:refused', { characterId: id, ability });
  }

  /**
   * Starts `def` and sets up its facing: a placed ability's point (`params.fallbackRange`), aim (shots), aim assist
   * (melee), else the move input. `params` of a Skill or Burst set its volleys.
   */
  private begin(
    def: AttackDef,
    kind: PlayingKind,
    step: number,
    t: PlayerCombatTick,
    targets: HitReceiver[],
    params: Readonly<Record<string, number>> | null = null,
  ): void {
    const state = t.body.state;
    this.playback = startAttack(def);
    this.playing = kind;
    this.step = step;
    this.turn = null;
    this.aimed = null;
    this.volleys = params === null ? SINGLE : abilityVolleys(params);
    this.abilityParams = kind === 'skill' || kind === 'burst' ? params : null;
    this.placeAt = null;
    let goal: number | null = null;
    const foes = targets.filter((r) => r.device !== true); // devices are no aim-assist targets
    const range = params?.fallbackRange;
    if (range !== undefined) {
      this.placeAt = this.placementPoint(state.pos, t, foes, range);
      goal = this.yawToward(state.pos, this.placeAt);
    } else if (shoots(def)) {
      this.aimed = rangedAim(state.pos, t.cameraYaw, t.aim ?? NO_AIM, foes, this.world, SHOT_HEIGHT);
      const point = rangedAimPoint(this.aimed);
      goal = this.yawToward(state.pos, point);
    } else {
      const target = meleeAssistTarget(state.pos, t.cameraYaw, foes);
      if (target !== null) goal = this.yawToward(state.pos, target.hurtVolume().pos);
    }
    if (goal !== null) {
      this.turn = { from: state.yaw, delta: angleDelta(state.yaw, goal), elapsed: 0 };
      return;
    }
    const move = t.input.moveVector();
    if (Math.hypot(move.x, move.y) > MOVE_EPS) {
      const dir = cameraRelativeMove(move, t.cameraYaw);
      t.body.face(yawFromDir(dir.x, dir.z));
    }
  }

  /** The living Lock-on target's feet, else the ground `range` m ahead of the camera. */
  private placementPoint(pos: Readonly<Vec3>, t: PlayerCombatTick, targets: HitReceiver[], range: number): Vec3 {
    const lock = t.aim?.lockTarget ?? null;
    const target = lock === null ? undefined : targets.find((r) => r.id === lock && !r.immune());
    if (target !== undefined) return copyV3(target.hurtVolume().pos);
    const f = dirFromYaw(t.cameraYaw);
    const point = { x: pos.x + f.x * range, y: pos.y, z: pos.z + f.z * range };
    const ground = this.world?.raycast(
      { x: point.x, y: pos.y + PLACE_PROBE_UP, z: point.z }, { x: 0, y: -1, z: 0 }, PLACE_PROBE_UP + PLACE_PROBE_DOWN,
    );
    if (ground != null) point.y = ground.point.y;
    return point;
  }

  /** Horizontal yaw from `from` toward `to`; null when they coincide. */
  private yawToward(from: Readonly<Vec3>, to: Readonly<Vec3>): number | null {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return Math.hypot(dx, dz) > 1e-6 ? yawFromDir(dx, dz) : null;
  }

  /** Advances the facing correction; it completes AIM_TURN_SECONDS after the attack started (Req 24.12). */
  private stepTurn(body: CombatBody, dt: number): void {
    const turn = this.turn;
    if (turn === null) return;
    turn.elapsed += dt;
    const k = Math.min(1, (turn.elapsed + TIME_EPS) / AIM_TURN_SECONDS);
    body.face(wrapAngle(turn.from + turn.delta * k));
    if (k >= 1) this.turn = null;
  }

  /** One due HitEvent: launch, place or judge it, and place its further volleys. */
  private fire(p: AttackPlayback, index: number, attacker: Attacker, t: PlayerCombatTick, targets: HitReceiver[]): HitResult[] {
    const hit = p.def.hits[index];
    if (hit === undefined) return [];
    const ability = this.playing;
    if (index === 0 && (ability === 'skill' || ability === 'burst') && this.abilityParams !== null) {
      this.onAbilityHit?.({
        characterId: this.character(), ability, origin: { pos: copyV3(attacker.origin.pos), yaw: attacker.origin.yaw },
        params: this.abilityParams,
      });
    }
    const ctx: HitContext = { energy: hit.energyOnHit ?? 0, cast: this.cast };
    const { count, interval } = this.volleys;
    const late = Math.max(0, p.t - hit.t); // the tick overshoots `t` by less than dt
    const place = (k: number, origin: HitOrigin, delay: number, hitIds: Set<EntityId>): void => {
      this.placed.push({
        attacker: snapshot(attacker, origin), attackId: p.def.id, index, hit,
        dueAt: this.clock - late + delay + k * interval, hitIds, ctx,
      });
    };
    if (hit.shape.kind === 'projectile') {
      const pos = t.body.state.pos;
      const from = { x: pos.x, y: pos.y + SHOT_HEIGHT, z: pos.z };
      const point = this.aimed !== null ? rangedAimPoint(this.aimed) : null;
      const dir = point !== null
        ? { x: point.x - from.x, y: point.y - from.y, z: point.z - from.z }
        : dirFromYaw(t.body.state.yaw);
      // A Skill shot would count as judged at launch; no kit Skill shoots.
      this.projectiles.spawn({ attacker, attackId: p.def.id, hitIndex: index, hit, from, dir, onFirstHit: () => this.reward(ctx) });
      this.judged({ ...ctx, energy: 0 }, false);
      return [];
    }
    if (hit.shape.kind === 'groundCircle') {
      const origin = this.placeAt === null ? attacker.origin : { pos: this.placeAt, yaw: attacker.origin.yaw };
      for (let k = 0; k < count; k++) place(k, origin, hit.shape.delay, k === 0 ? (p.hitIds[index] ?? new Set()) : new Set());
      return [];
    }
    const results = judgeHitEvent(p, index, attacker, targets);
    this.judged(ctx, results.some(onFoe));
    for (let k = 1; k < count; k++) place(k, attacker.origin, 0, new Set());
    const wave = this.finisherWave(hit); // task 12.4: 잿불송곳니
    if (wave !== null) results.push(...judgeShape(p.def.id, index, wave, attacker, targets, new Set()));
    // Task 12.4 (하늘가르개 `launchPull`): a Charged launch also takes the enemies within `radius` m of each one it hit.
    const pull = this.playing === 'charged' && hit.launch !== undefined ? this.equipment(this.character()).launchPullRadius : 0;
    const hitIds = p.hitIds[index];
    if (pull > 0 && hitIds !== undefined) {
      for (const r of [...results]) {
        const around: HitEvent = { ...hit, shape: { kind: 'sphere', radius: pull, offset: { x: 0, y: 0, z: 0 } }, energyOnHit: 0 };
        const at = { ...attacker, origin: { pos: copyV3(r.receiver.hurtVolume().pos), yaw: attacker.origin.yaw } };
        results.push(...judgeShape(p.def.id, index, around, at, targets, hitIds));
      }
    }
    return results;
  }

  /**
   * Task 12.4 (조수부름 활 `chargedPuddle`): a Charged arrow that hits leaves a 2 m puddle at the target's feet for
   * `seconds` s, which applies Tide to the enemies in it once a second (0× damage, so the minimum 1).
   */
  private placePuddles(shot: readonly HitResult[]): void {
    const id = this.character();
    const seconds = this.equipment(id).chargedPuddleSeconds;
    const charged = CHARACTERS[id].charged;
    if (!(seconds > 0)) return;
    for (const r of shot) {
      if (r.hit.attackId !== charged.id || r.receiver.device === true) continue;
      const puddle: HitEvent = {
        t: 0, shape: { kind: 'groundCircle', radius: 2, delay: 0 }, dmgMul: 0, appliesElement: true, poise: 0,
        knockback: 0, energy: null, energyOnHit: 0,
      };
      const attacker: Attacker = {
        id: PLAYER_ENTITY_ID, origin: { pos: copyV3(r.receiver.hurtVolume().pos), yaw: 0 },
        stats: r.hit.attackerStats ?? { baseAtk: 0, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
        kind: 'charged', element: CHARACTERS[id].element, elementSource: id, roll: () => 1,
      };
      for (let k = 1; k <= Math.floor(seconds); k++) {
        this.placed.push({
          attacker, attackId: charged.id, index: 0, hit: puddle, dueAt: this.clock + k, hitIds: new Set(), ctx: { energy: 0, cast: null },
        });
      }
    }
  }

  /**
   * Task 12.4 (잿불송곳니 `normalFinisherWave`): the last Normal hit also sends a wave `radius` m past the blade's reach,
   * `mul` × ATK with the character's Element; null for every other hit or without the Weapon.
   */
  private finisherWave(hit: HitEvent): HitEvent | null {
    if (this.playing !== 'normal') return null;
    const id = this.character();
    const kit = CHARACTERS[id];
    const wave = this.equipment(id).normalFinisherWave;
    if (wave === null || this.step !== kit.normal.length - 1) return null;
    return {
      t: hit.t, shape: { kind: 'line', length: kit.normalRange + wave.radius, width: 2 }, dmgMul: wave.mul,
      appliesElement: true, poise: 0, knockback: 0, energy: null, energyOnHit: 0,
    };
  }

  /** Judges the placed hits whose time has come. */
  private judgePlaced(targets: HitReceiver[]): HitResult[] {
    if (this.placed.length === 0) return [];
    const results: HitResult[] = [];
    const waiting: PlacedHit[] = [];
    const due: PlacedHit[] = [];
    for (const c of this.placed) (this.clock >= c.dueAt - TIME_EPS ? due : waiting).push(c);
    this.placed = waiting;
    for (const c of due) {
      const landed = judgeShape(c.attackId, c.index, c.hit, c.attacker, targets, c.hitIds);
      this.judged(c.ctx, landed.some(onFoe));
      results.push(...landed);
    }
    return results;
  }

  /** One judgement of `ctx` was made: its Energy when it `landed`, and its Skill cast's count. */
  private judged(ctx: HitContext, landed: boolean): void {
    if (landed) this.reward(ctx);
    const cast = ctx.cast;
    if (cast === null) return;
    cast.pending -= 1;
    this.settle(cast);
  }

  /** A judgement of `ctx` hit: its energyOnHit, and the Skill cast's Energy and 'skill:cast' on its first hit. */
  private reward(ctx: HitContext): void {
    const active = this.character();
    this.grant(active, ctx.energy);
    const cast = ctx.cast;
    if (cast === null || cast.done) return;
    cast.done = true;
    this.grant(active, energyGain('skillCastHit'));
    this.bus.emit('skill:cast', { characterId: cast.characterId, hitEnemy: true });
  }

  /** Every judgement of the cast is made (or dropped) without a hit: 'skill:cast' with hitEnemy false. */
  private settle(cast: SkillCast): void {
    if (cast.done || cast.pending > 0) return;
    cast.done = true;
    this.bus.emit('skill:cast', { characterId: cast.characterId, hitEnemy: false });
  }

  /** Adds `amount` Energy to `id`, clamped to its Burst cost (Req 24.7). */
  private grant(id: CharacterId, amount: number): void {
    if (!(amount > 0)) return;
    this.energy[id] = addEnergy(this.energy[id], CHARACTERS[id].burst.energyCost, amount);
  }

  private attacker(state: Readonly<ControllerState>, kind: PlayingKind): Attacker {
    const id = this.character();
    const def = CHARACTERS[id];
    const gear = this.equipment(id);
    return {
      id: PLAYER_ENTITY_ID,
      origin: { pos: state.pos, yaw: state.yaw },
      stats: {
        baseAtk: def.baseStats.atk,
        level: this.level(),
        equipAtkPct: 0, // no equipment raises ATK (effects are unique, design "장비")
        abilityUpgradePct: kind === 'skill' || kind === 'burst' ? this.abilityPct : 0, // task 12.3: Echo Altar tiers
        equipDmgPct: 0,
        critChance: Math.min(1, BASE_CRIT_CHANCE + gear.critChanceAdd), // task 12.4: 별빛 눈
        reactionDamagePct: gear.reactionDamagePct, // task 12.4: 잉걸 핵
      },
      kind,
      element: def.element,
      elementSource: id,
      roll: () => this.rng.next(),
    };
  }

  private letsThrough(a: 'jump' | 'attack' | 'dodge'): boolean {
    const p = this.playback;
    if (p === null) return true;
    if (a === 'jump') return !beforeRecovery(p);
    if (a === 'dodge') return dodgeCancelOpen(p);
    return true;
  }

  private moveLength(t: PlayerCombatTick): number {
    const m = t.input.moveVector();
    return Math.hypot(m.x, m.y);
  }
}

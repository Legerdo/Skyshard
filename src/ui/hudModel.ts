/*
 * HudModel (design "갱신 전략" view model; task 14.3): what the gameplay HUD draws, derived once per render frame from
 * the simulation's read-only state by HudModelTracker. The views (./combatHud, ./enemyBars) compare it field by field
 * with what they show and write only what changed. Pure: no DOM, no three.js, real seconds and sim times from the
 * caller, so the display rules are unit-tested (tests/unit/ui/hudModel.test.ts):
 * - Out of combat (Req 32.3): after 4.7 s outside In_Combat the Skill / Burst icons and the party slots fade over
 *   0.3 s to 50 % at 5 s; In_Combat puts them straight back to 100 %.
 * - Burst ready (Req 32.7): the Active_Character's Energy reaching its cost on this frame raises `burstReady` once
 *   (the gold flare; the ready chime is SessionAudio's, on the same rule). The glow itself stays while Energy is full
 *   (until the Burst spends it); a switch to a character already full lights the glow without the edge.
 * - Party slots (Req 32.2, 23.3, 23.9): portrait state, Element, HP, the Skill sweep, the Burst star, Downed, the 0.8 s
 *   switch-lock sweep and the reaction preview on standby slots.
 * - Enemy HP bars (Req 32.5, 25.2): living enemies that were hurt (HP or Element_Shield durability below max) or are
 *   the Lock-on target, the target first and then nearest to the camera, 12 at most, each kept in the same pool slot
 *   while it stays shown. Element_Mark icon with its 8 s ring, or the shield's Element (no ring) while a shield stands;
 *   Elites get the wide bar and their name.
 */
import type { Vec3 } from '../core/types';
import { ENEMY_DEFS } from '../data/enemies';
import { isEliteId, type CharacterId, type EliteId, type ElementId, type EnemyId, type EntityId, type ReactionId } from '../data/ids';
import { MARK_DURATION } from '../data/reactions';
import { HUD_WORLD_BARS } from './hudLayout';

/** Out-of-combat fade (Req 32.3): starts `delay` s after combat, lasts `seconds`, ends at `alpha`. */
export const HUD_COMBAT_FADE = { delay: 4.7, seconds: 0.3, alpha: 0.5 } as const;
/** HP fraction below which a bar turns red. */
export const HUD_LOW_HP = 0.3;
/** Enemy bars float this far above the head (m). */
export const ENEMY_BAR_LIFT = 0.35;

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const fraction = (value: number, max: number): number => (max > 0 ? clamp01(value / max) : 0);

/** Opacity of the Skill / Burst icons and party slots after `outOfCombat` s outside In_Combat. */
export function combatFadeAlpha(outOfCombat: number): number {
  const { delay, seconds, alpha } = HUD_COMBAT_FADE;
  const t = clamp01((outOfCombat - delay) / seconds);
  return 1 - (1 - alpha) * t;
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** One party slot as the simulation sees it. */
export interface HudPartyInput {
  readonly id: CharacterId;
  /** 1–4, the switch key. */
  readonly slot: number;
  readonly name: string;
  readonly element: ElementId;
  readonly joined: boolean;
  readonly downed: boolean;
  readonly active: boolean;
  readonly hp: number;
  readonly maxHp: number;
  /** Remaining Skill cooldown and the full cooldown at the character's tier (s). */
  readonly skillRemaining: number;
  readonly skillCooldown: number;
  readonly energy: number;
  readonly energyCost: number;
  /** Counts refused switches to this slot (a change restarts the 0.25 s shake, Req 23.2). */
  readonly shakeSeq: number;
  /** The reaction this character's Element would cause on the previewed target, else null (Req 23.9). */
  readonly preview: ReactionId | null;
}

/** The Element state of an enemy (logic/element ElementTarget, read only). */
export interface HudElementState {
  readonly mark: { readonly element: ElementId; readonly expiresAt: number } | null;
  readonly shield: { readonly element: ElementId; readonly durability: number; readonly max: number } | null;
}

/** One enemy as the HUD reads it (a structural subset of RuntimeState's EnemyRuntime). */
export interface HudEnemyInput {
  readonly id: EntityId;
  readonly def: EnemyId | EliteId;
  readonly hp: number;
  readonly maxHp: number;
  readonly state: string;
  readonly element: HudElementState;
  /** Feet now and at the end of the previous tick (render interpolation). */
  readonly pos: Readonly<Vec3>;
  readonly prevPos: Readonly<Vec3>;
}

export interface HudInput {
  readonly inCombat: boolean;
  /** Party level (Lv N beside the HP bar). */
  readonly level: number;
  /** The four slots in slot order. */
  readonly party: readonly HudPartyInput[];
  /** Share of the 0.8 s switch lock still to run, 0–1. */
  readonly switchLock: number;
  /** Bound key labels of the Skill and Burst. */
  readonly skillKey: string;
  readonly burstKey: string;
  readonly enemies: Iterable<HudEnemyInput>;
  readonly lockTarget: EntityId | null;
  /** Sim time the Element_Marks' `expiresAt` count in. */
  readonly now: number;
  /** Render camera position (bar priority by distance). */
  readonly camera: Readonly<Vec3>;
  /** Render interpolation between the previous and the current tick (0–1). */
  readonly alpha: number;
}

// ── Model ───────────────────────────────────────────────────────────────────

export type HudSlotState = 'empty' | 'downed' | 'active' | 'standby';

export interface HudSlotModel {
  readonly slot: number;
  readonly id: CharacterId;
  readonly name: string;
  readonly element: ElementId;
  readonly state: HudSlotState;
  /** HP fraction (0 for an empty slot). */
  readonly hp: number;
  readonly low: boolean;
  /** Share of the Skill cooldown still to run (0 ready). */
  readonly skill: number;
  /** Burst Energy fraction and whether it is full (the four-point star). */
  readonly burst: number;
  readonly burstFull: boolean;
  /** Switch-lock radial sweep, 0–1 (standby slots only). */
  readonly lock: number;
  /** Reaction preview icon (standby slots only), else null. */
  readonly preview: ReactionId | null;
  readonly shakeSeq: number;
}

export interface HudVitalsModel {
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly fraction: number;
  readonly low: boolean;
}

export interface HudAbilitiesModel {
  /** Skill ⌀76: the dark sweep (share of the cooldown left), whole seconds left (0 ready). */
  readonly skill: { readonly fraction: number; readonly seconds: number; readonly ready: boolean; readonly key: string };
  /** Burst ⌀92: the ring fill, Energy / cost, and the ready glow. */
  readonly burst: { readonly fraction: number; readonly energy: number; readonly cost: number; readonly ready: boolean; readonly key: string };
}

export interface EnemyBarModel {
  readonly id: EntityId;
  /** Elite: 128 × 10 bar with the name above it; others 96 × 8 without a name. */
  readonly elite: boolean;
  readonly name: string;
  readonly hp: number;
  readonly low: boolean;
  /** Element_Shield durability bar above the HP bar. */
  readonly shield: { readonly element: ElementId; readonly fraction: number } | null;
  /** Mark icon: the shield's Element (no ring) while a shield stands, else the mark with its 8 s ring share. */
  readonly mark: { readonly element: ElementId; readonly ring: number | null } | null;
  readonly locked: boolean;
  /** World point above the head the view projects. */
  readonly head: Vec3;
}

export interface HudModel {
  /** Opacity of the Skill / Burst icons and the party slots (Req 32.3). */
  readonly combatAlpha: number;
  readonly vitals: HudVitalsModel;
  readonly party: readonly HudSlotModel[];
  readonly abilities: HudAbilitiesModel;
  /** The Active_Character's Burst Energy reached max on this frame (once per fill). */
  readonly burstReady: boolean;
  /** Counts `burstReady` edges, so a view can restart its flare without comparing frames. */
  readonly burstFlareSeq: number;
  /** The enemy HP bar pool, HUD_WORLD_BARS.pool long; null slots are hidden. */
  readonly enemyBars: readonly (EnemyBarModel | null)[];
}

// ── Enemy bars ──────────────────────────────────────────────────────────────

interface BarCandidate {
  readonly enemy: HudEnemyInput;
  readonly locked: boolean;
  readonly dist2: number;
  readonly feet: Vec3;
}

const lerp = (a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t,
});

/** Whether `e` gets a bar: alive, and hurt (HP or shield below max) or the Lock-on target (Req 32.5). */
export function wantsEnemyBar(e: HudEnemyInput, lockTarget: EntityId | null): boolean {
  if (e.state === 'dead' || !(e.hp > 0)) return false;
  if (e.id === lockTarget) return true;
  const shield = e.element.shield;
  return e.hp < e.maxHp || (shield !== null && shield.durability < shield.max);
}

/**
 * The enemies that get a bar, in priority order (the Lock-on target first, then nearest to the camera), at most
 * `limit`.
 */
export function rankEnemyBars(input: Pick<HudInput, 'enemies' | 'lockTarget' | 'camera' | 'alpha'>, limit = HUD_WORLD_BARS.pool): BarCandidate[] {
  const t = clamp01(input.alpha);
  const out: BarCandidate[] = [];
  for (const enemy of input.enemies) {
    if (!wantsEnemyBar(enemy, input.lockTarget)) continue;
    const feet = lerp(enemy.prevPos, enemy.pos, t);
    const dx = feet.x - input.camera.x;
    const dy = feet.y - input.camera.y;
    const dz = feet.z - input.camera.z;
    out.push({ enemy, locked: enemy.id === input.lockTarget, dist2: dx * dx + dy * dy + dz * dz, feet });
  }
  out.sort((a, b) => (a.locked !== b.locked ? (a.locked ? -1 : 1) : a.dist2 - b.dist2));
  return out.slice(0, Math.max(0, limit));
}

/**
 * Pool slots for `wanted` ids: an id already in a slot of `prev` keeps it, the others take the free slots from the
 * lowest index in `wanted` order. Ids that do not fit are left out.
 */
export function assignPoolSlots<T>(prev: readonly (T | null)[], wanted: readonly T[], size: number): (T | null)[] {
  const next: (T | null)[] = Array.from({ length: size }, () => null);
  const want = new Set(wanted);
  const placed = new Set<T>();
  for (let i = 0; i < Math.min(size, prev.length); i++) {
    const id = prev[i];
    if (id === null || id === undefined || !want.has(id) || placed.has(id)) continue;
    next[i] = id;
    placed.add(id);
  }
  let free = 0;
  for (const id of wanted) {
    if (placed.has(id)) continue;
    while (free < size && next[free] !== null) free++;
    if (free >= size) break;
    next[free] = id;
    placed.add(id);
  }
  return next;
}

/** One bar's view of candidate `c` at sim time `now`. */
export function enemyBarModel(c: BarCandidate, now: number): EnemyBarModel {
  const { enemy } = c;
  const def = ENEMY_DEFS[enemy.def];
  const elite = isEliteId(enemy.def);
  const { shield, mark } = enemy.element;
  const hp = fraction(enemy.hp, enemy.maxHp);
  let markView: EnemyBarModel['mark'] = null;
  if (shield !== null) markView = { element: shield.element, ring: null };
  else if (mark !== null && now < mark.expiresAt) markView = { element: mark.element, ring: clamp01((mark.expiresAt - now) / MARK_DURATION) };
  return {
    id: enemy.id,
    elite,
    name: elite ? def?.name ?? '' : '',
    hp,
    low: hp < HUD_LOW_HP,
    shield: shield === null ? null : { element: shield.element, fraction: fraction(shield.durability, shield.max) },
    mark: markView,
    locked: c.locked,
    head: { x: c.feet.x, y: c.feet.y + (def?.height ?? 1.5) + ENEMY_BAR_LIFT, z: c.feet.z },
  };
}

// ── Tracker ─────────────────────────────────────────────────────────────────

function slotModel(p: HudPartyInput, switchLock: number): HudSlotModel {
  const state: HudSlotState = !p.joined ? 'empty' : p.downed ? 'downed' : p.active ? 'active' : 'standby';
  const hp = p.joined ? fraction(p.hp, p.maxHp) : 0;
  const burstFull = p.joined && p.energyCost > 0 && p.energy >= p.energyCost;
  return {
    slot: p.slot,
    id: p.id,
    name: p.name,
    element: p.element,
    state,
    hp,
    low: p.joined && hp < HUD_LOW_HP,
    skill: p.joined && p.skillRemaining > 1e-6 ? fraction(p.skillRemaining, Math.max(p.skillCooldown, p.skillRemaining)) : 0,
    burst: p.joined ? fraction(p.energy, p.energyCost) : 0,
    burstFull,
    lock: state === 'standby' ? clamp01(switchLock) : 0,
    preview: state === 'standby' ? p.preview : null,
    shakeSeq: p.shakeSeq,
  };
}

/**
 * Builds the HudModel every render frame, carrying what the rules need between frames: the seconds outside
 * In_Combat, which characters were at full Energy, and which enemy holds which bar slot.
 */
export class HudModelTracker {
  private outOfCombat = 0;
  private full: Map<CharacterId, boolean> | null = null;
  private barIds: (EntityId | null)[] = Array.from({ length: HUD_WORLD_BARS.pool }, () => null);
  private flareSeq = 0;

  /** Seconds spent outside In_Combat (0 while in it). */
  get secondsOutOfCombat(): number {
    return this.outOfCombat;
  }

  step(realDt: number, input: HudInput): HudModel {
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    this.outOfCombat = input.inCombat ? 0 : this.outOfCombat + dt;

    const party = input.party.map((p) => slotModel(p, input.switchLock));
    const activeIn = input.party.find((p) => p.active) ?? input.party[0];
    const active = party.find((s) => s.id === activeIn?.id) ?? party[0];

    // Burst ready edge per character: only a fill seen while tracked raises it, so a switch to a full character
    // (already full in the map) lights the glow without the flare, and the first frame never flares.
    const prevFull = this.full;
    const full = new Map<CharacterId, boolean>(party.map((s) => [s.id, s.burstFull]));
    const burstReady = prevFull !== null && active !== undefined && active.burstFull && prevFull.get(active.id) === false;
    this.full = full;
    if (burstReady) this.flareSeq += 1;

    const ranked = rankEnemyBars(input);
    this.barIds = assignPoolSlots(this.barIds, ranked.map((c) => c.enemy.id), HUD_WORLD_BARS.pool);
    const byId = new Map(ranked.map((c) => [c.enemy.id, c]));
    const enemyBars = this.barIds.map((id) => {
      const c = id === null ? undefined : byId.get(id);
      return c === undefined ? null : enemyBarModel(c, input.now);
    });

    const skillRemaining = Math.max(0, activeIn?.skillRemaining ?? 0);
    const skillReady = !(skillRemaining > 1e-6);
    const energy = Math.max(0, activeIn?.energy ?? 0);
    const cost = activeIn?.energyCost ?? 0;
    return {
      combatAlpha: combatFadeAlpha(this.outOfCombat),
      vitals: {
        name: activeIn?.name ?? '',
        level: input.level,
        hp: Math.max(0, Math.ceil(activeIn?.hp ?? 0)),
        maxHp: activeIn?.maxHp ?? 0,
        fraction: active?.hp ?? 0,
        low: active?.low ?? false,
      },
      party,
      abilities: {
        skill: { fraction: active?.skill ?? 0, seconds: skillReady ? 0 : Math.ceil(skillRemaining), ready: skillReady, key: input.skillKey },
        burst: { fraction: fraction(energy, cost), energy: Math.floor(energy), cost, ready: active?.burstFull ?? false, key: input.burstKey },
      },
      burstReady,
      burstFlareSeq: this.flareSeq,
      enemyBars,
    };
  }
}

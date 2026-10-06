// Party_System (design "Party_System", Req 22.1, 22.2, 23.1–23.4, 23.6, 23.8, 27.1–27.3): the fixed slot order,
// joins, per-character HP, switching and Downed. The rules are the pure functions of src/logic/party; this
// runtime owns the sim clock they are asked at, the bus events and the HUD's slot data. Each fixed tick:
// - tick() (before the PlayerController): the clock, every Skill cooldown (standby slots too, Req 23.8),
//   'party:joined' for newly set joined flags, the Downed timer (0.8 s, then the automatic switch or the
//   wipe) and the switch1–switch4 presses judged by canSwitch. A refused press shakes its slot (0.25 s).
// - afterHits() (after the enemy and boss hits): the Active_Character at 0 HP becomes Downed.
// - heal() / restoreHp() / revive() (task 12): the herb dumpling, equipment heals and the Ember Feather; on 'levelUp'
//   everyone is back at the new max HP with Downed cleared (Req 29.2, 27.5, 27.6).
// A switch (manual or automatic) sets GameState.party.active, restarts the 0.8 s lock and calls `onSwitch` in
// the same tick, where the composition root hands the body over and cancels the attack in progress; projectiles
// and placed effects in RuntimeState and enemy Element_Marks are not touched (Req 23.5, 23.6).
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import { CHARACTERS } from '../data/characters';
import type { CharacterId } from '../data/ids';
import type { InputAction } from '../input/actions';
import {
  PARTY_SLOTS, SWITCH_LOCK_SECONDS, canSwitch, isWipe, nextActiveOnDowned,
  type PartyState, type SwitchCheck, type SwitchContext, type SwitchRejectReason,
} from '../logic/party';
import { statsAt } from '../logic/progression';
import type { GameState } from '../logic/save/gameState';
import type { MoveMode } from '../player/core/types';
import type { RuntimeState } from '../save/runtimeState';

/** How long a Downed Active_Character stays down before the automatic switch or the wipe (Req 27.2). */
export const DOWNED_SECONDS = 0.8;
/** How long a refused switch shakes its HUD slot (design HUD "교체 잠금"). */
export const SLOT_SHAKE_SECONDS = 0.25;
/** Switch inputs by slot: switch1 → kairen … switch4 → talus. */
export const SWITCH_ACTIONS = ['switch1', 'switch2', 'switch3', 'switch4'] as const satisfies readonly InputAction[];

/**
 * The sim clock is a float sum of ticks, so 48 ticks of 1/60 s can land a hair under 0.8 s. Timers are judged
 * this much late so the tick that reaches a boundary counts as reaching it.
 */
const CLOCK_EPS = 1e-6;

/** Scene context outside the movement mode. */
export type PartyScene = 'play' | 'dialogue' | 'cinematic';

/** Switch context of a movement mode and scene (Req 23.4): climbing, gliding, swimming, dialogue and cinematics refuse. */
export function switchContextFor(mode: MoveMode, scene: PartyScene = 'play'): SwitchContext {
  if (scene !== 'play') return scene;
  switch (mode) {
    case 'climbAttach':
    case 'climb':
    case 'climbLeap':
    case 'mantle':
      return 'climb';
    case 'glideDeploy':
    case 'glide':
      return 'glide';
    case 'swim':
      return 'swim';
    default:
      return 'free';
  }
}

/** One HUD party slot (task 14.3 draws the full slot; the minimal combat HUD reads these). */
export interface PartySlotView {
  readonly id: CharacterId;
  /** 1–4, the switch key. */
  readonly slot: number;
  readonly name: string;
  readonly joined: boolean;
  readonly downed: boolean;
  readonly active: boolean;
  readonly hp: number;
  readonly maxHp: number;
  /** Remaining Skill cooldown (s). */
  readonly skillCooldown: number;
  /** The slot is shaking after a refused switch. */
  readonly shaking: boolean;
  /** Counts refused switches to this slot, so the HUD can restart the shake. */
  readonly shakeSeq: number;
}

export interface PartySystemOptions {
  bus: GameEventBus;
  /** Joined flags, the Active_Character, current HP, Downed, the party level; the wipe count. */
  state: Pick<GameState, 'party' | 'stats'>;
  /** Skill cooldowns (counted down here) and the switch lock mirror. */
  runtime: Pick<RuntimeState, 'cooldowns' | 'switchLockUntil'>;
  /** Caelith's Phase while the boss fight runs, else null ('party:wipe' payload). */
  bossPhase(): 1 | 2 | 3 | null;
  /** A switch was applied this tick (before 'party:switched' is delivered): hand the body over, cancel actions. */
  onSwitch?(from: CharacterId, to: CharacterId): void;
}

export interface PartyTick {
  dt: number;
  /** This tick's input, or null while input is held (recovery fade, cinematic): no switch presses. */
  input: { pressed(a: InputAction): boolean } | null;
  /** Switch context of the tick (switchContextFor). */
  context: SwitchContext;
}

export class PartySystem {
  private readonly o: PartySystemOptions;
  private time = 0;
  private lastSwitchAt = -Infinity;
  /** Clock time the Active_Character went Downed while the automatic switch is pending, else null. */
  private downedAt: number | null = null;
  private wiped = false;
  /** Joined flags already announced with 'party:joined'. */
  private readonly announced: Set<CharacterId>;
  private readonly shakeUntil = new Map<CharacterId, number>();
  private readonly shakeSeqs = new Map<CharacterId, number>();
  private lastRefusal: { readonly id: CharacterId; readonly reason: SwitchRejectReason } | null = null;

  constructor(options: PartySystemOptions) {
    this.o = options;
    // Joins already in the state (New Game's Kairen, a loaded save) are not announced again.
    this.announced = new Set(options.state.party.joined);
    options.bus.on('levelUp', () => this.levelUpHeal()); // task 12.1: full heal on level-up (Req 29.2)
  }

  /** Seconds this system has ticked (its sim clock). */
  get simTime(): number {
    return this.time;
  }

  get active(): CharacterId {
    return this.o.state.party.active;
  }

  /** Control input is held: the Active_Character is Downed (the 0.8 s fall), or the party was wiped. */
  get inputBlocked(): boolean {
    return this.downedAt !== null || this.wiped;
  }

  /** A wipe was published and not yet answered by restoreAll(). */
  get wipeActive(): boolean {
    return this.wiped;
  }

  /** Seconds left of the 0.8 s switch lock (Req 23.3); 0 when switching is open. */
  get lockRemaining(): number {
    return Math.max(0, this.lastSwitchAt + SWITCH_LOCK_SECONDS - this.time);
  }

  /** The last refused switch and its reason, or null. */
  get lastRejection(): { readonly id: CharacterId; readonly reason: SwitchRejectReason } | null {
    return this.lastRefusal;
  }

  /** Max HP from the character's stats at the party level (no equipment changes max HP, design "장비"). */
  maxHp(id: CharacterId): number {
    return statsAt(CHARACTERS[id].baseStats, this.o.state.party.level).hp;
  }

  /** The party as the logic rules see it. */
  view(): PartyState {
    const { party } = this.o.state;
    const maxHp: Record<CharacterId, number> = { kairen: 0, isla: 0, wren: 0, talus: 0 };
    for (const id of PARTY_SLOTS) maxHp[id] = this.maxHp(id);
    return { joined: party.joined, active: party.active, hp: party.hp, maxHp, downed: party.downed, lastSwitchAt: this.lastSwitchAt };
  }

  /** The four slots in slot order, for the HUD. */
  slots(): PartySlotView[] {
    const { party } = this.o.state;
    return PARTY_SLOTS.map((id, i) => ({
      id,
      slot: i + 1,
      name: CHARACTERS[id].name,
      joined: party.joined.includes(id),
      downed: party.downed.includes(id),
      active: party.active === id,
      hp: party.hp[id],
      maxHp: this.maxHp(id),
      skillCooldown: this.o.runtime.cooldowns[id],
      shaking: this.time < (this.shakeUntil.get(id) ?? -Infinity),
      shakeSeq: this.shakeSeqs.get(id) ?? 0,
    }));
  }

  /**
   * A companion joins (Main_Quest `joinParty`, Req 22.2): the joined flag is set, the companion starts at full
   * HP, and 'party:joined' goes out now. Already joined: nothing.
   */
  join(id: CharacterId): void {
    const { party } = this.o.state;
    if (party.joined.includes(id)) return;
    party.joined.push(id);
    party.hp[id] = this.maxHp(id);
    this.announceJoins();
  }

  /**
   * Switch request for `to` in `context` (switch1–switch4). Refused while input is blocked (as 'downed', the
   * Active_Character is down) or by canSwitch; a refusal shakes the slot and changes nothing else (Req 23.2).
   */
  requestSwitch(to: CharacterId, context: SwitchContext): SwitchCheck {
    const check: SwitchCheck = this.inputBlocked
      ? { ok: false, reason: 'downed' }
      : canSwitch(this.view(), to, this.time + CLOCK_EPS, context);
    if (check.ok) {
      this.switchTo(to);
      return check;
    }
    this.lastRefusal = { id: to, reason: check.reason };
    this.shakeUntil.set(to, this.time + SLOT_SHAKE_SECONDS);
    this.shakeSeqs.set(to, (this.shakeSeqs.get(to) ?? 0) + 1);
    return check;
  }

  /** Start of the fixed tick: clock, cooldowns, joins, the Downed timer, then this tick's switch press. */
  tick(t: PartyTick): void {
    this.time += t.dt;
    const { cooldowns } = this.o.runtime;
    for (const id of PARTY_SLOTS) cooldowns[id] = Math.max(0, cooldowns[id] - t.dt);
    this.announceJoins();
    this.checkDowned();
    if (this.downedAt !== null && this.time - this.downedAt >= DOWNED_SECONDS - CLOCK_EPS) this.resolveDowned();
    if (t.input === null || this.inputBlocked) return;
    const index = SWITCH_ACTIONS.findIndex((a) => t.input?.pressed(a));
    const to = PARTY_SLOTS[index];
    if (to !== undefined) this.requestSwitch(to, t.context);
  }

  /** After this tick's hits: an Active_Character at 0 HP becomes Downed (Req 27.2). */
  afterHits(): void {
    this.checkDowned();
  }

  /**
   * Defeat Screen restart (Req 27.3): every character at full HP, nobody Downed, the wipe answered. The
   * Active_Character, cooldowns and the lock are kept.
   */
  restoreAll(): void {
    const { party } = this.o.state;
    for (const id of PARTY_SLOTS) party.hp[id] = this.maxHp(id);
    party.downed = [];
    this.downedAt = null;
    this.wiped = false;
  }

  // ── Task 12: heals (herb dumpling, Ember Feather, equipment) and the level-up heal ──

  /**
   * Heals joined, living `id` by `pct` × max HP, clamped to max HP (herb dumpling 35 %, Req 27.5; equipment heals).
   * Returns the HP added: 0 for a Downed or unjoined character, during a wipe or at full HP.
   */
  heal(id: CharacterId, pct: number): number {
    return pct > 0 ? this.restoreHp(id, Math.max(1, Math.round(this.maxHp(id) * pct))) : 0;
  }

  /** Adds `amount` HP (whole points) to joined, living `id`, clamped to max HP; returns the HP added. */
  restoreHp(id: CharacterId, amount: number): number {
    const { party } = this.o.state;
    if (this.wiped || !party.joined.includes(id) || party.downed.includes(id) || party.hp[id] <= 0) return 0;
    const add = Number.isFinite(amount) ? Math.floor(amount) : 0;
    const max = this.maxHp(id);
    if (add < 1 || party.hp[id] >= max) return 0;
    const next = Math.min(max, party.hp[id] + add);
    const added = next - party.hp[id];
    party.hp[id] = next;
    return added;
  }

  /**
   * Ember Feather (Req 27.6): a Downed joined `id` stands up at `pct` × max HP. Refused (false) when `id` is not
   * Downed or the party is wiped (the Defeat Screen restores everyone instead). Reviving the Active_Character during
   * its 0.8 s fall cancels the pending automatic switch.
   */
  revive(id: CharacterId, pct: number): boolean {
    const { party } = this.o.state;
    if (this.wiped || !party.joined.includes(id) || !party.downed.includes(id) || !(pct > 0)) return false;
    party.downed = party.downed.filter((d) => d !== id);
    party.hp[id] = Math.max(1, Math.round(this.maxHp(id) * Math.min(1, pct)));
    if (id === party.active) this.downedAt = null;
    return true;
  }

  /** 'levelUp' (Req 29.2): everyone at the new max HP, Downed cleared; nothing while the Defeat Screen is up. */
  private levelUpHeal(): void {
    if (this.wiped) return;
    const { party } = this.o.state;
    for (const id of PARTY_SLOTS) party.hp[id] = this.maxHp(id);
    party.downed = [];
    this.downedAt = null;
  }

  private announceJoins(): void {
    const { party } = this.o.state;
    for (const id of PARTY_SLOTS) {
      if (!party.joined.includes(id) || this.announced.has(id)) continue;
      this.announced.add(id);
      this.o.bus.emit('party:joined', { characterId: id });
    }
  }

  private checkDowned(): void {
    const { party } = this.o.state;
    const id = party.active;
    if (this.wiped || this.downedAt !== null || party.hp[id] > 0) return;
    party.hp[id] = 0;
    if (!party.downed.includes(id)) party.downed.push(id);
    this.downedAt = this.time;
    this.o.bus.emit('party:downed', { characterId: id });
  }

  /** The 0.8 s are up: the automatic switch skipping lock and context, or the wipe (Req 27.2, 27.3). */
  private resolveDowned(): void {
    this.downedAt = null;
    const p = this.view();
    const next = nextActiveOnDowned(p);
    if (next === null || isWipe(p)) {
      this.wiped = true;
      this.o.state.stats.partyWipes += 1;
      this.o.bus.emit('party:wipe', { bossPhase: this.o.bossPhase() });
      return;
    }
    this.switchTo(next);
  }

  private switchTo(to: CharacterId): void {
    const { party } = this.o.state;
    const from = party.active;
    party.active = to;
    this.lastSwitchAt = this.time;
    this.o.runtime.switchLockUntil = this.time + SWITCH_LOCK_SECONDS;
    this.o.onSwitch?.(from, to);
    this.o.bus.emit('party:switched', { from, to });
  }
}

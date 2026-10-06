/*
 * Playthrough bot, fights (task 24.4; design "입력 전용 완주 봇" combat.ts): the headless route bot's melee loop
 * (tests/unit/helpers/routeBot.ts combatTick) on keyboard and mouse. Per frame against the chosen enemy:
 * - an enemy within 3.4 m whose attack has started (its Telegraph showing, or an untelegraphed swing just begun):
 *   face it, back off (S, or on a platform whichever of S / A / D stays nearest its centre) for 0.45 s and Dodge
 *   (RMB) once;
 * - otherwise face the target, close in (W) past 2 m and swing (LMB) within 2.8 m;
 * - Skill (E) when its cooldown is 0 and it suits the character and the footing, Burst (Q) with full Energy, the
 *   heal consumable (Z) under 40 % HP;
 * - a target carrying the Active_Character's own Element_Mark is handed to a companion of another Element (number
 *   key), so the next hit sets off a Reaction; a worn-out Active_Character (< 30 % HP) hands over to the healthiest.
 */
import { angleDelta, yawFromDir } from '../../../src/core/math';
import { PARTY_SLOTS } from '../../../src/logic/party';
import type { Bot } from './bot';
import { ENGAGED_STATES, engagedNear, flat, type Snap, type SnapEnemy, type XZ } from './harness';
import type { MoveKey } from './keys';

export const ELEMENT_OF: Readonly<Record<string, string>> = { kairen: 'ember', isla: 'tide', wren: 'gale', talus: 'terra' };
export const CHARACTER_OF: Readonly<Record<string, string>> = { ember: 'kairen', tide: 'isla', gale: 'wren', terra: 'talus' };

interface CombatState {
  evadeUntil: number;
  evadeKey: MoveKey;
  dodges: number;
  lastSwitch: number;
  lastCharged: number;
  /** A Charged_Attack just applied the Active_Character's Element: a companion follows up (a Reaction). */
  followUp: boolean;
  lastHeal: number;
  lastAbility: number;
  /** Enemy id → wall time its current attack was first seen. */
  attackSeen: Map<string, { attack: string; at: number }>;
  /** Closing in on a target: the best distance so far, when, and the side to go round an obstacle. */
  approach: { id: string; best: number; at: number; side: MoveKey };
}

const states = new WeakMap<Bot, CombatState>();
function stateOf(bot: Bot): CombatState {
  let st = states.get(bot);
  if (st === undefined) {
    st = {
      evadeUntil: 0, evadeKey: 'KeyS', dodges: 0, lastSwitch: 0, lastCharged: 0, followUp: false, lastHeal: 0, lastAbility: 0,
      attackSeen: new Map(), approach: { id: '', best: Infinity, at: 0, side: 'KeyA' },
    };
    states.set(bot, st);
  }
  return st;
}

export interface FightOptions {
  /** A platform's centre: evasion keeps near it and Kairen's dashing Skill / leaping Burst stay unused. */
  anchor?: XZ | null;
  timeoutMs?: number;
}

const share = (p: Snap['party'][number]): number => p.hp / Math.max(1, p.maxHp);
const slotKey = (id: string): string => `Digit${PARTY_SLOTS.indexOf(id as (typeof PARTY_SLOTS)[number]) + 1}`;

/** Switches the Active_Character with its number key and waits for it (a switch is refused mid-air or on a wall). */
export async function switchTo(bot: Bot, label: string, character: string): Promise<Snap> {
  let s = await bot.settle();
  const end = bot.now() + 6000;
  let lastTap = 0;
  while (s.activeCharacter !== character) {
    const member = s.party.find((p) => p.id === character);
    if (member === undefined || !member.joined) throw new Error(`${label}: ${character} has not joined`);
    if (member.downed) throw new Error(`${label}: ${character} is Downed`);
    if (bot.now() > end) throw new Error(`${label}: could not switch to ${character} (active ${s.activeCharacter}) at ${bot.where(s)}`);
    await bot.keys.stop();
    if (bot.now() - lastTap > 350 && s.player.grounded) {
      lastTap = bot.now();
      await bot.keys.tap(slotKey(character));
    }
    s = await bot.frame();
  }
  stateOf(bot).lastSwitch = bot.now();
  return s;
}

/** Tracks when each enemy's current attack started (for untelegraphed swings). */
function trackAttacks(bot: Bot, s: Snap): void {
  const st = stateOf(bot);
  for (const e of s.enemies) {
    if (e.state !== 'attack' || e.attack === null) {
      st.attackSeen.delete(e.id);
      continue;
    }
    const seen = st.attackSeen.get(e.id);
    if (seen === undefined || seen.attack !== e.attack) st.attackSeen.set(e.id, { attack: e.attack, at: bot.now() });
  }
}

/** An enemy within 3.4 m whose attack is about to land, else null. */
function threat(bot: Bot, s: Snap): SnapEnemy | null {
  const st = stateOf(bot);
  for (const e of s.enemies) {
    if (e.state !== 'attack' || e.distance > 3.4 + 1.5 || flat(s.player.pos, e.pos) > 3.4) continue;
    if (e.telegraph !== null) {
      if (e.telegraph > 0.03) return e;
      continue;
    }
    const seen = st.attackSeen.get(e.id);
    if (seen !== undefined && bot.now() - seen.at < 250) return e;
  }
  return null;
}

/** Back (S) on open ground; on a platform the one of S / A / D that stays nearest its centre (camera yaw `yaw`). */
function evadeKey(s: Snap, anchor: XZ | null, yaw: number): MoveKey {
  if (anchor === null) return 'KeyS';
  const sn = Math.sin(yaw);
  const c = Math.cos(yaw);
  const options: [MoveKey, number, number][] = [['KeyS', -sn, -c], ['KeyA', c, -sn], ['KeyD', -c, sn]];
  let best: MoveKey = 'KeyS';
  let bestD = Infinity;
  for (const [key, dx, dz] of options) {
    const d = Math.hypot(s.player.pos.x + dx * 4 - anchor.x, s.player.pos.z + dz * 4 - anchor.z);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return best;
}

/** Under 30 % HP: hand over to the healthiest companion above half of theirs. */
export async function switchIfLow(bot: Bot, s: Snap): Promise<void> {
  const st = stateOf(bot);
  const active = s.party.find((p) => p.active);
  if (active === undefined || share(active) >= 0.3 || bot.now() - st.lastSwitch < 1200 || !s.player.grounded) return;
  let best: Snap['party'][number] | null = null;
  for (const p of s.party) {
    if (p.active || !p.joined || p.downed || share(p) <= 0.5) continue;
    if (best === null || share(p) > share(best)) best = p;
  }
  if (best === null) return;
  st.lastSwitch = bot.now();
  await bot.keys.tap(slotKey(best.id));
}

/**
 * The target carries our own mark (or a Charged_Attack just put it on): a companion of another Element hits next,
 * setting off a Reaction.
 */
async function switchForReaction(bot: Bot, s: Snap, target: SnapEnemy): Promise<boolean> {
  const st = stateOf(bot);
  const mine = ELEMENT_OF[s.activeCharacter];
  const ours = target.mark !== null && target.mark === mine;
  if (!(ours || st.followUp) || bot.now() - st.lastSwitch < (st.followUp ? 600 : 3500) || !s.player.grounded) return false;
  st.followUp = false;
  const order = ['isla', 'kairen', 'talus', 'wren'];
  const next = order
    .map((id) => s.party.find((p) => p.id === id))
    .find((p) => p !== undefined && !p.active && p.joined && !p.downed && share(p) >= 0.4 && ELEMENT_OF[p.id] !== mine);
  if (next === undefined) return false;
  st.lastSwitch = bot.now();
  await bot.keys.tap(slotKey(next.id));
  return true;
}

/**
 * Kairen's plain chain applies Ember only on its 4th hit, which trash rarely survives: with a companion in the party
 * he opens on an unmarked target with a Charged_Attack (Ember), and the companion follows up.
 */
async function chargedOpener(bot: Bot, s: Snap, target: SnapEnemy, d: number): Promise<boolean> {
  const st = stateOf(bot);
  if (s.activeCharacter !== 'kairen' || target.mark !== null || d > 2.6 || bot.now() - st.lastCharged < 3000) return false;
  if (s.party.filter((p) => p.joined && !p.downed).length < 2 || !s.player.grounded || s.player.mode !== 'grounded') return false;
  st.lastCharged = bot.now();
  await bot.keys.stop();
  await bot.keys.charged();
  st.followUp = true;
  return true;
}

/** Skill / Burst / heal when they suit the character, the distance and the footing. */
export async function abilities(bot: Bot, s: Snap, d: number, anchor: XZ | null): Promise<void> {
  const st = stateOf(bot);
  const me = s.party.find((p) => p.active);
  if (me === undefined || !s.player.grounded || bot.now() - st.lastAbility < 700) return;
  if (share(me) < 0.4 && bot.now() - st.lastHeal > 8000) {
    st.lastHeal = bot.now();
    st.lastAbility = bot.now();
    await bot.keys.tap('KeyZ');
    return;
  }
  const id = me.id;
  const open = anchor === null;
  if (me.energy >= me.energyMax && me.energyMax > 0) {
    const ok = id === 'talus' || ((id === 'isla' || id === 'wren') && d < 8) || (id === 'kairen' && open && d < 4.5);
    if (ok) {
      st.lastAbility = bot.now();
      await bot.keys.tap('KeyQ');
      return;
    }
  }
  if (me.skillCooldown <= 0) {
    const ok = id === 'talus' ? d < 4 : id === 'wren' ? d < 4.5 : id === 'kairen' ? open && d < 5 : d > 6 && d < 13;
    if (ok) {
      st.lastAbility = bot.now();
      await bot.keys.tap('KeyE');
    }
  }
}

/**
 * An Element_Shield takes ×0.25 from its own Element and ×3 from a Reaction: against a shield of the Active_Character's
 * Element, or with Kairen (whose plain chain rarely applies Ember), hand over to a companion whose hits apply another
 * Element (Isla's every shot does).
 */
async function switchForShield(bot: Bot, s: Snap, target: SnapEnemy): Promise<boolean> {
  const st = stateOf(bot);
  const shield = target.shield;
  if (shield === null || bot.now() - st.lastSwitch < 2500 || !s.player.grounded) return false;
  const mine = ELEMENT_OF[s.activeCharacter];
  if (mine !== shield && s.activeCharacter !== 'kairen') return false;
  const order = ['isla', 'talus', 'wren', 'kairen'];
  const next = order
    .map((id) => s.party.find((p) => p.id === id))
    .find((p) => p !== undefined && !p.active && p.joined && !p.downed && share(p) >= 0.35 && ELEMENT_OF[p.id] !== shield);
  if (next === undefined || (mine !== shield && next.id === 'kairen')) return false;
  st.lastSwitch = bot.now();
  await bot.keys.tap(slotKey(next.id));
  return true;
}

/** One frame against the enemy at `target`: evade a landing attack, else close in and swing. */
export async function combatTick(bot: Bot, s: Snap, target: SnapEnemy, anchor: XZ | null = null): Promise<void> {
  const st = stateOf(bot);
  trackAttacks(bot, s);
  await switchIfLow(bot, s);
  const now = bot.now();
  if (now < st.evadeUntil) {
    await bot.keys.move([st.evadeKey]);
    if (st.dodges < 2 && s.player.mode !== 'dodge' && !s.player.exhausted) {
      st.dodges++;
      await bot.keys.tap('Mouse2');
    } else if (s.player.mode === 'dodge') st.dodges = 2;
    return;
  }
  const t = threat(bot, s);
  if (t !== null) {
    const yaw = yawFromDir(t.pos.x - s.player.pos.x, t.pos.z - s.player.pos.z);
    await bot.face(yaw);
    st.evadeKey = evadeKey(s, anchor, yaw);
    st.evadeUntil = now + 450;
    st.dodges = 0;
    await bot.keys.move([st.evadeKey]);
    if (!s.player.exhausted) {
      st.dodges = 1;
      await bot.keys.tap('Mouse2');
    }
    return;
  }
  if ((await switchForShield(bot, s, target)) || (await switchForReaction(bot, s, target))) return;
  const d = flat(s.player.pos, target.pos);
  const yaw = yawFromDir(target.pos.x - s.player.pos.x, target.pos.z - s.player.pos.z);
  await bot.face(yaw);
  const aligned = s.camera === null || Math.abs(angleDelta(s.camera.yaw, yaw)) < 0.6;
  if (aligned && (await chargedOpener(bot, s, target, d))) return;
  // Closing in but getting no closer for 1.5 s (a cage, a pillar between): go round it, alternating sides.
  if (st.approach.id !== target.id || d < st.approach.best - 0.3) st.approach = { id: target.id, best: d, at: now, side: st.approach.side };
  if (d > 2.6 && now - st.approach.at > 1500) {
    if (now - st.approach.at > 2400) st.approach = { id: target.id, best: d, at: now, side: st.approach.side === 'KeyA' ? 'KeyD' : 'KeyA' };
    await bot.keys.move(['KeyW', st.approach.side]);
    return;
  }
  await bot.keys.move(d > 2.0 ? ['KeyW'] : []);
  if (d < 2.8 && aligned) await bot.attack();
  await abilities(bot, s, d, anchor);
}

/**
 * A fight that makes no progress: no enemy near the party loses HP and the target gets no closer for 12 s (the party
 * knocked somewhere the enemy cannot reach, or the other way round). The bot then does what a player would:
 * Pause → 끼임 해제 (the latest checkpoint inside a Challenge_Area), at most twice per fight.
 */
class Deadlock {
  private hp = new Map<string, number>();
  private bestD = Infinity;
  private since: number;
  unstucks = 0;

  constructor(private readonly bot: Bot) {
    this.since = bot.now();
  }

  async check(label: string, s: Snap, target: SnapEnemy | null): Promise<void> {
    const now = this.bot.now();
    let progress = false;
    for (const e of s.enemies) {
      const before = this.hp.get(e.id);
      if (before !== undefined && e.hp < before) progress = true;
      this.hp.set(e.id, e.hp);
    }
    const d = target === null ? Infinity : flat(s.player.pos, target.pos);
    // In reach the bot is trading hits (a shield may be taking them without HP changes): that is progress too.
    if (d < 3.5) progress = true;
    if (d < this.bestD - 0.5) {
      this.bestD = d;
      progress = true;
    }
    if (progress || s.inputContext !== 'gameplay') {
      this.since = now;
      if (progress) this.bestD = Math.min(this.bestD, d);
      return;
    }
    if (now - this.since < 12_000) return;
    if (this.unstucks >= 2) throw new Error(`${label}: the fight is stuck (at ${this.bot.where(s)}; ${enemyReport(s)})`);
    this.unstucks++;
    this.bot.hooks?.stall(`${label} (fight)`, s);
    await this.bot.unstuck(label);
    this.since = this.bot.now();
    this.bestD = Infinity;
  }
}

/** Fights until no enemy engages within 20 m. */
export async function fightEngaged(bot: Bot, label: string, anchor: XZ | null = null): Promise<Snap> {
  const end = bot.now() + 120_000;
  const stuck = new Deadlock(bot);
  let s = bot.s;
  for (;;) {
    s = await bot.frame();
    const e = engagedNear(s, 20);
    if (e === null) break;
    if (bot.now() > end) throw new Error(`${label}: fight did not end (at ${bot.where(s)}; ${enemyReport(s)})`);
    await stuck.check(label, s, e);
    await combatTick(bot, s, e, anchor);
  }
  await calm(bot);
  return s;
}

/**
 * Defeats the encounter groups `groups`: until the Objective `objective` has moved on (when given), else until their
 * members have been seen and are all gone. Waits for them to appear (up to 8 s), fights whoever engages first.
 */
export async function fightGroups(
  bot: Bot, label: string, groups: readonly string[], opts: FightOptions & { objective?: string; approach?: XZ } = {},
): Promise<Snap> {
  const anchor = opts.anchor ?? null;
  const end = bot.now() + (opts.timeoutMs ?? 240_000);
  const start = bot.now();
  let seen = false;
  let goneAt: number | null = null;
  const stuck = new Deadlock(bot);
  let s = bot.s;
  for (;;) {
    s = await bot.frame();
    if (opts.objective !== undefined && s.objective?.objectiveId !== opts.objective) break;
    if (bot.now() > end) throw new Error(`${label}: ${groups.join('+')} not defeated in time (at ${bot.where(s)}; ${enemyReport(s)})`);
    const members = s.enemies.filter((e) => e.camp !== null && groups.includes(e.camp));
    if (members.length > 0) {
      seen = true;
      goneAt = null;
    } else if (seen) {
      goneAt ??= bot.now();
      if (opts.objective === undefined && bot.now() - goneAt > 1500) break;
    } else if (opts.objective === undefined && bot.now() - start > 8000) break;
    const target = engagedNear(s, 20) ?? nearest(s, members);
    if (target !== null) await stuck.check(label, s, target);
    if (target === null) {
      if (opts.approach !== undefined && flat(s.player.pos, opts.approach) > 2) {
        await bot.face(yawFromDir(opts.approach.x - s.player.pos.x, opts.approach.z - s.player.pos.z));
        await bot.keys.move(['KeyW']);
      } else await bot.keys.stop();
      continue;
    }
    await combatTick(bot, s, target, anchor);
  }
  await calm(bot);
  return s;
}

function nearest(s: Snap, list: readonly SnapEnemy[]): SnapEnemy | null {
  let best: SnapEnemy | null = null;
  for (const e of list) if (best === null || flat(s.player.pos, e.pos) < flat(s.player.pos, best.pos)) best = e;
  return best;
}

/** After a fight: no evasion left and the buffered presses expired. */
async function calm(bot: Bot): Promise<void> {
  stateOf(bot).evadeUntil = 0;
  await bot.idle(250);
}

/** Living enemies near the character, for failure messages. */
export function enemyReport(s: Snap): string {
  return s.enemies
    .slice(0, 8)
    .map((e) => `${e.kind}${e.camp === null ? '' : `/${e.camp}`}@(${e.pos.x.toFixed(1)},${e.pos.y.toFixed(1)},${e.pos.z.toFixed(1)}) ${e.state} ${e.hp}hp`)
    .join('; ');
}

/** Walks up to `at` and swings the Normal_Attack chain at it until `done` (a puzzle device burning or breaking). */
export async function strike(bot: Bot, label: string, at: XZ, done: (s: Snap) => boolean, reach = 1.9, maxMs = 15_000): Promise<Snap> {
  let s = await bot.settle();
  const end = bot.now() + maxMs;
  while (!done(s)) {
    if (bot.now() > end) throw new Error(`${label}: not done after ${maxMs} ms of attacks (at ${bot.where(s)})`);
    const d = flat(s.player.pos, at);
    const yaw = yawFromDir(at.x - s.player.pos.x, at.z - s.player.pos.z);
    await bot.face(yaw);
    await bot.keys.move(d > reach ? ['KeyW'] : []);
    const aligned = s.camera === null || Math.abs(angleDelta(s.camera.yaw, yaw)) < 0.3;
    if (d <= reach + 0.4 && aligned) await bot.attack();
    s = await bot.frame();
  }
  await calm(bot);
  return s;
}

/** Faces `at` and casts the Skill (E) toward it (it faces the move input as it starts), then waits until `done`. */
export async function castSkill(bot: Bot, label: string, at: XZ, done: (s: Snap) => boolean, maxMs = 5000): Promise<Snap> {
  let s = await bot.settle();
  const yaw = yawFromDir(at.x - s.player.pos.x, at.z - s.player.pos.z);
  for (let i = 0; i < 6 && s.camera !== null && Math.abs(angleDelta(s.camera.yaw, yaw)) > 0.05; i++) {
    await bot.face(yaw);
    s = await bot.frame();
  }
  await bot.keys.move(['KeyW']);
  await bot.keys.tap('KeyE');
  s = await bot.frame();
  await bot.keys.stop();
  const end = bot.now() + maxMs;
  while (!done(s)) {
    if (bot.now() > end) throw new Error(`${label}: not done ${maxMs} ms after the Skill (at ${bot.where(s)})`);
    s = await bot.frame();
  }
  return s;
}

/** Whether any enemy is fighting the party (state-wise) within `range`. */
export function anyEngaged(s: Snap, range = 20): boolean {
  return s.enemies.some((e) => ENGAGED_STATES.has(e.state) && flat(s.player.pos, e.pos) <= range);
}

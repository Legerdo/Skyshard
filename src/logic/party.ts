/*
 * Party rules (design.md "Party_System", Req 22, 23, 27): switching, damage, Downed, auto-switch
 * and wipe. Pure: every function returns a new state and never mutates its input.
 */
import { clamp } from '../core/math';
import type { CharacterId } from '../data/ids';

/** Fixed slot order (switch1–switch4). */
export const PARTY_SLOTS = ['kairen', 'isla', 'wren', 'talus'] as const satisfies readonly CharacterId[];

/** Global lock after any switch, manual or automatic (Req 23.3). */
export const SWITCH_LOCK_SECONDS = 0.8;

export interface PartyState {
  joined: readonly CharacterId[];
  active: CharacterId;
  /** Current HP per character. */
  hp: Record<CharacterId, number>;
  maxHp: Record<CharacterId, number>;
  downed: readonly CharacterId[];
  /** simTime (s) of the last switch; -Infinity before the first one. */
  lastSwitchAt: number;
}

/** Switching is allowed only in 'free' (Req 23.4). */
export type SwitchContext = 'free' | 'climb' | 'glide' | 'swim' | 'dialogue' | 'cinematic';
export type SwitchRejectReason = 'notJoined' | 'downed' | 'active' | 'cooldown' | 'context';
export type SwitchCheck = { ok: true } | { ok: false; reason: SwitchRejectReason };

const reject = (reason: SwitchRejectReason): SwitchCheck => ({ ok: false, reason });

/** Checked in design order: notJoined → downed → active → context → cooldown. */
export function canSwitch(p: PartyState, to: CharacterId, now: number, ctx: SwitchContext): SwitchCheck {
  if (!p.joined.includes(to)) return reject('notJoined');
  if (p.downed.includes(to)) return reject('downed');
  if (to === p.active) return reject('active');
  if (ctx !== 'free') return reject('context');
  if (now - p.lastSwitchAt < SWITCH_LOCK_SECONDS) return reject('cooldown');
  return { ok: true };
}

/**
 * Makes `to` active and restarts the lock. Unchecked on purpose: manual switches go through
 * canSwitch, while the Downed auto-switch skips lock/context but still restarts the lock.
 * Nothing else changes (HP, Downed, and outside the party enemy marks and placed effects).
 */
export function applySwitch(p: PartyState, to: CharacterId, now: number): PartyState {
  return { ...p, active: to, lastSwitchAt: now };
}

/** HP never drops below 0; reaching 0 makes the character Downed. Downed characters take no damage. */
export function applyDamage(p: PartyState, id: CharacterId, amount: number): PartyState {
  if (p.downed.includes(id)) return p;
  const hp = Math.max(0, p.hp[id] - (amount > 0 ? amount : 0));
  return {
    ...p,
    hp: { ...p.hp, [id]: hp },
    downed: hp === 0 ? [...p.downed, id] : p.downed,
  };
}

/**
 * Auto-switch target: the first joined, non-Downed character in the slots after the active one,
 * wrapping around (the active slot itself comes last); null when there is none.
 */
export function nextActiveOnDowned(p: PartyState): CharacterId | null {
  const start = PARTY_SLOTS.indexOf(p.active);
  for (let i = 1; i <= PARTY_SLOTS.length; i++) {
    const id = PARTY_SLOTS[(start + i) % PARTY_SLOTS.length];
    if (p.joined.includes(id) && !p.downed.includes(id)) return id;
  }
  return null;
}

/** Every joined character is Downed (Req 27.3); an empty roster is not a wipe. */
export function isWipe(p: PartyState): boolean {
  return p.joined.length > 0 && p.joined.every((id) => p.downed.includes(id));
}

/** Revives a Downed character at `pct` (0–1) of max HP, e.g. 0.3 for an Ember Feather (Req 27.6). */
export function revive(p: PartyState, id: CharacterId, pct: number): PartyState {
  const hp = p.maxHp[id] * clamp(pct, 0, 1);
  if (!p.downed.includes(id) || !(hp > 0)) return p;
  return { ...p, hp: { ...p.hp, [id]: hp }, downed: p.downed.filter((d) => d !== id) };
}

/** Full restore (Waystone, respawn): everyone at max HP, nobody Downed. */
export function healAll(p: PartyState): PartyState {
  return { ...p, hp: { ...p.maxHp }, downed: [] };
}

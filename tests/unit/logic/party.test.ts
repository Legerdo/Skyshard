import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../../../src/data/ids';
import {
  PARTY_SLOTS, SWITCH_LOCK_SECONDS, applyDamage, applySwitch, canSwitch, healAll, isWipe, nextActiveOnDowned, revive,
  type PartyState, type SwitchContext,
} from '../../../src/logic/party';

const perSlot = (value: number): Record<CharacterId, number> => ({ kairen: value, isla: value, wren: value, talus: value });

function party(overrides: Partial<PartyState> = {}): PartyState {
  return { joined: PARTY_SLOTS, active: 'kairen', hp: perSlot(1000), maxHp: perSlot(1000), downed: [], lastSwitchAt: -Infinity, ...overrides };
}

/** Knocks each listed character to 0 HP. */
const down = (p: PartyState, ...ids: CharacterId[]): PartyState => ids.reduce((acc, id) => applyDamage(acc, id, Infinity), p);

describe('canSwitch', () => {
  it('allows a joined, standing, inactive target in free context before any switch', () => {
    expect(PARTY_SLOTS).toEqual(['kairen', 'isla', 'wren', 'talus']);
    expect(SWITCH_LOCK_SECONDS).toBe(0.8);
    expect(canSwitch(party(), 'isla', 0, 'free')).toEqual({ ok: true });
  });

  it('rejects with each reason', () => {
    expect(canSwitch(party({ joined: ['kairen', 'isla'] }), 'wren', 0, 'free')).toEqual({ ok: false, reason: 'notJoined' });
    expect(canSwitch(down(party(), 'isla'), 'isla', 0, 'free')).toEqual({ ok: false, reason: 'downed' });
    expect(canSwitch(party(), 'kairen', 0, 'free')).toEqual({ ok: false, reason: 'active' });
    for (const ctx of ['climb', 'glide', 'swim', 'dialogue', 'cinematic'] satisfies SwitchContext[]) {
      expect(canSwitch(party(), 'isla', 0, ctx), ctx).toEqual({ ok: false, reason: 'context' });
    }
    expect(canSwitch(party({ lastSwitchAt: 5 }), 'isla', 5.5, 'free')).toEqual({ ok: false, reason: 'cooldown' });
  });

  it('checks notJoined → downed → active → context → cooldown', () => {
    const busy = down(party({ joined: ['kairen', 'isla'], lastSwitchAt: 0 }), 'isla');
    expect(canSwitch(busy, 'wren', 0.1, 'climb')).toEqual({ ok: false, reason: 'notJoined' });
    expect(canSwitch(busy, 'isla', 0.1, 'climb')).toEqual({ ok: false, reason: 'downed' });
    expect(canSwitch(busy, 'kairen', 0.1, 'climb')).toEqual({ ok: false, reason: 'active' });
    expect(canSwitch(party({ lastSwitchAt: 0 }), 'isla', 0.1, 'glide')).toEqual({ ok: false, reason: 'context' });
  });

  it('locks switching for 0.8 s after applySwitch (0.79 s rejected, 0.81 s allowed)', () => {
    const p = applySwitch(party(), 'isla', 10);
    expect(canSwitch(p, 'wren', 10.79, 'free')).toEqual({ ok: false, reason: 'cooldown' });
    expect(canSwitch(p, 'wren', 10.81, 'free')).toEqual({ ok: true });
  });

  it('applySwitch changes only active and lastSwitchAt and leaves its input intact', () => {
    const before = down(applyDamage(party(), 'kairen', 300), 'talus');
    const snapshot = structuredClone(before);
    const after = applySwitch(before, 'wren', 3);
    expect(after).toEqual({ ...snapshot, active: 'wren', lastSwitchAt: 3 });
    expect(after.hp).toBe(before.hp);
    expect(before).toEqual(snapshot);
  });
});

describe('applyDamage', () => {
  it('lowers HP, clamps at 0 and marks the character Downed at 0', () => {
    const hurt = applyDamage(party(), 'kairen', 400);
    expect(hurt).toMatchObject({ hp: { kairen: 600 }, downed: [] });
    const floored = applyDamage(hurt, 'kairen', 5000);
    expect(floored).toMatchObject({ hp: { kairen: 0 }, downed: ['kairen'] });
    expect(applyDamage(floored, 'kairen', 10)).toBe(floored);
    expect(applyDamage(party(), 'wren', 1000).downed).toEqual(['wren']);
    expect(applyDamage(hurt, 'isla', -50).hp.isla).toBe(1000);
  });
});

describe('nextActiveOnDowned and isWipe', () => {
  it('picks the next standing joined slot after the active one, wrapping around', () => {
    expect(nextActiveOnDowned(down(party({ active: 'isla' }), 'isla'))).toBe('wren');
    expect(nextActiveOnDowned(down(party({ active: 'talus' }), 'talus'))).toBe('kairen');
    expect(nextActiveOnDowned(down(party({ active: 'isla' }), 'isla', 'wren'))).toBe('talus');
    const trio = party({ joined: ['kairen', 'isla', 'talus'], active: 'isla' });
    expect(nextActiveOnDowned(down(trio, 'isla'))).toBe('talus');
    expect(nextActiveOnDowned(down(trio, 'isla', 'talus'))).toBe('kairen');
  });

  it('returns null and reports a wipe only when every joined character is Downed', () => {
    const one = down(party({ joined: ['kairen', 'wren'], active: 'wren' }), 'wren');
    expect([nextActiveOnDowned(one), isWipe(one)]).toEqual(['kairen', false]);
    const both = down(one, 'kairen');
    expect([nextActiveOnDowned(both), isWipe(both)]).toEqual([null, true]);
    expect(isWipe(party({ joined: [] }))).toBe(false);
  });
});

describe('revive and healAll', () => {
  it('revives only Downed characters at a share of max HP', () => {
    const p = down(party({ maxHp: { ...perSlot(1000), isla: 800 } }), 'isla');
    const up = revive(p, 'isla', 0.3);
    expect(up.hp.isla).toBeCloseTo(240, 9);
    expect(up.downed).toEqual([]);
    expect(revive(p, 'kairen', 0.3)).toBe(p);
  });

  it('healAll restores max HP and clears Downed', () => {
    const p = down(applyDamage(party(), 'kairen', 300), 'talus', 'isla');
    expect(healAll(p)).toMatchObject({ hp: perSlot(1000), downed: [] });
  });
});

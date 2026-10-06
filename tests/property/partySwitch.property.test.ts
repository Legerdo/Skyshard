// Feature: skyshard-echoes-of-the-wild, Property 16: 파티 교체 규칙
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ELEMENT_IDS } from '../../src/data/ids';
import {
  PARTY_SLOTS,
  SWITCH_LOCK_SECONDS,
  applySwitch,
  canSwitch,
  type PartyState,
  type SwitchContext,
  type SwitchRejectReason,
} from '../../src/logic/party';

const CONTEXTS: SwitchContext[] = ['free', 'climb', 'glide', 'swim', 'dialogue', 'cinematic'];
const ORDER: readonly SwitchRejectReason[] = ['notJoined', 'downed', 'active', 'context', 'cooldown'];

const arbHp = fc.integer({ min: 1, max: 5000 });
/** arbPartyState: joined subset, active among joined, Downed subset of joined at 0 HP, last switch time. */
const arbParty: fc.Arbitrary<PartyState> = fc
  .subarray([...PARTY_SLOTS], { minLength: 1 })
  .chain((joined) =>
    fc.record({
      joined: fc.constant(joined),
      active: fc.constantFrom(...joined),
      downed: fc.subarray(joined),
      maxHp: fc.record({ kairen: arbHp, isla: arbHp, wren: arbHp, talus: arbHp }),
      lastSwitchAt: fc.oneof(fc.constant(-Infinity), fc.double({ min: 0, max: 1000, noNaN: true })),
    }),
  )
  .map((p) => {
    const hp = { ...p.maxHp };
    for (const id of p.downed) hp[id] = 0;
    return { ...p, hp };
  });
/** Seconds since the last switch, dense around the 0.8 s lock. */
const arbElapsed = fc.oneof(fc.double({ min: 0, max: 2, noNaN: true }), fc.constantFrom(0, 0.79, 0.8, 0.81));
const nowOf = (p: PartyState, elapsed: number): number => (Number.isFinite(p.lastSwitchAt) ? p.lastSwitchAt : 0) + elapsed;

/** Enemy Element_Marks and placed effects: opaque to the party rules, carried alongside the party. */
const arbMarks = fc.array(
  fc.record({ enemy: fc.string({ maxLength: 6 }), element: fc.constantFrom(...ELEMENT_IDS), remaining: fc.double({ min: 0, max: 12, noNaN: true }) }),
  { maxLength: 6 },
);
const arbEffects = fc.array(
  fc.record({ kind: fc.constantFrom('pillar', 'arrowRain', 'vortex'), owner: fc.constantFrom(...PARTY_SLOTS), atk: arbHp }),
  { maxLength: 4 },
);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('Property 16: party switch rules', () => {
  it('rejects exactly when a rule is broken, reporting the first reason in design order', () => {
    fc.assert(
      fc.property(arbParty, fc.constantFrom(...PARTY_SLOTS), arbElapsed, fc.constantFrom(...CONTEXTS), (p, to, elapsed, ctx) => {
        const now = nowOf(p, elapsed);
        const broken: Record<SwitchRejectReason, boolean> = {
          notJoined: !p.joined.includes(to),
          downed: p.downed.includes(to),
          active: p.active === to,
          context: ctx !== 'free',
          cooldown: now - p.lastSwitchAt < SWITCH_LOCK_SECONDS,
        };
        const first = ORDER.find((reason) => broken[reason]);
        expect(canSwitch(p, to, now, ctx)).toEqual(first === undefined ? { ok: true } : { ok: false, reason: first });
      }),
      { numRuns: 200 },
    );
  });

  it('applying a switch leaves enemy marks, placed effects and all other party data unchanged', () => {
    fc.assert(
      fc.property(arbParty, fc.constantFrom(...PARTY_SLOTS), arbElapsed, arbMarks, arbEffects, (p, to, elapsed, marks, effects) => {
        const now = nowOf(p, elapsed);
        const world = deepFreeze({ party: p, marks, effects });
        const before = structuredClone(world);
        const after = { ...world, party: applySwitch(world.party, to, now) };
        expect(after.marks).toBe(world.marks);
        expect(after.effects).toBe(world.effects);
        expect(after).toEqual({ ...before, party: { ...before.party, active: to, lastSwitchAt: now } });
        expect(world).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});

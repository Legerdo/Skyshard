// Feature: skyshard-echoes-of-the-wild, Property 17: Downed 자동 교체와 전멸 판정
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CharacterId } from '../../src/data/ids';
import {
  PARTY_SLOTS,
  applyDamage,
  applySwitch,
  healAll,
  isWipe,
  nextActiveOnDowned,
  revive,
  type PartyState,
} from '../../src/logic/party';

type HpChange =
  | { kind: 'hitActive'; amount: number }
  | { kind: 'damage'; id: CharacterId; amount: number }
  | { kind: 'revive'; id: CharacterId; pct: number }
  | { kind: 'healAll' };

const arbHp = fc.integer({ min: 1, max: 3000 });
const arbSlot = fc.constantFrom(...PARTY_SLOTS);
const arbAmount = fc.oneof(fc.integer({ min: 0, max: 2000 }), fc.constant(Infinity));
/**
 * arbPartyState start: joined subset, active among joined, a Downed subset of the other joined
 * characters at 0 HP, everyone else at 1..max HP, and a last switch time.
 */
const arbStart: fc.Arbitrary<PartyState> = fc
  .subarray([...PARTY_SLOTS], { minLength: 1 })
  .chain((joined) => fc.record({ joined: fc.constant(joined), active: fc.constantFrom(...joined) }))
  .chain(({ joined, active }) =>
    fc.record({
      joined: fc.constant(joined),
      active: fc.constant(active),
      downed: fc.subarray(joined.filter((id) => id !== active)),
      maxHp: fc.record({ kairen: arbHp, isla: arbHp, wren: arbHp, talus: arbHp }),
      hpRatio: fc.record({
        kairen: fc.double({ min: 0, max: 1, noNaN: true }),
        isla: fc.double({ min: 0, max: 1, noNaN: true }),
        wren: fc.double({ min: 0, max: 1, noNaN: true }),
        talus: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      lastSwitchAt: fc.oneof(fc.constant(-Infinity), fc.double({ min: 0, max: 1000, noNaN: true })),
    }),
  )
  .map(({ hpRatio, ...p }) => {
    const hp = { ...p.maxHp };
    for (const id of PARTY_SLOTS) {
      hp[id] = p.downed.includes(id) ? 0 : Math.max(1, Math.round(p.maxHp[id] * hpRatio[id]));
    }
    return { ...p, hp };
  });
/** HP change sequence. */
const arbChanges: fc.Arbitrary<HpChange[]> = fc.array(
  fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant('hitActive' as const), amount: arbAmount }), weight: 5 },
    { arbitrary: fc.record({ kind: fc.constant('damage' as const), id: arbSlot, amount: arbAmount }), weight: 3 },
    { arbitrary: fc.record({ kind: fc.constant('revive' as const), id: arbSlot, pct: fc.double({ min: 0.05, max: 1, noNaN: true }) }), weight: 2 },
    { arbitrary: fc.constant({ kind: 'healAll' as const }), weight: 1 },
  ),
  { maxLength: 60 },
);

/** Reference: first joined, non-Downed character in the slots after the active one, wrapping; else null. */
function expectedNext(p: PartyState): CharacterId | null {
  const i = PARTY_SLOTS.indexOf(p.active);
  const order = [...PARTY_SLOTS.slice(i + 1), ...PARTY_SLOTS.slice(0, i)];
  return order.find((id) => p.joined.includes(id) && !p.downed.includes(id)) ?? null;
}

function applyChange(p: PartyState, c: HpChange): PartyState {
  if (c.kind === 'hitActive') return applyDamage(p, p.active, c.amount);
  if (c.kind === 'damage') return applyDamage(p, c.id, c.amount);
  return c.kind === 'revive' ? revive(p, c.id, c.pct) : healAll(p);
}

describe('Property 17: Downed auto-switch and wipe', () => {
  it('HP 0 means Downed, the auto-switch scans the slots after the active one, and wipe means all joined are Downed', () => {
    let switches = 0;
    let wipes = 0;
    fc.assert(
      fc.property(arbStart, arbChanges, (start, changes) => {
        let p = start;
        const hp = { ...start.hp }; // independent HP model
        changes.forEach((c, t) => {
          const target = c.kind === 'hitActive' ? p.active : c.kind === 'healAll' ? null : c.id;
          if (c.kind === 'healAll') Object.assign(hp, start.maxHp);
          else if (c.kind === 'revive' && target !== null && hp[target] === 0) hp[target] = start.maxHp[target] * c.pct;
          else if (c.kind !== 'revive' && target !== null && hp[target] > 0) hp[target] = Math.max(0, hp[target] - c.amount);
          p = applyChange(p, c);

          expect(p.hp).toEqual(hp);
          for (const id of PARTY_SLOTS) expect(p.downed.includes(id), id).toBe(hp[id] === 0);
          expect(new Set(p.downed).size).toBe(p.downed.length);
          expect(isWipe(p)).toBe(p.joined.every((id) => hp[id] === 0));
          if (!p.downed.includes(p.active)) return;

          const next = nextActiveOnDowned(p);
          expect(next).toBe(expectedNext(p));
          expect(next === null).toBe(isWipe(p));
          if (next !== null) {
            p = applySwitch(p, next, t);
            switches++;
          } else {
            p = healAll(p); // respawn after the Defeat Screen
            Object.assign(hp, start.maxHp);
            wipes++;
          }
        });
      }),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: sequences must reach both outcomes.
    expect(switches).toBeGreaterThan(50);
    expect(wipes).toBeGreaterThan(20);
  });
});

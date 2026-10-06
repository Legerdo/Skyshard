// Feature: skyshard-echoes-of-the-wild, Property 25: 키 재지정 전단사
/*
 * Validates: Requirements 35.3. For any bijective bindings `b` and any sequence of remap requests (reserved and
 * fixed codes including Escape, codes outside the supported list, keys another action already uses, free keys),
 * applying `remapBinding` step by step always leaves an action ↔ input bijection. An accepted request puts `code`
 * on `action`, gives the previous owner (`swappedWith`) the old `b[action]` and leaves every other action alone;
 * reserved / fixed codes are always refused as 'reserved' and unknown codes as 'unknown', with the bindings and
 * the argument `b` unchanged.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REMAPPABLE_ACTIONS, type RemappableAction } from '../../src/input/actions';
import {
  FIXED_INPUTS,
  KNOWN_CODES,
  RESERVED_CODES,
  buildCodeMap,
  isValidBindings,
  remapBinding,
  type Bindings,
  type InputCode,
} from '../../src/input/bindings';

/** Codes an action may hold: supported and not reserved. */
const ASSIGNABLE: readonly InputCode[] = [...KNOWN_CODES].filter((code) => !RESERVED_CODES.has(code));
const RESERVED: readonly InputCode[] = [...RESERVED_CODES];
/** Codes outside the supported list: extra mouse buttons, gamepad codes, odd browser codes, wrong casing. */
const UNKNOWN_SAMPLES: readonly InputCode[] = [
  'Mouse3',
  'Mouse4',
  'Unidentified',
  'PadA',
  'PadB',
  'Lang1',
  'F13',
  'keyw',
  'Key',
  '',
  'IntlRo',
  'MediaPlayPause',
];

/** One request: a literal code (tagged by kind for the checks) or the code another action holds at that step. */
type Target =
  | { readonly kind: 'free' | 'reserved' | 'unknown'; readonly code: InputCode }
  | { readonly kind: 'taken'; readonly from: RemappableAction };

interface Request {
  readonly action: RemappableAction;
  readonly target: Target;
}

/** Any bijection: REMAPPABLE_ACTIONS.length distinct assignable codes in random order. */
const arbBijection: fc.Arbitrary<Bindings> = fc
  .shuffledSubarray([...ASSIGNABLE], { minLength: REMAPPABLE_ACTIONS.length, maxLength: REMAPPABLE_ACTIONS.length })
  .map((codes) => {
    const b = {} as Bindings;
    REMAPPABLE_ACTIONS.forEach((action, i) => {
      b[action] = codes[i];
    });
    return b;
  });

const arbUnknownCode: fc.Arbitrary<InputCode> = fc.oneof(
  fc.constantFrom(...UNKNOWN_SAMPLES),
  fc.string({ maxLength: 12 }).filter((code) => !KNOWN_CODES.has(code)),
);

const arbTarget: fc.Arbitrary<Target> = fc.oneof(
  { arbitrary: fc.constantFrom(...ASSIGNABLE).map((code): Target => ({ kind: 'free', code })), weight: 3 },
  { arbitrary: fc.constantFrom(...REMAPPABLE_ACTIONS).map((from): Target => ({ kind: 'taken', from })), weight: 3 },
  // Escape listed twice so it comes up often (the remap flow's cancel key must never become a binding).
  { arbitrary: fc.constantFrom('Escape', ...RESERVED).map((code): Target => ({ kind: 'reserved', code })), weight: 2 },
  { arbitrary: arbUnknownCode.map((code): Target => ({ kind: 'unknown', code })), weight: 2 },
);

/** arbBindingsOps: a starting bijection and a sequence of remap requests over it. */
const arbBindingsOps = fc.record({
  b: arbBijection,
  ops: fc.array(fc.record({ action: fc.constantFrom(...REMAPPABLE_ACTIONS), target: arbTarget }), {
    minLength: 1,
    maxLength: 40,
  }),
});

/** Action ↔ input bijection: every action holds an assignable code, no code serves two actions. */
function expectBijection(b: Readonly<Bindings>): void {
  expect(isValidBindings(b)).toBe(true);
  const owner = new Map<InputCode, RemappableAction>();
  for (const action of REMAPPABLE_ACTIONS) {
    expect(owner.has(b[action]), `${b[action]} bound twice`).toBe(false);
    owner.set(b[action], action);
  }
  expect(owner.size).toBe(REMAPPABLE_ACTIONS.length);
  // The live code map resolves each bound code to exactly its one remappable action.
  const map = buildCodeMap(b);
  const remappable = new Set<string>(REMAPPABLE_ACTIONS);
  for (const action of REMAPPABLE_ACTIONS) {
    expect(map.get(b[action])?.filter((a) => remappable.has(a))).toEqual([action]);
  }
}

describe('Property 25: key remap bijection', () => {
  it('reserved and fixed codes are exactly the design list (Escape included)', () => {
    const fixed = ['Escape', 'F3', 'Mouse1', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const shortcuts = ['F5', 'F11', 'Tab', 'AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'];
    expect(new Set(RESERVED)).toEqual(new Set([...fixed, ...shortcuts]));
    // Every fixed input is reserved except the ShiftRight sprint, a secondary that yields to a binding.
    for (const [code] of FIXED_INPUTS) expect(RESERVED_CODES.has(code) || code === 'ShiftRight', code).toBe(true);
  });

  it('keeps a bijection, swaps with the previous owner and refuses reserved / unknown codes without change', () => {
    const seen = { swap: 0, plain: 0, reserved: 0, escape: 0, unknown: 0 };
    fc.assert(
      fc.property(arbBindingsOps, ({ b: start, ops }) => {
        expectBijection(start);
        let b: Readonly<Bindings> = Object.freeze({ ...start });
        for (const { action, target } of ops) {
          const code = target.kind === 'taken' ? b[target.from] : target.code;
          const before: Bindings = { ...b };
          const result = remapBinding(b, action, code);
          expect(b).toEqual(before); // pure: the argument is never modified (it is frozen as well)

          if (target.kind === 'reserved') {
            expect(result).toEqual({ ok: false, reason: 'reserved' });
            seen.reserved++;
            if (code === 'Escape') seen.escape++;
            continue; // the bindings stay as they were
          }
          if (target.kind === 'unknown') {
            expect(result).toEqual({ ok: false, reason: 'unknown' });
            seen.unknown++;
            continue;
          }
          if (!result.ok) throw new Error(`${action} → ${code} refused as ${result.reason}`);

          const next = result.bindings;
          expect(next).not.toBe(b);
          expect(next[action]).toBe(code);
          const owner = REMAPPABLE_ACTIONS.find((other) => other !== action && before[other] === code) ?? null;
          expect(result.swappedWith).toBe(owner);
          if (owner !== null) expect(next[owner]).toBe(before[action]);
          for (const other of REMAPPABLE_ACTIONS) {
            if (other !== action && other !== owner) expect(next[other], other).toBe(before[other]);
          }
          expectBijection(next);
          if (owner !== null) seen.swap++;
          else seen.plain++;
          b = Object.freeze(next);
        }
      }),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: every kind of request must actually occur.
    expect(seen.swap).toBeGreaterThan(100);
    expect(seen.plain).toBeGreaterThan(100);
    expect(seen.reserved).toBeGreaterThan(100);
    expect(seen.escape).toBeGreaterThan(10);
    expect(seen.unknown).toBeGreaterThan(100);
  });
});

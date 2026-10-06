import { describe, expect, it } from 'vitest';
import { ELEMENT_DEFS, ELEMENT_LIST } from '../../src/data/elements';
import { ELEMENT_IDS, type ElementId, type ReactionId } from '../../src/data/ids';
import { MARK_DURATION, REACTION_DEFS, terraInvolved } from '../../src/data/reactions';
import {
  SHIELD_BREAK_STAGGER, absorbWithShield, adoptTarget, applyElementTo, createElementStatus, grantReactionShield,
  isBreakStaggered, markModifiers, strikeShield, tickEmberDot, type MarkSource,
} from '../../src/element/elementRuntime';
import { computeDamage } from '../../src/logic/damage';
import {
  activeMark, applyElement, damageShield, emptyTarget, previewReaction, reactionFor, type ElementTarget,
} from '../../src/logic/element';

const marked = (element: ElementId, at = 0): ElementTarget => applyElement(emptyTarget(), element, at).next;
const shielded = (element: ElementId, durability = 100): ElementTarget =>
  ({ ...emptyTarget(), shield: { element, durability, max: 100 } });
/** Deep-freezes a target so any write by the code under test throws (ES modules are strict). */
const frozen = (t: ElementTarget): ElementTarget => {
  [t.mark, t.shield, t.lastReactionAt].forEach((part) => Object.freeze(part));
  return Object.freeze(t);
};

// Table B (requirements.md), restated independently of src/data/reactions.
const TABLE_B: Array<[ElementId, ElementId, ReactionId]> = [
  ['ember', 'tide', 'steamBurst'],
  ['ember', 'terra', 'lavaRift'],
  ['tide', 'terra', 'mudBind'],
  ['gale', 'ember', 'flameSpread'],
  ['gale', 'tide', 'mistSpread'],
  ['gale', 'terra', 'sandGust'],
];

describe('table B reactions', () => {
  it.each(TABLE_B)('%s + %s → %s in both orders', (a, b, r) => {
    expect(reactionFor(a, b)).toBe(r);
    expect(reactionFor(b, a)).toBe(r);
    expect([reactionFor(a, a), reactionFor(b, b)]).toEqual([null, null]);
    expect([...REACTION_DEFS[r].pair].sort()).toEqual([a, b].sort());
    expect(REACTION_DEFS[r].spreads).toBe(a === 'gale' ? b : null);
    expect(terraInvolved(r)).toBe(a === 'terra' || b === 'terra');
    for (const [held, applied] of [[a, b], [b, a]] as const) {
      const out = applyElement(frozen(marked(held)), applied, 2);
      expect(out).toMatchObject({ kind: 'reaction', reaction: r, consumed: held });
      expect(out.next).toEqual({ mark: null, shield: null, lastReactionAt: { [r]: 2 } });
    }
  });
});

describe('element display data', () => {
  it('gives every Element its own icon shape and colour (Req 25.1)', () => {
    expect(ELEMENT_LIST.map((d) => d.id)).toEqual([...ELEMENT_IDS]);
    expect(new Set(ELEMENT_LIST.map((d) => d.icon)).size).toBe(4);
    expect(new Set(ELEMENT_LIST.map((d) => d.color)).size).toBe(4);
    expect(ELEMENT_LIST.map((d) => d.iconLabel)).toEqual(['세 갈래 불꽃', '겹친 물결 원', '나선', '육각 결정']);
    expect(ELEMENT_DEFS.ember.cssColor).toBe('#ff7a45');
  });
});

describe('Element_Mark', () => {
  it('lasts 8 s: active until just before expiresAt, gone at it, after which another element just marks', () => {
    const t = frozen(marked('ember'));
    expect(t.mark).toEqual({ element: 'ember', expiresAt: MARK_DURATION });
    expect(activeMark(t, 7.99)).toEqual(t.mark);
    expect(applyElement(t, 'tide', 7.99).kind).toBe('reaction');
    expect(activeMark(t, 8)).toBeNull();
    const late = applyElement(t, 'tide', 8);
    expect(late.kind).toBe('marked');
    expect(late.next.mark).toEqual({ element: 'tide', expiresAt: 8 + MARK_DURATION });
  });

  it('re-applying the same element refreshes the mark to now + 8 without a reaction', () => {
    const out = applyElement(frozen(marked('tide')), 'tide', 5);
    expect(out.kind).toBe('refreshed');
    expect(out.next).toEqual({ ...emptyTarget(), mark: { element: 'tide', expiresAt: 5 + MARK_DURATION } });
  });
});

describe('Element_Shield', () => {
  it('same element hits at ×0.25 without a reaction; another element reacts at ×3.0 and keeps the shield', () => {
    const t = frozen(shielded('ember'));
    const same = applyElement(t, 'ember', 0);
    expect(same).toMatchObject({ kind: 'shieldHit', reaction: null, shieldMul: 0.25 });
    expect(same.next).toEqual(t);
    const other = applyElement(t, 'tide', 0);
    expect(other).toMatchObject({ kind: 'shieldHit', reaction: 'steamBurst', shieldMul: 3 });
    expect(other.next).toEqual({ mark: null, shield: t.shield, lastReactionAt: { steamBurst: 0 } });
  });

  it('damageShield breaks exactly when durability reaches 0, after which the target takes marks', () => {
    const chipped = damageShield(frozen(shielded('terra')), 30);
    expect(chipped).toEqual({ next: shielded('terra', 70), broken: false });
    const broken = damageShield(frozen(chipped.next), 70);
    expect(broken).toEqual({ next: emptyTarget(), broken: true });
    expect(applyElement(broken.next, 'ember', 1).kind).toBe('marked');
  });

  it('a broken shield staggers for 3 s, released exactly at break time + 3 s', () => {
    const s = createElementStatus({ element: 'gale', max: 100 });
    expect(strikeShield(s, 60, 10)).toEqual({ absorbed: 60, broken: false });
    expect(isBreakStaggered(s, 10)).toBe(false);
    expect(strikeShield(s, 55, 12)).toEqual({ absorbed: 40, broken: true });
    expect(s.element.shield).toBeNull();
    expect(SHIELD_BREAK_STAGGER).toBe(3);
    expect(isBreakStaggered(s, 12)).toBe(true);
    expect(isBreakStaggered(s, 14.999)).toBe(true);
    expect(isBreakStaggered(s, 15)).toBe(false);
    // No shield left: further strikes absorb nothing and do not restart the Stagger.
    expect(strikeShield(s, 10, 13)).toEqual({ absorbed: 0, broken: false });
    expect(s.breakStaggerUntil).toBe(15);
  });
});

describe('rate limit and previewReaction', () => {
  it('limits a repeat of the same reaction within 1 s, keeping the existing mark', () => {
    const first = applyElement(marked('ember'), 'tide', 0);
    const remarked = frozen(applyElement(first.next, 'ember', 0.2).next);
    const early = applyElement(remarked, 'tide', 0.5);
    expect(early).toMatchObject({ kind: 'limited', reaction: 'steamBurst' });
    expect(early.next).toEqual(remarked);
    expect(applyElement(early.next, 'tide', 1)).toMatchObject({ kind: 'reaction', reaction: 'steamBurst' });
  });

  it('previews only a reaction that would really occur, without changing the target', () => {
    const t = frozen({ ...marked('terra'), lastReactionAt: { mudBind: 0.8 } });
    expect(previewReaction(t, 'tide', 1)).toBeNull(); // limited
    expect(previewReaction(t, 'tide', 1.8)).toBe('mudBind');
    expect(previewReaction(t, 'terra', 1)).toBeNull();
    expect(previewReaction(t, 'tide', MARK_DURATION)).toBeNull();
    const guarded = frozen({ ...shielded('gale'), mark: { element: 'tide', expiresAt: 8 } });
    expect(previewReaction(guarded, 'ember', 0)).toBe('flameSpread');
    expect(previewReaction(guarded, 'gale', 0)).toBeNull();
  });
});

describe('mark effects', () => {
  const kairen: MarkSource = { baseAtk: 120, level: 1, equipAtkPct: 0 };

  it('Tide slows 20%, Gale adds 50% knockback, Terra adds 50% stagger; nothing once expired', () => {
    expect(markModifiers(marked('tide'), 1)).toEqual({ moveSpeedMul: 0.8, knockbackMul: 1, staggerMul: 1 });
    expect(markModifiers(marked('gale'), 1)).toEqual({ moveSpeedMul: 1, knockbackMul: 1.5, staggerMul: 1 });
    expect(markModifiers(marked('terra'), 1)).toEqual({ moveSpeedMul: 1, knockbackMul: 1, staggerMul: 1.5 });
    expect(markModifiers(marked('ember'), 1)).toEqual({ moveSpeedMul: 1, knockbackMul: 1, staggerMul: 1 });
    expect(markModifiers(marked('tide'), MARK_DURATION)).toEqual({ moveSpeedMul: 1, knockbackMul: 1, staggerMul: 1 });
  });

  it('Ember deals 5% of the applier ATK each second until the mark ends', () => {
    const tick = computeDamage({
      ...kairen, dmgMul: 0.05, abilityUpgradePct: 0, equipDmgPct: 0, def: 0, critChance: 0, rng01: 0, kind: 'dot',
    }).amount;
    expect(tick).toBe(6);
    const s = createElementStatus();
    applyElementTo(s, 'ember', kairen, 0);
    expect(tickEmberDot(s, 0, 0.99)).toBe(0);
    expect(tickEmberDot(s, 0, 1)).toBe(tick);
    expect(tickEmberDot(s, 0, 3.5)).toBe(2 * tick); // 2 s and 3 s
    expect(tickEmberDot(s, 0, 20)).toBe(4 * tick); // 4–7 s; at 8 s the mark is gone
    expect(s.emberDot).toBeNull();
  });

  it('Ember damage stops when the mark is consumed and needs a character source', () => {
    const s = createElementStatus();
    applyElementTo(s, 'ember', kairen, 0);
    expect(applyElementTo(s, 'tide', kairen, 0.5).kind).toBe('reaction');
    expect(s.emberDot).toBeNull();
    expect(tickEmberDot(s, 0, 5)).toBe(0);
    const env = createElementStatus();
    applyElementTo(env, 'ember', null, 0);
    expect(env.emberDot).toBeNull();
    // A mark handed over by resolveSpread is adopted the same way.
    const spread = createElementStatus();
    adoptTarget(spread, marked('ember', 2), kairen, 2);
    expect(spread.emberDot).toEqual({ source: kairen, nextTickAt: 3 });
  });
});

describe('Terra reaction shield', () => {
  it('gives 8% max HP for 5 s on Terra reactions only, refreshing without stacking', () => {
    expect(grantReactionShield(null, 'steamBurst', 1000, 0)).toBeNull();
    const first = grantReactionShield(null, 'lavaRift', 1000, 0);
    expect(first).toEqual({ amount: 80, until: 5 });
    // A chain in the same frame and a repeat 2 s later: still one 80-point shield, the 5 s restart.
    expect(grantReactionShield(first, 'sandGust', 1000, 0)).toEqual({ amount: 80, until: 5 });
    const chipped = absorbWithShield(first, 50, 1);
    expect(chipped).toEqual({ shield: { amount: 30, until: 5 }, damage: 0 });
    expect(grantReactionShield(chipped.shield, 'mudBind', 1000, 2)).toEqual({ amount: 80, until: 7 });
    expect(grantReactionShield(first, 'flameSpread', 1000, 2)).toEqual(first);
    expect(grantReactionShield(first, 'flameSpread', 1000, 5)).toBeNull(); // expired at exactly 5 s
  });

  it('absorbs damage before HP and disappears when used up or expired', () => {
    const shield = { amount: 80, until: 5 };
    expect(absorbWithShield(shield, 100, 1)).toEqual({ shield: null, damage: 20 });
    expect(absorbWithShield(shield, 30, 5)).toEqual({ shield: null, damage: 30 });
    expect(absorbWithShield(null, 30, 0)).toEqual({ shield: null, damage: 30 });
  });
});

it('applyElement returns fresh objects for every outcome and never mutates the input', () => {
  const limited = { ...marked('ember'), lastReactionAt: { steamBurst: 0.5 } };
  for (const t of [emptyTarget(), marked('ember'), shielded('tide'), limited].map(frozen)) {
    for (const e of ELEMENT_IDS) {
      const { next } = applyElement(t, e, 1);
      expect(next).not.toBe(t);
      expect(next.lastReactionAt).not.toBe(t.lastReactionAt);
      if (next.mark !== null) expect(next.mark).not.toBe(t.mark);
      if (next.shield !== null) expect(next.shield).not.toBe(t.shield);
    }
  }
});

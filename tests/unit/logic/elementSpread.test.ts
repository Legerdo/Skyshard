import { describe, expect, it } from 'vitest';
import type { ElementId, ReactionId } from '../../../src/data/ids';
import { MARK_DURATION } from '../../../src/data/reactions';
import {
  MAX_CHAIN_DEPTH, applyElement, emptyTarget, resolveSpread, type ElementTarget, type SpreadTarget,
} from '../../../src/logic/element';

const NOW = 10;
const ORIGIN = { x: 0, y: 0, z: 0 };
const marked = (el: ElementId): ElementTarget => applyElement(emptyTarget(), el, NOW - 1).next;
const shielded = (el: ElementId): ElementTarget =>
  ({ ...emptyTarget(), shield: { element: el, durability: 100, max: 100 } });
const enemy = (id: string, [x, y, z]: [number, number, number], element = emptyTarget(), alive = true): SpreadTarget =>
  ({ id, pos: { x, y, z }, element, alive });
const find = (ts: readonly SpreadTarget[], id: string): SpreadTarget | undefined => ts.find((t) => t.id === id);

describe('resolveSpread', () => {
  it('flameSpread from an ember-marked target marks nearby unmarked enemies with ember, not one 6 m away', () => {
    const targets = [
      enemy('src', [0, 0, 0], marked('ember')),
      enemy('far', [6, 0, 0]),
      enemy('a', [2, 0, 0]),
      enemy('b', [0, 3, 4]), // exactly 5 m (3D)
    ];
    const snapshot = structuredClone(targets);
    const res = resolveSpread(targets, 'src', 'gale', NOW);
    expect(res.reactions).toEqual([{ reaction: 'flameSpread', targetId: 'src', position: ORIGIN, chainDepth: 1 }]);
    expect(res.applied).toEqual([{ targetId: 'a', element: 'ember' }, { targetId: 'b', element: 'ember' }]);
    expect(res.chainCount).toBe(1);
    for (const id of ['a', 'b']) {
      expect(find(res.targets, id)?.element.mark).toEqual({ element: 'ember', expiresAt: NOW + MARK_DURATION });
    }
    expect(find(res.targets, 'src')?.element.mark).toBeNull();
    expect(res.targets[1]).toBe(targets[1]); // untouched target returned as is
    expect(targets).toEqual(snapshot); // input not mutated
  });

  it('a receiver holding a different mark reacts at once (ember on tide → steamBurst, chainDepth 2)', () => {
    const targets = [enemy('src', [0, 0, 0], marked('ember')), enemy('wet', [3, 0, 0], marked('tide'))];
    const res = resolveSpread(targets, 'src', 'gale', NOW);
    expect(res.reactions).toEqual([
      { reaction: 'flameSpread', targetId: 'src', position: ORIGIN, chainDepth: 1 },
      { reaction: 'steamBurst', targetId: 'wet', position: { x: 3, y: 0, z: 0 }, chainDepth: 2 },
    ]);
    expect(res.applied).toEqual([{ targetId: 'wet', element: 'ember' }]);
    expect(res.chainCount).toBe(2);
    expect(find(res.targets, 'wet')?.element.mark).toBeNull();
  });

  it('a chain along a line of alternating gale marks and gale shields stops after depth 4', () => {
    // 4 m spacing: each enemy reaches only its neighbours.
    const line = [
      enemy('e0', [0, 0, 0], marked('ember')),
      ...[1, 2, 3, 4, 5].map((i) => enemy(`e${i}`, [4 * i, 0, 0], i % 2 === 1 ? marked('gale') : shielded('gale'))),
    ];
    const res = resolveSpread(line, 'e0', 'gale', NOW);
    expect(res.reactions.map((r) => [r.reaction, r.targetId, r.chainDepth])).toEqual([
      ['flameSpread', 'e0', 1],
      ['flameSpread', 'e1', 2],
      ['flameSpread', 'e2', 3],
      ['flameSpread', 'e3', 4],
    ]);
    expect(res.chainCount).toBe(MAX_CHAIN_DEPTH);
    expect(find(res.targets, 'e2')?.element.shield?.element).toBe('gale');
    // The depth-4 spread from e3 goes no further: e4 and e5 are untouched.
    expect(res.targets[4]).toBe(line[4]);
    expect(res.targets[5]).toBe(line[5]);
  });

  it('ignores dead targets, both as receivers and as the trigger', () => {
    const targets = [
      enemy('src', [0, 0, 0], marked('ember')),
      enemy('ghost', [1, 0, 0], marked('gale'), false),
      enemy('live', [2, 0, 0]),
    ];
    const res = resolveSpread(targets, 'src', 'gale', NOW);
    expect(res.applied).toEqual([{ targetId: 'live', element: 'ember' }]);
    expect(res.reactions.map((r) => r.targetId)).toEqual(['src']);
    expect(res.targets[1]).toBe(targets[1]);
    const none = { targets, reactions: [], applied: [], chainCount: 0 };
    expect(resolveSpread(targets, 'ghost', 'ember', NOW)).toEqual(none);
    expect(resolveSpread(targets, 'missing', 'ember', NOW)).toEqual(none);
  });

  it.each<[ElementId, ElementId, ReactionId]>([
    ['ember', 'tide', 'steamBurst'],
    ['terra', 'ember', 'lavaRift'],
    ['tide', 'terra', 'mudBind'],
  ])('a non-spread reaction (%s mark + %s → %s) applies nothing to neighbours', (held, el, reaction) => {
    const targets = [enemy('src', [0, 0, 0], marked(held)), enemy('near', [1, 0, 0], marked('gale'))];
    const res = resolveSpread(targets, 'src', el, NOW);
    expect(res.reactions).toEqual([{ reaction, targetId: 'src', position: ORIGIN, chainDepth: 1 }]);
    expect(res.applied).toEqual([]);
    expect(res.chainCount).toBe(1);
    expect(res.targets[1]).toBe(targets[1]);
  });

  it('a reaction on an Element_Shield spreads too (tide on a gale shield → mistSpread spreads tide)', () => {
    const targets = [enemy('boss', [0, 0, 0], shielded('gale')), enemy('add', [0, 0, 2])];
    const res = resolveSpread(targets, 'boss', 'tide', NOW);
    expect(res.reactions.map((r) => r.reaction)).toEqual(['mistSpread']);
    expect(res.applied).toEqual([{ targetId: 'add', element: 'tide' }]);
    expect(find(res.targets, 'boss')?.element.shield?.element).toBe('gale');
  });
});

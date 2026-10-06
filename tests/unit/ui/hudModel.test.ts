import { describe, expect, it } from 'vitest';
import type { CharacterId, EntityId, ElementId } from '../../../src/data/ids';
import { ENEMY_DEFS } from '../../../src/data/enemies';
import { MARK_DURATION } from '../../../src/data/reactions';
import { HUD_WORLD_BARS } from '../../../src/ui/hudLayout';
import {
  assignPoolSlots, combatFadeAlpha, HudModelTracker, rankEnemyBars, wantsEnemyBar,
  type HudEnemyInput, type HudInput, type HudPartyInput,
} from '../../../src/ui/hudModel';

// Task 14.3 (design "표시 규칙" / "적·보스 표시", Req 32.2, 32.3, 32.5, 32.7, 25.2): the HUD's view model rules.

const ORDER: readonly CharacterId[] = ['kairen', 'isla', 'wren', 'talus'];
const ELEMENT: Record<CharacterId, ElementId> = { kairen: 'ember', isla: 'tide', wren: 'gale', talus: 'terra' };

function member(id: CharacterId, over: Partial<HudPartyInput> = {}): HudPartyInput {
  return {
    id, slot: ORDER.indexOf(id) + 1, name: id, element: ELEMENT[id], joined: true, downed: false, active: id === 'kairen',
    hp: 100, maxHp: 100, skillRemaining: 0, skillCooldown: 8, energy: 0, energyCost: 60, shakeSeq: 0, preview: null, ...over,
  };
}

function enemy(id: string, over: Partial<HudEnemyInput> = {}): HudEnemyInput {
  const pos = over.pos ?? { x: 0, y: 0, z: 10 };
  return {
    id: id as EntityId, def: 'bramblekin', hp: 50, maxHp: 100, state: 'chase', element: { mark: null, shield: null },
    pos, prevPos: pos, ...over,
  };
}

function input(over: Partial<HudInput> = {}): HudInput {
  return {
    inCombat: false, level: 3, party: ORDER.map((id) => member(id)), switchLock: 0, skillKey: 'E', burstKey: 'Q',
    enemies: [], lockTarget: null, now: 0, camera: { x: 0, y: 0, z: 0 }, alpha: 1, ...over,
  };
}

describe('out-of-combat fade (Req 32.3)', () => {
  it('holds 100 % until 4.7 s, then fades over 0.3 s to 50 % at 5 s', () => {
    expect(combatFadeAlpha(0)).toBe(1);
    expect(combatFadeAlpha(4.7)).toBe(1);
    expect(combatFadeAlpha(4.85)).toBeCloseTo(0.75, 6);
    expect(combatFadeAlpha(5)).toBeCloseTo(0.5, 6);
    expect(combatFadeAlpha(60)).toBeCloseTo(0.5, 6);
  });

  it('the tracker counts real seconds outside In_Combat and snaps back to 100 % in combat', () => {
    const t = new HudModelTracker();
    let m = t.step(0, input());
    for (let i = 0; i < 50; i++) m = t.step(0.1, input());
    expect(m.combatAlpha).toBeCloseTo(0.5, 6);
    m = t.step(0.1, input({ inCombat: true }));
    expect(m.combatAlpha).toBe(1);
    expect(t.secondsOutOfCombat).toBe(0);
    m = t.step(4.6, input());
    expect(m.combatAlpha).toBe(1);
  });
});

describe('Burst ready (Req 32.7)', () => {
  it('raises burstReady on the frame Energy reaches the cost, once, and keeps the glow while full', () => {
    const t = new HudModelTracker();
    const at = (energy: number) => input({ party: ORDER.map((id) => member(id, id === 'kairen' ? { energy } : {})) });
    expect(t.step(0.016, at(0)).burstReady).toBe(false);
    expect(t.step(0.016, at(30)).burstReady).toBe(false);
    const full = t.step(0.016, at(60));
    expect(full.burstReady).toBe(true);
    expect(full.abilities.burst.ready).toBe(true);
    expect(full.burstFlareSeq).toBe(1);
    const next = t.step(0.016, at(60));
    expect(next.burstReady).toBe(false);
    expect(next.abilities.burst.ready).toBe(true);
    expect(next.burstFlareSeq).toBe(1);
  });

  it('never flares on the first frame or when switching to a character who is already full', () => {
    const t = new HudModelTracker();
    const party = (active: CharacterId) => ORDER.map((id) => member(id, { active: id === active, energy: id === 'isla' ? 60 : 0 }));
    expect(t.step(0.016, input({ party: party('kairen') })).burstReady).toBe(false);
    const switched = t.step(0.016, input({ party: party('isla') }));
    expect(switched.burstReady).toBe(false);
    expect(switched.abilities.burst.ready).toBe(true);
  });
});

describe('party slots (Req 32.2, 23.3, 23.9)', () => {
  it('derives the slot state, Skill sweep, Burst star, switch lock and preview', () => {
    const t = new HudModelTracker();
    const m = t.step(0.016, input({
      switchLock: 0.5,
      party: [
        member('kairen', { skillRemaining: 2, skillCooldown: 8, hp: 20 }),
        member('isla', { preview: 'steamBurst', energy: 60 }),
        member('wren', { downed: true, hp: 0, preview: 'steamBurst' }),
        member('talus', { joined: false }),
      ],
    }));
    const [k, i, w, ta] = m.party;
    expect(k).toMatchObject({ state: 'active', skill: 0.25, low: true, lock: 0, preview: null });
    expect(i).toMatchObject({ state: 'standby', burstFull: true, lock: 0.5, preview: 'steamBurst' });
    expect(w).toMatchObject({ state: 'downed', lock: 0, preview: null });
    expect(ta).toMatchObject({ state: 'empty', hp: 0, burstFull: false });
    expect(m.vitals).toMatchObject({ name: 'kairen', level: 3, hp: 20, maxHp: 100, low: true });
    expect(m.abilities.skill).toMatchObject({ fraction: 0.25, seconds: 2, ready: false, key: 'E' });
  });
});

describe('enemy HP bars (Req 32.5, 25.2)', () => {
  it('shows living enemies that are hurt, have a damaged shield, or are the Lock-on target', () => {
    expect(wantsEnemyBar(enemy('a', { hp: 100 }), null)).toBe(false);
    expect(wantsEnemyBar(enemy('a', { hp: 99 }), null)).toBe(true);
    expect(wantsEnemyBar(enemy('a', { hp: 100 }), 'a' as EntityId)).toBe(true);
    expect(wantsEnemyBar(enemy('a', { hp: 0 }), 'a' as EntityId)).toBe(false);
    expect(wantsEnemyBar(enemy('a', { hp: 50, state: 'dead' }), null)).toBe(false);
    expect(wantsEnemyBar(enemy('a', { hp: 100, element: { mark: null, shield: { element: 'tide', durability: 3, max: 4 } } }), null)).toBe(true);
  });

  it('fills the 12-bar pool with the Lock-on target first, then the nearest', () => {
    const enemies = Array.from({ length: 15 }, (_, i) => enemy(`e${i}`, { pos: { x: 0, y: 0, z: 5 + i } }));
    const ranked = rankEnemyBars({ enemies, lockTarget: 'e14' as EntityId, camera: { x: 0, y: 0, z: 0 }, alpha: 1 });
    expect(ranked).toHaveLength(HUD_WORLD_BARS.pool);
    expect(ranked.map((c) => c.enemy.id)).toEqual(['e14', ...Array.from({ length: 11 }, (_, i) => `e${i}`)]);
  });

  it('keeps an enemy in the same pool slot while it stays shown', () => {
    const a = assignPoolSlots<string>([null, null, null], ['x', 'y'], 3);
    expect(a).toEqual(['x', 'y', null]);
    const b = assignPoolSlots(a, ['z', 'y'], 3);
    expect(b).toEqual(['z', 'y', null]);
    const c = assignPoolSlots(b, ['w', 'y', 'z', 'v'], 3);
    expect(c).toEqual(['z', 'y', 'w']);
  });

  it('draws the mark with its 8 s ring, the shield Element without a ring, and Elite names', () => {
    const t = new HudModelTracker();
    const marked = enemy('m', { element: { mark: { element: 'ember', expiresAt: 6 }, shield: null } });
    const shielded = enemy('s', { pos: { x: 0, y: 0, z: 12 }, element: { mark: { element: 'ember', expiresAt: 6 }, shield: { element: 'tide', durability: 1, max: 4 } } });
    const elite = enemy('el', { def: 'emberjaw', pos: { x: 0, y: 0, z: 14 } });
    const m = t.step(0.016, input({ enemies: [marked, shielded, elite], now: 2, inCombat: true }));
    const bars = m.enemyBars.filter((b) => b !== null);
    expect(m.enemyBars).toHaveLength(HUD_WORLD_BARS.pool);
    const byId = new Map(bars.map((b) => [b.id, b]));
    expect(byId.get('m' as EntityId)?.mark).toEqual({ element: 'ember', ring: 4 / MARK_DURATION });
    expect(byId.get('s' as EntityId)?.mark).toEqual({ element: 'tide', ring: null });
    expect(byId.get('s' as EntityId)?.shield).toEqual({ element: 'tide', fraction: 0.25 });
    expect(byId.get('el' as EntityId)).toMatchObject({ elite: true, name: ENEMY_DEFS.emberjaw.name });
    expect(ENEMY_DEFS.emberjaw.name.length).toBeGreaterThan(0);
    expect(byId.get('m' as EntityId)).toMatchObject({ elite: false, name: '' });
    // An expired mark disappears.
    const later = t.step(0.016, input({ enemies: [marked], now: 7 }));
    expect(later.enemyBars.find((b) => b?.id === 'm')?.mark).toBeNull();
  });
});

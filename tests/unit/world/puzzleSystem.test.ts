import { describe, expect, it } from 'vitest';
import { judgeShape, type Attacker } from '../../../src/combat/attackRuntime';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import type { HitEvent } from '../../../src/data/combatTypes';
import type { ElementId } from '../../../src/data/ids';
import type { PuzzleDef } from '../../../src/data/puzzles';
import { ReceiverField } from '../../../src/element/receiverField';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { ColliderIdSource } from '../../../src/physics/colliderIds';
import type { Collider } from '../../../src/physics/types';
import { PuzzleSystem, type PuzzlePartView } from '../../../src/world/puzzleSystem';

// Puzzle_Mechanism scene adapter over the real ReceiverField and hit judgement (design "Puzzle_Mechanism 규칙";
// Req 13.1–13.7, 2.6), with the open-world puzzle data on flat ground.

const DT = 1 / 60;
const TOUCH: HitEvent = {
  t: 0, shape: { kind: 'sphere', radius: 0.6, offset: { x: 0, y: 1, z: 0 } }, dmgMul: 1, appliesElement: true, poise: 10, knockback: 0, energy: null,
};

function setup(options: { solved?: string[]; defs?: readonly PuzzleDef[] } = {}) {
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const gs = createNewGameState(1);
  gs.world.puzzles.push(...(options.solved ?? []));
  const solid = new Set<number>();
  const world = {
    upsertDynamic: (c: Collider): boolean => {
      solid.add(c.id);
      return true;
    },
    removeDynamic: (id: number): boolean => solid.delete(id),
  };
  const granted: string[] = [];
  const hints: string[] = [];
  const holder: { system: PuzzleSystem | null } = { system: null };
  const field = new ReceiverField({
    onSignal: (s) => holder.system?.deviceSignal(s),
    onPlate: (part, change) => holder.system?.plate(part, change),
  });
  const puzzles = new PuzzleSystem({
    bus, state: gs, field, world, ids: new ColliderIdSource(), heightAt: () => 0,
    rewards: {
      grantXp: (n) => granted.push(`xp ${n}`),
      addGlim: (n) => granted.push(`glim ${n}`),
      grant: (id, count, source) => granted.push(`${id} ×${count} (${source})`),
    },
    hint: (id, text) => hints.push(`${id}: ${text}`),
    defs: options.defs,
  });
  holder.system = puzzles;
  const part = (id: string): PuzzlePartView => {
    for (const v of puzzles.views()) for (const p of v.parts) if (p.id === id) return p;
    throw new Error(`no part ${id}`);
  };
  /** One fixed tick of the field and the puzzles, then EventDispatch. */
  const tick = (weights: { id: string; pos: Vec3 }[] = []): void => {
    field.tick(DT, [], weights);
    puzzles.tick(null);
    bus.dispatch();
  };
  /** An attack touching one part, carrying `element` (null: a Charged_Attack without one). */
  const hit = (partId: string, element: ElementId | null, kind: Attacker['kind'] = 'normal'): void => {
    const attacker: Attacker = {
      id: 'player', origin: { pos: { ...part(partId).pos }, yaw: 0 },
      stats: { baseAtk: 100, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind, element, elementSource: 'kairen', roll: () => 0.5,
    };
    judgeShape('atk_kairen_test', 0, TOUCH, attacker, field.hitTargets(), new Set());
    bus.dispatch();
  };
  const puzzleEvents = (): { type: GameEventName; payload: unknown }[] => {
    const out = events.filter((e) => e.type.startsWith('puzzle:') || e.type === 'save:request');
    events.length = 0;
    return out;
  };
  const isSolid = (partId: string): boolean => puzzles.bodySolid(partId);
  return { gs, field, puzzles, part, tick, hit, puzzleEvents, isSolid, granted, hints, solid };
}

describe('PuzzleSystem', () => {
  it('pz_verdant_1: each lit brazier is progress in the same tick; the third solves, records and saves, then input stops', () => {
    const s = setup();
    s.hit('pz_verdant_1_brazier_b', 'ember');
    expect(s.puzzleEvents()).toEqual([{ type: 'puzzle:progress', payload: { puzzleId: 'pz_verdant_1', step: 1, total: 3 } }]);
    expect([s.part('pz_verdant_1_brazier_b').active, s.part('pz_verdant_1_brazier_b').state]).toEqual([true, 'lit']);
    expect(s.part('pz_verdant_1_brazier_b').element).toBe('ember');
    s.hit('pz_verdant_1_brazier_a', 'ember');
    s.hit('pz_verdant_1_brazier_c', 'ember');
    expect(s.puzzleEvents()).toEqual([
      { type: 'puzzle:progress', payload: { puzzleId: 'pz_verdant_1', step: 2, total: 3 } },
      { type: 'puzzle:solved', payload: { puzzleId: 'pz_verdant_1', regionId: 'verdant' } },
      { type: 'save:request', payload: { reason: 'puzzle' } },
    ]);
    expect(s.gs.world.puzzles).toEqual(['pz_verdant_1']);
    expect([s.puzzles.isSolved('pz_verdant_1'), s.puzzles.isOpen('chest_pz_verdant_1')]).toEqual([true, true]);
    s.hit('pz_verdant_1_brazier_a', 'tide');
    s.tick();
    expect(s.puzzleEvents()).toEqual([]);
    expect(s.gs.world.puzzles).toEqual(['pz_verdant_1']);
  });

  it('pz_azure_1: out of order resets the chimes, a wrong Element and a timeout also fail, the 3rd failure shows the hint, and it can be retried', () => {
    const s = setup();
    s.hit('pz_azure_1_chime_1', 'gale');
    expect(s.puzzles.views().find((v) => v.id === 'pz_azure_1')?.timeLeft).toBe(1);
    s.hit('pz_azure_1_chime_3', 'gale');
    expect(s.puzzleEvents().map((e) => e.payload)).toEqual([
      { puzzleId: 'pz_azure_1', step: 1, total: 3 },
      { puzzleId: 'pz_azure_1', failures: 1, cause: 'order' },
    ]);
    expect(['chime_1', 'chime_3'].map((c) => s.part(`pz_azure_1_${c}`).state)).toEqual(['still', 'still']); // back at once
    expect(s.puzzles.runtime('pz_azure_1')).toMatchObject({ step: 0, active: [], startedAt: null });
    s.hit('pz_azure_1_chime_1', 'tide'); // a chime takes Gale only
    expect(s.puzzleEvents().map((e) => e.payload)).toEqual([{ puzzleId: 'pz_azure_1', failures: 2, cause: 'rejected' }]);
    expect(s.hints).toEqual([]);
    s.hit('pz_azure_1_chime_1', 'gale');
    for (let i = 0; i < 15.05 / DT; i++) s.tick();
    expect(s.puzzleEvents().map((e) => e.payload)).toEqual([
      { puzzleId: 'pz_azure_1', step: 1, total: 3 },
      { puzzleId: 'pz_azure_1', failures: 3, cause: 'timeout' },
    ]);
    expect(s.hints).toEqual(['pz_azure_1: 기둥의 홈 수 1·2·3 순서로 15초 안에 Gale을 울리자.']);
    expect(s.part('pz_azure_1_chime_1').state).toBe('still');
    for (const c of ['chime_1', 'chime_2', 'chime_3']) {
      s.hit(`pz_azure_1_${c}`, 'gale');
      s.tick();
    }
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:progress', 'puzzle:progress', 'puzzle:solved', 'save:request']);
    expect(s.gs.world.puzzles).toEqual(['pz_azure_1']);
  });

  it('pz_azure_2: plates follow the weights on them; both held solves it and the shortcut stays open; hits on plates are no input', () => {
    const s = setup();
    const a = s.part('pz_azure_2_plate_a').pos;
    const b = s.part('pz_azure_2_plate_b').pos;
    s.hit('pz_azure_2_plate_a', 'terra');
    s.tick([{ id: 'player', pos: a }]);
    expect(s.puzzleEvents()).toEqual([{ type: 'puzzle:progress', payload: { puzzleId: 'pz_azure_2', step: 1, total: 2 } }]);
    expect(s.puzzles.isOpen('shortcut_vista_azure')).toBe(false);
    s.tick([]);
    expect(s.puzzles.runtime('pz_azure_2')?.active).toEqual([]);
    s.tick([{ id: 'player', pos: a }, { id: 'pillar', pos: b }]);
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:progress', 'puzzle:solved', 'save:request']);
    s.tick([]);
    expect([s.puzzles.isSolved('pz_azure_2'), s.puzzles.isOpen('shortcut_vista_azure'), s.puzzleEvents()]).toEqual([true, true, []]);
  });

  it('pz_ember_1 / pz_ember_2: the crystal door opens on its solve and stays cooled; the Unstable_Crystal wall stands until its blast', () => {
    const s = setup();
    expect([s.isSolid('pz_ember_1_door'), s.isSolid('pz_ember_2_wall')]).toEqual([true, true]);
    s.hit('pz_ember_1_door', 'ember');
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:failed']);
    s.hit('pz_ember_1_door', 'tide');
    s.tick();
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:solved', 'save:request']);
    expect([s.isSolid('pz_ember_1_door'), s.part('pz_ember_1_door').present]).toEqual([false, false]);
    for (let i = 0; i < 11 / DT; i++) s.tick();
    expect(s.part('pz_ember_1_door').state).toBe('cooled'); // not warming up after 10 s

    s.hit('pz_ember_2_wall', 'ember');
    s.tick();
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:solved', 'save:request']);
    expect([s.isSolid('pz_ember_2_wall'), s.part('pz_ember_2_wall').telegraph > 0]).toEqual([true, true]);
    for (let i = 0; i < 1.05 / DT; i++) s.tick();
    expect([s.part('pz_ember_2_wall').state, s.isSolid('pz_ember_2_wall'), s.puzzles.isOpen('den_emberjaw')]).toEqual(['exploded', false, true]);
    expect(s.isSolid('pz_verdant_1_brazier_a')).toBe(true); // braziers stay solid
  });

  it('a load places solved puzzles solved: parts in their done state, doors gone, no events, no more input', () => {
    const s = setup({ solved: ['pz_verdant_1', 'pz_ember_1', 'pz_ember_2'] });
    expect(s.part('pz_verdant_1_brazier_a').state).toBe('lit');
    expect([s.part('pz_ember_1_door').state, s.isSolid('pz_ember_1_door')]).toEqual(['cooled', false]);
    expect([s.part('pz_ember_2_wall').state, s.isSolid('pz_ember_2_wall')]).toEqual(['exploded', false]);
    s.hit('pz_verdant_1_brazier_a', 'ember');
    s.hit('pz_ember_1_door', 'ember');
    s.tick();
    expect(s.puzzleEvents()).toEqual([]);
    expect(s.puzzles.views().filter((v) => v.solved).map((v) => [v.id, v.solvedAgo])).toEqual([
      ['pz_verdant_1', null], ['pz_ember_1', null], ['pz_ember_2', null],
    ]);
  });

  it('grants a RewardRef on the solve', () => {
    const def: PuzzleDef = {
      id: 'pz_verdant_9', name: '시험 바람개비', region: 'verdant', kind: 'single',
      parts: [{ id: 'pz_verdant_9_wheel', device: 'windWheel', name: '바람개비', pos: { x: 0, z: 0 }, radius: 0.5, height: 2.6 }],
      hint: '바람으로 돌리자.',
      reward: { xp: 40, glim: 120, items: [{ id: 'con_herbDumpling', count: 2 }] },
    };
    const s = setup({ defs: [def] });
    s.hit('pz_verdant_9_wheel', 'gale');
    expect(s.granted).toEqual(['xp 40', 'glim 120', 'con_herbDumpling ×2 (puzzle)']);
    expect(s.puzzleEvents().map((e) => e.type)).toEqual(['puzzle:solved', 'save:request']);
  });
});

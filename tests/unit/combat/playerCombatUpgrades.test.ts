// Echo Altar tiers and equipment in PlayerCombat (tasks 12.3, 12.4; Req 29.5, 30.1, 30.3).
import { describe, expect, it } from 'vitest';
import type { HitReceiver, ResolvedHit } from '../../../src/combat/attackRuntime';
import { PlayerCombat, type CombatBody, type CombatEquipment } from '../../../src/combat/playerCombat';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import { CHARACTERS } from '../../../src/data/characters';
import type { CharacterId } from '../../../src/data/ids';
import { NO_MODIFIERS, equipModifiers } from '../../../src/logic/equipment';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';

const DT = 1 / 60;
const tap = (code: string): RawInput[] => [{ kind: 'down', code, time: 0 }, { kind: 'up', code, time: 0 }];

class Body implements CombatBody {
  state: ControllerState = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  face(yaw: number): void {
    this.state = { ...this.state, yaw };
  }
}

type Dummy = HitReceiver & { hits: ResolvedHit[] };

/** A DEF 0 target `z` m ahead that records the hits it takes. */
function dummy(id: string, z: number): Dummy {
  const hits: ResolvedHit[] = [];
  return {
    id,
    hits,
    hurtVolume: () => ({ pos: { x: 0, y: 0, z }, radius: 0.4, height: 1.8 }),
    immune: () => false,
    sample: () => ({ def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: (hit) => hits.push(hit),
  };
}

interface Opts {
  character?: CharacterId;
  tier?: number;
  gear?: CombatEquipment;
  targets?: HitReceiver[];
}

function setup(opts: Opts = {}) {
  const bus = createGameEventBus();
  const input = new InputState();
  const body = new Body();
  const cooldowns = { kairen: 0, isla: 0, wren: 0, talus: 0 };
  const params: Record<string, number>[] = [];
  const combat = new PlayerCombat({
    bus, rng: createRng(3), level: () => 1, character: () => opts.character ?? 'kairen', cooldowns,
    abilityTier: () => opts.tier ?? 0,
    equipment: () => opts.gear ?? NO_MODIFIERS,
    onAbilityHit: (hit) => params.push({ ...hit.params }),
  });
  const targets = opts.targets ?? [];
  const tick = (events: RawInput[] = []): void => {
    input.beginTick(events, DT);
    combat.tick({ input, body, cameraYaw: 0, targets, dt: DT });
  };
  const run = (events: RawInput[], ticks: number): void => {
    tick(events);
    for (let i = 0; i < ticks; i++) tick();
  };
  return { combat, tick, run, cooldowns, params };
}

/** The first hit's amount without the crit multiplier. */
const baseAmount = (h: ResolvedHit | undefined): number => (h === undefined ? Number.NaN : h.crit ? h.amount / 1.5 : h.amount);

describe('Echo Altar tiers in combat (Req 29.5)', () => {
  it('Kairen tier-3 Skill: +50 % damage, a dash of 8 m instead of 6 and the tier params', () => {
    // 8.5 m: past the 6 m capsule (+1.2 m radius, +0.4 m body) but inside the 8 m one.
    const t0 = { far: dummy('far', 8.5), near: dummy('near', 3) };
    const base = setup({ targets: [t0.far, t0.near] });
    base.run(tap('KeyE'), 40);
    const t3 = { far: dummy('far', 8.5), near: dummy('near', 3) };
    const up = setup({ tier: 3, targets: [t3.far, t3.near] });
    up.run(tap('KeyE'), 40);
    expect(base.params[0]).toMatchObject({ dash: 6, flameTrailSeconds: 0 });
    expect(up.params[0]).toMatchObject({ dash: 8, flameTrailSeconds: 3 });
    expect([t0.near.hits.length, t0.far.hits.length]).toEqual([1, 0]);
    expect([t3.near.hits.length, t3.far.hits.length]).toEqual([1, 1]);
    expect(t3.near.hits[0]?.attackerStats?.abilityUpgradePct).toBeCloseTo(0.5, 12);
    expect(baseAmount(t3.near.hits[0]) / baseAmount(t0.near.hits[0])).toBeCloseTo(1.5, 2);
  });

  it('upgrades apply to Skill and Burst hits only, not to Normal attacks', () => {
    const target = dummy('t', 1.5);
    const s = setup({ tier: 3, targets: [target] });
    s.run(tap('Mouse0'), 30);
    expect(target.hits[0]?.attackerStats?.abilityUpgradePct).toBe(0);
  });

  it('a cooldownSet tier replaces the Skill cooldown at the cast', () => {
    const withSet = (['kairen', 'isla', 'wren', 'talus'] as const).find((id) =>
      CHARACTERS[id].skill.upgrades.some((t) => t.cooldownSet !== undefined));
    if (withSet === undefined) return; // no kit sets a cooldown
    const s = setup({ character: withSet, tier: 3 });
    s.tick(tap('KeyE'));
    const set = CHARACTERS[withSet].skill.upgrades.filter((t) => t.cooldownSet !== undefined).at(-1)?.cooldownSet;
    expect(s.cooldowns[withSet]).toBe(set);
  });
});

describe('equipment in combat (Req 30.1, 30.3)', () => {
  it('별빛 눈 adds 10 % crit chance and 잉걸 핵 20 % Reaction damage to the hit stats', () => {
    const gs = createNewGameState(1);
    gs.party.equipment.kairen.charm = 'chm_starlit_eye';
    gs.party.relic = 'rlc_ember_core';
    const target = dummy('t', 1.5);
    const s = setup({ gear: equipModifiers(gs.party, 'kairen'), targets: [target] });
    s.run(tap('Mouse0'), 30);
    expect(target.hits[0]?.attackerStats?.critChance).toBeCloseTo(0.15, 12);
    expect(target.hits[0]?.attackerStats?.reactionDamagePct).toBeCloseTo(0.2, 12);
  });

  it('원시 방벽 keeps Talus’s pillar 3 s longer', () => {
    const gs = createNewGameState(1);
    gs.party.equipment.talus.weapon = 'wpn_talus_bulwark';
    const plain = setup({ character: 'talus' });
    plain.run(tap('KeyE'), 40);
    const armed = setup({ character: 'talus', gear: equipModifiers(gs.party, 'talus') });
    armed.run(tap('KeyE'), 40);
    const seconds = CHARACTERS.talus.skill.params.pillarSeconds ?? Number.NaN;
    expect([plain.params[0]?.pillarSeconds, armed.params[0]?.pillarSeconds]).toEqual([seconds, seconds + 3]);
  });

  const hold = (s: ReturnType<typeof setup>, ticks: number): void => {
    s.tick([{ kind: 'down', code: 'Mouse0', time: 0 }]);
    for (let i = 0; i < ticks; i++) s.tick();
    s.tick([{ kind: 'up', code: 'Mouse0', time: 0 }]);
  };

  it('하늘가르개: Wren’s Charged launch also takes enemies within 3 m of the one it hit', () => {
    const gs = createNewGameState(1);
    gs.party.equipment.wren.weapon = 'wpn_wren_skyreaver';
    // `front` 4 m ahead on the 5 m thrust line (past the Normal arc); `side` 2.5 m beside it, off the line.
    const make = () => {
      const t = { front: dummy('front', 4), side: dummy('side', 4) };
      t.side.hurtVolume = () => ({ pos: { x: 2.5, y: 0, z: 4 }, radius: 0.4, height: 1.8 });
      return t;
    };
    const chargedHits = (d: Dummy): number => d.hits.filter((h) => h.attackId === CHARACTERS.wren.charged.id).length;
    const plainT = make();
    const plain = setup({ character: 'wren', targets: [plainT.front, plainT.side] });
    hold(plain, 30);
    for (let i = 0; i < 40; i++) plain.tick();
    const armedT = make();
    const armed = setup({ character: 'wren', gear: equipModifiers(gs.party, 'wren'), targets: [armedT.front, armedT.side] });
    hold(armed, 30);
    for (let i = 0; i < 40; i++) armed.tick();
    expect([chargedHits(plainT.front), chargedHits(plainT.side)]).toEqual([1, 0]);
    expect([chargedHits(armedT.front), chargedHits(armedT.side)]).toEqual([1, 1]);
  });

  it('조수부름 활: a Charged arrow hit leaves a puddle that applies Tide there once a second for 3 s', () => {
    const gs = createNewGameState(1);
    gs.party.equipment.isla.weapon = 'wpn_isla_tidecaller';
    const target = dummy('t', 8);
    const armed = setup({ character: 'isla', gear: equipModifiers(gs.party, 'isla'), targets: [target] });
    hold(armed, 30);
    for (let i = 0; i < 60 * 4; i++) armed.tick();
    const charged = target.hits.filter((h) => h.attackId === CHARACTERS.isla.charged.id);
    expect(charged.length).toBe(1 + 3); // the arrow and three puddle ticks
    expect(charged.slice(1).every((h) => h.element === 'tide' && h.amount === 1)).toBe(true);
  });

  it('잿불송곳니: Kairen’s 4th Normal hit also sends a 0.6× Ember wave 3 m past the blade', () => {
    const gs = createNewGameState(1);
    gs.party.equipment.kairen.weapon = 'wpn_kairen_emberfang';
    const chainTo4 = (s: ReturnType<typeof setup>): void => {
      s.tick(tap('Mouse0'));
      for (let step = 1; step < CHARACTERS.kairen.normal.length; step++) {
        const [open] = CHARACTERS.kairen.normal[step - 1]?.comboWindow ?? [0];
        while ((s.combat.attack?.t ?? Infinity) < open) s.tick();
        s.tick(tap('Mouse0'));
      }
      for (let i = 0; i < 60; i++) s.tick();
    };
    const plainFar = dummy('far', 5);
    const plain = setup({ targets: [plainFar] });
    chainTo4(plain);
    const far = dummy('far', 5);
    const armed = setup({ gear: equipModifiers(gs.party, 'kairen'), targets: [far] });
    chainTo4(armed);
    expect(plainFar.hits).toHaveLength(0);
    expect(far.hits).toHaveLength(1);
    expect(far.hits[0]).toMatchObject({ element: 'ember' });
    expect(baseAmount(far.hits[0])).toBe(Math.round(CHARACTERS.kairen.baseStats.atk * 0.6));
  });
});

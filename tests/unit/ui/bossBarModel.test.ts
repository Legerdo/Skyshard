import { describe, expect, it } from 'vitest';
import type { BossSnapshot } from '../../../src/boss/bossSnapshot';
import { BossEncounter } from '../../../src/boss/bossEncounter';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import { CAELITH } from '../../../src/data/boss';
import { ELEMENT_DEFS } from '../../../src/data/elements';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { barFraction, bossBarModel } from '../../../src/ui/bossBarModel';

// Caelith's HUD bar view model (task 10.2; design "적·보스 표시"; Req 6.11, 32.6): name, Phase, HP fraction, the
// 65 % / 30 % notches and the Starshell durability only while one stands.

const fighting = (over: Partial<BossSnapshot> = {}): BossSnapshot => ({
  name: CAELITH.name, phase: 1, hp: CAELITH.maxHp, maxHp: CAELITH.maxHp, thresholds: [0.65, 0.3], state: 'idle',
  attack: null, telegraphRemaining: 0, starshell: null, vulnerable: false, crystals: [], ...over,
});

describe('bossBarModel', () => {
  it('hides the bar without a fight: no snapshot, dormant, during the intro and after the defeat', () => {
    expect(bossBarModel(null)).toBeNull();
    for (const state of ['dormant', 'intro', 'dead'] as const) expect(bossBarModel(fighting({ state })), state).toBeNull();
    for (const state of ['idle', 'telegraph', 'attack', 'recovery', 'stagger', 'disabled', 'transition'] as const) {
      expect(bossBarModel(fighting({ state })), state).not.toBeNull();
    }
  });

  it('shows CAELITH with its subtitle, the Phase and the HP fraction with notches at 65 % and 30 %', () => {
    expect(bossBarModel(fighting())).toEqual({
      title: 'CAELITH', subtitle: '추락한 별의 수호자', phaseLabel: 'Phase 1', hpFraction: 1, notches: [0.65, 0.3],
      starshell: null, vulnerable: false,
    });
    expect(bossBarModel(fighting({ phase: 2, hp: 15600 }))).toMatchObject({ phaseLabel: 'Phase 2', hpFraction: 0.65 });
    expect(bossBarModel(fighting({ phase: 3, hp: 6000, vulnerable: true }))).toMatchObject({ phaseLabel: 'Final Phase', hpFraction: 0.25, vulnerable: true });
  });

  it('clamps the fractions to [0, 1]', () => {
    expect([barFraction(-5, 100), barFraction(150, 100), barFraction(Number.NaN, 100), barFraction(5, 0), barFraction(25, 100)]).toEqual([0, 1, 0, 0, 0.25]);
    expect(bossBarModel(fighting({ hp: -10 }))?.hpFraction).toBe(0);
  });

  it('adds the Starshell row only while a Starshell stands: its Element, colour, icon and durability', () => {
    expect(bossBarModel(fighting({ phase: 2, starshell: null }))?.starshell).toBeNull();
    const bar = bossBarModel(fighting({ phase: 2, hp: 15600, starshell: { element: 'tide', durability: 600, max: 1200 } }));
    expect(bar?.starshell).toEqual({
      element: 'tide', elementName: ELEMENT_DEFS.tide.name, icon: 'ringWaves', color: ELEMENT_DEFS.tide.cssColor,
      fraction: 0.5, text: 'Starshell 600 / 1200',
    });
    expect(bossBarModel(fighting({ phase: 3, starshell: { element: 'ember', durability: 0.4, max: 900 } }))?.starshell)
      .toMatchObject({ fraction: 0.4 / 900, text: 'Starshell 1 / 900' });
  });

  it('reads the encounter snapshot: hidden until begin(), then the HP it has left; the Starshell row from Phase 2', () => {
    const boss = new BossEncounter({
      bus: createGameEventBus(), rng: createRng(1), world: createCollisionWorld(flatHeightfield(182)), colliderId: 1,
      runtime: { boss: null }, record: { reachedPhase: () => {}, defeated: () => {} },
    });
    expect(bossBarModel(boss.snapshot())).toBeNull();
    boss.intro(1);
    expect(bossBarModel(boss.snapshot())).toBeNull();
    boss.begin(1);
    const receiver = boss.receiver();
    receiver.receive({
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 6000, crit: false, element: null,
      stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    });
    expect(bossBarModel(boss.snapshot())).toMatchObject({ title: 'CAELITH', phaseLabel: 'Phase 1', hpFraction: 0.75, notches: [0.65, 0.3], starshell: null });
    boss.begin(2); // the Phase 2 checkpoint: 65 % with a fresh 1,200 Starshell
    const bar = bossBarModel(boss.snapshot());
    expect(bar).toMatchObject({ phaseLabel: 'Phase 2', hpFraction: 0.65 });
    expect(bar?.starshell).toMatchObject({ fraction: 1, text: 'Starshell 1200 / 1200' });
  });
});

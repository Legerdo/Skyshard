import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STARSHELL_BREAK_HIT_STOP } from '../../../src/boss/bossEncounter';
import type { HitReceiver } from '../../../src/combat/attackRuntime';
import { PlayerCombat, type CombatBody } from '../../../src/combat/playerCombat';
import { createGameEventBus } from '../../../src/core/gameEvents';
import type { TimeScaleSource } from '../../../src/core/loop';
import { createRng } from '../../../src/core/rng';
import { CHARACTERS } from '../../../src/data/characters';
import { CHARACTER_IDS, REACTION_IDS, type AttackId } from '../../../src/data/ids';
import { SHIELD_BREAK_HIT_STOP } from '../../../src/enemies/enemySystem';
import { InputState, type RawInput } from '../../../src/input/inputState';
import type { DamageKind } from '../../../src/logic/damage';
import {
  HIT_FEEL, HIT_STOP_MAX, HIT_STOP_MIN, hitFeelOfHit, hitSourceOf, isChargedFinalHit, isExplosiveReaction,
  reactionHitFeel, traumaAt, traumaFalloff,
} from '../../../src/logic/hitFeel';
import { createControllerState, type ControllerState } from '../../../src/player/core/types';
import { HitFeelCamera } from '../../../src/vfx/hitFeelCamera';

// Task 19.6 hit feel (design "공격·피격·Stagger", "흔들림과 impulse"; Req 26.3, 26.4).

const KINDS: readonly DamageKind[] = ['normal', 'charged', 'skill', 'burst', 'reaction', 'dot', 'enemy', 'hazard'];
const ATTACK_IDS: readonly AttackId[] = CHARACTER_IDS.flatMap((id) => {
  const c = CHARACTERS[id];
  return [...c.normal.map((a) => a.id), c.charged.id, c.skill.attack.id, c.burst.attack.id];
});

describe('hit feel rules', () => {
  it('every Hit_Stop lies in 50–90 ms of real time; trauma values follow the design', () => {
    for (const feel of Object.values(HIT_FEEL)) {
      if (feel.hitStop > 0) {
        expect(feel.hitStop).toBeGreaterThanOrEqual(HIT_STOP_MIN);
        expect(feel.hitStop).toBeLessThanOrEqual(HIT_STOP_MAX);
      } else {
        expect(feel.hitStop).toBe(0);
      }
    }
    expect([HIT_STOP_MIN, HIT_STOP_MAX]).toEqual([0.05, 0.09]);
    expect(HIT_FEEL.chargedFinal).toEqual({ hitStop: 0.06, trauma: 0.35 });
    expect(HIT_FEEL.burstCast.trauma).toBe(0.5);
    expect(HIT_FEEL.explosiveReaction).toEqual({ hitStop: 0.07, trauma: 0.4 });
    expect(HIT_FEEL.shieldBreak.trauma).toBe(0.4);
    expect(HIT_FEEL.normalHit).toEqual({ hitStop: 0, trauma: 0 });
  });

  it('property: any hit is either feel-free or a 50–90 ms stop; Normal_Attack hits never stop or shake', () => {
    fc.assert(fc.property(
      fc.constantFrom(...KINDS), fc.constantFrom(...ATTACK_IDS), fc.integer({ min: 0, max: 6 }),
      (kind, attackId, index) => {
        const { hitStop, trauma } = hitFeelOfHit(kind, attackId, index);
        expect(hitStop === 0 || (hitStop >= HIT_STOP_MIN && hitStop <= HIT_STOP_MAX)).toBe(true);
        expect(trauma).toBeGreaterThanOrEqual(0);
        if (kind === 'normal') expect({ hitStop, trauma }).toEqual({ hitStop: 0, trauma: 0 });
      },
    ));
  });

  it("recognises every character's Charged_Attack final hit and Burst hits", () => {
    for (const id of CHARACTER_IDS) {
      const { charged, burst, normal } = CHARACTERS[id];
      const last = charged.hits.length - 1;
      expect(isChargedFinalHit(charged.id, last)).toBe(true);
      expect(hitSourceOf('charged', charged.id, last)).toBe('chargedFinal');
      if (last > 0) expect(hitSourceOf('charged', charged.id, 0)).toBe('normalHit');
      expect(hitSourceOf('burst', burst.attack.id, 0)).toBe('burstHit');
      for (const n of normal) expect(hitSourceOf('normal', n.id, n.hits.length - 1)).toBe('normalHit');
    }
  });

  it('explosive Reactions (steamBurst) take their own 70 ms Hit_Stop and 0.4 trauma; the others nothing', () => {
    for (const r of REACTION_IDS) {
      const feel = reactionHitFeel(r);
      if (isExplosiveReaction(r)) expect(feel).toEqual({ hitStop: 0.07, trauma: 0.4 });
      else expect(feel).toEqual({ hitStop: 0, trauma: 0 });
    }
    expect(isExplosiveReaction('steamBurst')).toBe(true);
  });

  it('the Element_Shield and Starshell Hit_Stops are the table values', () => {
    expect(SHIELD_BREAK_HIT_STOP).toBe(HIT_FEEL.shieldBreak.hitStop);
    expect(STARSHELL_BREAK_HIT_STOP).toBe(HIT_FEEL.starshellBreak.hitStop);
  });

  it('positioned impulses fade linearly from 15 m to 30 m', () => {
    expect([0, 15, 22.5, 30, 45].map(traumaFalloff)).toEqual([1, 1, 0.5, 0, 0]);
    expect(traumaAt(0.4, 20)).toBeCloseTo(0.4 * (10 / 15), 9);
    expect(traumaAt(0, 0)).toBe(0);
  });
});

describe('HitFeelCamera', () => {
  it('shakes for Burst casts, explosive Reactions, Charged final hits and shield breaks, never for normal hits', () => {
    const bus = createGameEventBus();
    const added: number[] = [];
    const camera = new HitFeelCamera({ bus, addTrauma: (n) => added.push(n), focus: () => ({ x: 0, y: 0, z: 0 }) });
    bus.emit('burst:cast', { characterId: 'kairen' });
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e', position: { x: 20, y: 0, z: 0 }, chainDepth: 1 });
    bus.emit('reaction', { reaction: 'mistSpread', targetId: 'e', position: { x: 1, y: 0, z: 0 }, chainDepth: 1 });
    bus.dispatch();
    const receiver = { id: 'e', hurtVolume: () => ({ pos: { x: 2, y: 0, z: 0 }, radius: 0.5, height: 1.5 }) } as unknown as HitReceiver;
    const hit = (kind: DamageKind, attackId: AttackId) => ({
      receiver,
      hit: {
        attackerId: 'player', attackId, hitIndex: 0, kind, amount: 10, crit: false, element: null, stagger: 0, knockback: 0,
        direction: { x: 1, y: 0, z: 0 },
      },
    });
    camera.hit(hit('normal', 'atk_kairen_n4'));
    camera.hit(hit('charged', 'atk_kairen_charged'));
    camera.shieldBreak({ x: 40, y: 0, z: 0 }, false); // beyond 30 m: nothing
    camera.shieldBreak({ x: 3, y: 0, z: 0 }, true);
    expect(added.map((n) => Math.round(n * 1000) / 1000)).toEqual([0.5, 0.267, 0.35, 0.4]);
    camera.dispose();
  });
});

// ── PlayerCombat Hit_Stop requests ─────────────────────────────────────────

const DT = 1 / 60;

class Body implements CombatBody {
  state: ControllerState = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  face(yaw: number): void {
    this.state = { ...this.state, yaw };
  }
}

/** A target 1.5 m in front that takes every hit. */
function dummy(): HitReceiver {
  return {
    id: 'dummy',
    hurtVolume: () => ({ pos: { x: 0, y: 0, z: 1.5 }, radius: 0.6, height: 1.6 }),
    immune: () => false,
    sample: () => ({ def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: () => undefined,
  };
}

function combatSetup() {
  const bus = createGameEventBus();
  const input = new InputState();
  const body = new Body();
  const stops: [TimeScaleSource, number, number][] = [];
  const hooked: string[] = [];
  const energy = { kairen: 60, isla: 0, wren: 0, talus: 0 };
  const combat = new PlayerCombat({
    bus, rng: createRng(3), level: () => 1, character: () => 'kairen', energy,
    setTimeScale: (source, scale, seconds) => stops.push([source, scale, seconds]),
    onHit: (r) => hooked.push(`${r.hit.kind}:${r.hit.attackId}`),
  });
  const targets = [dummy()];
  const tick = (events: RawInput[] = []) => {
    input.beginTick(events, DT);
    return combat.tick({ input, body, cameraYaw: 0, targets, dt: DT });
  };
  const playOut = () => {
    for (let i = 0; i < 300 && combat.attack !== null; i++) tick();
  };
  return { combat, tick, playOut, stops, hooked };
}

describe('PlayerCombat Hit_Stop (Req 26.3, 26.4)', () => {
  it('Normal_Attack hits never ask for a Hit_Stop but reach the onHit hook', () => {
    const { tick, playOut, stops, hooked } = combatSetup();
    tick([{ kind: 'down', code: 'Mouse0', time: 0 }, { kind: 'up', code: 'Mouse0', time: 0 }]);
    playOut();
    expect(hooked).toEqual(['normal:atk_kairen_n1']);
    expect(stops).toEqual([]);
  });

  it("the Charged_Attack's final hit asks for 60 ms", () => {
    const { tick, playOut, stops, hooked } = combatSetup();
    tick([{ kind: 'down', code: 'Mouse0', time: 0 }]);
    for (let i = 0; i < 30; i++) tick(); // held 0.5 s ≥ 0.4 s
    tick([{ kind: 'up', code: 'Mouse0', time: 0 }]);
    playOut();
    expect(hooked).toContain('charged:atk_kairen_charged');
    expect(stops).toEqual([['hitStop', 0, 0.06]]);
  });

  it("a Burst cast's first landing hit asks for 80 ms, once", () => {
    const { tick, playOut, stops, hooked } = combatSetup();
    tick([{ kind: 'down', code: 'KeyQ', time: 0 }, { kind: 'up', code: 'KeyQ', time: 0 }]);
    playOut();
    expect(hooked.filter((h) => h.startsWith('burst:')).length).toBeGreaterThan(0);
    expect(stops).toEqual([['hitStop', 0, 0.08]]);
  });
});

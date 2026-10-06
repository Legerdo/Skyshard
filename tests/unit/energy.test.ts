import { describe, expect, it } from 'vitest';
import type { HitReceiver, ResolvedHit } from '../../src/combat/attackRuntime';
import { PlayerCombat, type CombatBody } from '../../src/combat/playerCombat';
import { createPlayerReceiver } from '../../src/combat/playerReceiver';
import { createGameEventBus, type GameEvents } from '../../src/core/gameEvents';
import { createRng } from '../../src/core/rng';
import type { Vec3 } from '../../src/core/types';
import { CHARACTERS } from '../../src/data/characters';
import { CHARACTER_IDS, type CharacterId } from '../../src/data/ids';
import { InputState, type RawInput } from '../../src/input/inputState';
import { createNewGameState } from '../../src/logic/save/gameState';
import { PartySystem } from '../../src/party/partySystem';
import { createControllerState, type ControllerState } from '../../src/player/core/types';

// Energy and Skill / Burst rules in the combat runtime (design "Energy·Cooldown·Dodge"; Req 24.4–24.7).
const DT = 1 / 60;
const tap = (code: string): RawInput[] => [
  { kind: 'down', code, time: 0 },
  { kind: 'up', code, time: 0 },
];
const SKILL = tap('KeyE');
const BURST = tap('KeyQ');
const ATTACK = tap('Mouse0');

/** A target standing at `pos` (feet) that records the hits it takes. */
function dummy(id: string, pos: Vec3) {
  const hits: ResolvedHit[] = [];
  const receiver: HitReceiver = {
    id,
    hurtVolume: () => ({ pos, radius: 0.5, height: 1.6 }),
    immune: () => false,
    sample: () => ({ def: 0, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
    receive: (hit) => hits.push(hit),
  };
  return { receiver, hits };
}

class Body implements CombatBody {
  state: ControllerState = createControllerState({ x: 0, y: 0, z: 0 }, 0);
  face(yaw: number): void {
    this.state = { ...this.state, yaw };
  }
}

const perCharacter = (v: number) => Object.fromEntries(CHARACTER_IDS.map((id) => [id, v])) as Record<CharacterId, number>;

/** Party_System (cooldowns count down) → combat → EventDispatch, as in the fixed tick. */
function setup(targets: HitReceiver[] = [], lockTarget: string | null = null) {
  const bus = createGameEventBus();
  const gs = createNewGameState(1);
  const runtime = { cooldowns: perCharacter(0), energy: perCharacter(0), switchLockUntil: 0 };
  const input = new InputState();
  const body = new Body();
  const combat = new PlayerCombat({
    bus, rng: createRng(3), level: () => gs.party.level, character: () => gs.party.active,
    energy: runtime.energy, cooldowns: runtime.cooldowns,
  });
  const party = new PartySystem({ bus, state: gs, runtime, bossPhase: () => null, onSwitch: () => combat.cancel() });
  const events: { type: string; payload: unknown }[] = [];
  for (const type of ['skill:cast', 'burst:cast', 'ability:refused'] as const) {
    bus.on(type, (payload: GameEvents[typeof type]) => events.push({ type, payload }));
  }
  const tick = (raw: RawInput[] = []) => {
    input.beginTick(raw, DT);
    party.tick({ dt: DT, input, context: 'free' });
    combat.tick({ input, body, cameraYaw: 0, aim: { lockTarget, ray: null }, targets, dt: DT });
    bus.dispatch();
  };
  const idle = (n: number) => {
    for (let i = 0; i < n; i++) tick();
  };
  const drain = () => events.splice(0);
  return { bus, gs, runtime, body, combat, party, tick, idle, drain };
}

describe('energyOnHit filled at data load', () => {
  it('Normal 1, Charged 3, Skill and Burst 0 on every kit HitEvent', () => {
    for (const c of CHARACTER_IDS.map((id) => CHARACTERS[id])) {
      const on = (hits: readonly { energyOnHit?: number }[]) => hits.map((h) => h.energyOnHit);
      expect(c.normal.flatMap((a) => on(a.hits)).every((e) => e === 1), c.id).toBe(true);
      expect([on(c.charged.hits), on(c.skill.attack.hits), on(c.burst.attack.hits)], c.id).toEqual([[3], [0], [0]]);
    }
  });
});

describe('Skill cooldown', () => {
  it('a cast starts the kit cooldown, refuses one tick before it ends and casts again on the tick it ends', () => {
    const enemy = dummy('e1', { x: 0, y: 0, z: 3 });
    const { runtime, combat, tick, idle, drain } = setup([enemy.receiver]);
    tick(SKILL);
    expect([combat.attackKind, runtime.cooldowns.kairen]).toEqual(['skill', CHARACTERS.kairen.skill.cooldown]);
    idle(10); // the dash capsule (t 0.12 s) hits: Energy +6 once, then 'skill:cast'
    expect(enemy.hits.map((h) => h.kind)).toEqual(['skill']);
    expect(runtime.energy.kairen).toBe(6);
    expect(drain()).toEqual([{ type: 'skill:cast', payload: { characterId: 'kairen', hitEnemy: true } }]);

    const ticks = Math.round(CHARACTERS.kairen.skill.cooldown / DT); // 480
    idle(ticks - 12); // one tick left
    tick(SKILL);
    expect(runtime.cooldowns.kairen).toBeCloseTo(DT, 9);
    expect(drain()).toEqual([{ type: 'ability:refused', payload: { characterId: 'kairen', ability: 'skill' } }]);
    expect(combat.attackKind).toBeNull();
    tick(SKILL); // the cooldown ends on this tick
    expect([combat.attackKind, runtime.cooldowns.kairen]).toEqual(['skill', 8]);
  });

  it("a standby character's cooldown keeps running and its Energy stays; Energy goes to the Active_Character", () => {
    const enemy = dummy('e1', { x: 0, y: 0, z: 1.5 });
    const { gs, party, runtime, combat, tick, idle } = setup([enemy.receiver]);
    party.join('isla');
    tick(SKILL);
    idle(59);
    expect(runtime.energy.kairen).toBe(6);
    tick(tap('Digit2')); // switch to Isla (the Skill already ended)
    expect(gs.party.active).toBe('isla');
    tick(ATTACK); // Isla's arrow hits: +1 for Isla only
    idle(30);
    expect([runtime.energy.kairen, runtime.energy.isla]).toEqual([6, 1]);
    idle(Math.round(8 / DT) - 92);
    tick(tap('Digit1')); // 8 s since Kairen's cast, all of it on standby but the first second
    expect(gs.party.active).toBe('kairen');
    expect(runtime.cooldowns.kairen).toBeLessThanOrEqual(1e-6);
    tick(SKILL);
    expect([combat.attackKind, runtime.cooldowns.kairen]).toEqual(['skill', 8]);
  });

  it("Isla's arrow rain lands 6 volleys on the Lock-on target with one 'skill:cast'; a miss reports hitEnemy false", () => {
    const target = dummy('mark', { x: 3, y: 0, z: 9 });
    const hit = setup([target.receiver], 'mark');
    hit.gs.party.active = 'isla';
    hit.tick(SKILL);
    hit.idle(200);
    expect(target.hits).toHaveLength(6);
    expect(hit.runtime.energy.isla).toBe(6);
    expect(hit.drain()).toEqual([{ type: 'skill:cast', payload: { characterId: 'isla', hitEnemy: true } }]);

    const miss = setup([]);
    miss.gs.party.active = 'isla';
    miss.tick(SKILL);
    miss.idle(100);
    expect(miss.combat.pendingCircles).toBeGreaterThan(0);
    expect(miss.drain()).toEqual([]);
    miss.idle(100);
    expect(miss.drain()).toEqual([{ type: 'skill:cast', payload: { characterId: 'isla', hitEnemy: false } }]);
    expect(miss.runtime.energy.isla).toBe(0);
  });
});

describe('Energy and Burst', () => {
  it('Burst is refused below full Energy and cast right after the hit that fills it: Energy 0, invulnerable cut-in', () => {
    const enemy = dummy('e1', { x: 0, y: 0, z: 1.5 });
    const { gs, bus, runtime, body, combat, tick, idle, drain } = setup([enemy.receiver]);
    const player = createPlayerReceiver({ gameState: gs, bus, body: () => body.state, invulnerable: () => combat.invulnerable });
    runtime.energy.kairen = 59;
    tick(BURST);
    expect(drain()).toEqual([{ type: 'ability:refused', payload: { characterId: 'kairen', ability: 'burst' } }]);
    tick(ATTACK);
    while (enemy.hits.length === 0) tick();
    expect(runtime.energy.kairen).toBe(60); // Normal hit +1 reaches the Burst cost
    tick(BURST);
    expect(drain()).toEqual([{ type: 'burst:cast', payload: { characterId: 'kairen' } }]);
    expect([combat.attackKind, runtime.energy.kairen, combat.invulnerable, player.immune()]).toEqual(['burst', 0, true, true]);
    const cutInTicks = Math.round(CHARACTERS.kairen.burst.cutIn / DT);
    idle(cutInTicks - 2);
    expect(combat.invulnerable).toBe(true);
    idle(1); // clip time reaches the 1.0 s cut-in
    expect([combat.invulnerable, player.immune()]).toEqual([false, false]);
    idle(10); // the slam (t 1.05 s) lands and pays no Energy
    expect(enemy.hits.map((h) => h.kind)).toEqual(['normal', 'burst']);
    expect(runtime.energy.kairen).toBe(0);
  });

  it('a Charged hit on two targets pays 3 once; Reactions pay 5 to the Active_Character and Perfect_Dodges 10, capped at the cost', () => {
    const a = dummy('a', { x: 0, y: 0, z: 1.5 });
    const b = dummy('b', { x: 1.5, y: 0, z: 0 }); // beside Kairen: outside the Normal arc, inside the Charged spin
    const { bus, runtime, tick } = setup([a.receiver, b.receiver]);
    tick([{ kind: 'down', code: 'Mouse0', time: 0 }]); // the press also starts Normal hit 1 (+1 on `a`)
    for (let i = 0; i < 30; i++) tick();
    tick([{ kind: 'up', code: 'Mouse0', time: 0 }]);
    for (let i = 0; i < 40; i++) tick();
    expect([a.hits.map((h) => h.kind), b.hits.map((h) => h.kind), runtime.energy.kairen]).toEqual([
      ['normal', 'charged'], ['charged'], 1 + 3,
    ]);

    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'a', position: { x: 0, y: 0, z: 0 }, chainDepth: 0 });
    bus.emit('perfectDodge', { characterId: 'isla', attackerId: 'a' });
    bus.dispatch();
    expect([runtime.energy.kairen, runtime.energy.isla]).toEqual([9, 10]);
    runtime.energy.kairen = 58;
    bus.emit('reaction', { reaction: 'lavaRift', targetId: 'a', position: { x: 0, y: 0, z: 0 }, chainDepth: 0 });
    bus.dispatch();
    expect(runtime.energy.kairen).toBe(60);
  });
});

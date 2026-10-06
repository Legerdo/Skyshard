import { beforeAll, describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CHARACTERS } from '../../../src/data/characters';
import type { CharacterId } from '../../../src/data/ids';
import type { InputAction } from '../../../src/input/actions';
import type { RawInput } from '../../../src/input/inputState';
import { InputState } from '../../../src/input/inputState';
import { applyElement } from '../../../src/logic/element';
import { PARTY_SLOTS, type SwitchContext } from '../../../src/logic/party';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { DOWNED_SECONDS, PartySystem, switchContextFor } from '../../../src/party/partySystem';
import { PlaySim } from '../../../src/playSim';
import { MOVE_MODES } from '../../../src/player/core/types';
import { createRuntimeState } from '../../../src/save/runtimeState';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

type Logged = { type: GameEventName; payload: unknown };

function setup(joined: readonly CharacterId[] = PARTY_SLOTS) {
  const gs = createNewGameState(1);
  gs.party.joined = [...joined];
  const runtime = createRuntimeState(gs);
  const bus = createGameEventBus();
  const events: Logged[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const switches: [CharacterId, CharacterId][] = [];
  const party = new PartySystem({ bus, state: gs, runtime, bossPhase: () => 2, onSwitch: (from, to) => switches.push([from, to]) });
  /** One tick of `dt` with `action` pressed (or nothing). */
  const tick = (action?: InputAction, context: SwitchContext = 'free', dt = 0.01): void =>
    party.tick({ dt, input: { pressed: (a) => a === action }, context });
  const idle = (n: number, dt = 0.01, context: SwitchContext = 'free'): void => {
    for (let i = 0; i < n; i++) tick(undefined, context, dt);
  };
  const drain = (): Logged[] => {
    bus.dispatch();
    return events.splice(0);
  };
  return { gs, runtime, party, switches, tick, idle, drain };
}

describe('PartySystem switching', () => {
  it('switches to the pressed slot, then refuses for 0.8 s: 0.79 s refused, 0.8 s allowed', () => {
    const { gs, party, switches, tick, idle, drain } = setup();
    tick('switch2');
    expect([gs.party.active, switches]).toEqual(['isla', [['kairen', 'isla']]]);
    expect(drain()).toEqual([{ type: 'party:switched', payload: { from: 'kairen', to: 'isla' } }]);
    expect(party.lockRemaining).toBeCloseTo(0.8, 9);
    idle(78);
    tick('switch3'); // 0.79 s after the switch
    expect([gs.party.active, party.lastRejection]).toEqual(['isla', { id: 'wren', reason: 'cooldown' }]);
    expect(party.lockRemaining).toBeCloseTo(0.01, 6);
    tick('switch3'); // 0.80 s
    expect(gs.party.active).toBe('wren');
    expect(drain().map((e) => e.payload)).toEqual([{ from: 'isla', to: 'wren' }]);
  });

  it('opens on the 48th tick of 1/60 s', () => {
    const { gs, tick, idle } = setup();
    const dt = 1 / 60;
    tick('switch4', 'free', dt);
    idle(46, dt);
    tick('switch1', 'free', dt);
    expect(gs.party.active).toBe('talus');
    tick('switch1', 'free', dt);
    expect(gs.party.active).toBe('kairen');
  });

  it('refuses while gliding (context) and shakes the slot for 0.25 s without switching', () => {
    const { gs, party, switches, tick, idle, drain } = setup();
    tick('switch2', switchContextFor('glide'));
    expect([gs.party.active, switches, party.lastRejection]).toEqual(['kairen', [], { id: 'isla', reason: 'context' }]);
    expect(party.slots()[1]).toMatchObject({ id: 'isla', slot: 2, shaking: true, shakeSeq: 1 });
    expect(drain()).toEqual([]);
    idle(25);
    expect(party.slots()[1]?.shaking).toBe(false);
    tick('switch2');
    expect(gs.party.active).toBe('isla');
  });

  it('refuses unjoined and active targets with their reasons', () => {
    const { gs, party, tick } = setup(['kairen', 'isla']);
    tick('switch3');
    expect(party.lastRejection).toEqual({ id: 'wren', reason: 'notJoined' });
    tick('switch1');
    expect(party.lastRejection).toEqual({ id: 'kairen', reason: 'active' });
    expect(party.slots().map((s) => s.shakeSeq)).toEqual([1, 0, 1, 0]);
    expect(gs.party.active).toBe('kairen');
  });

  it('maps climbing, gliding, swimming and scenes to refusing contexts', () => {
    const refused = MOVE_MODES.filter((m) => switchContextFor(m) !== 'free');
    expect(refused).toEqual(['climbAttach', 'climb', 'climbLeap', 'mantle', 'glideDeploy', 'glide', 'swim']);
    expect([switchContextFor('grounded', 'dialogue'), switchContextFor('jump', 'cinematic')]).toEqual(['dialogue', 'cinematic']);
  });
});

describe('PartySystem cooldowns and joins', () => {
  it('counts every Skill cooldown down each tick, standby slots included, and leaves Energy alone', () => {
    const { runtime, idle } = setup();
    runtime.cooldowns.kairen = 2;
    runtime.cooldowns.isla = 9;
    runtime.cooldowns.talus = 12;
    runtime.energy.isla = 40;
    idle(300); // 3 s with Kairen active
    expect(runtime.cooldowns.kairen).toBe(0);
    expect(runtime.cooldowns.isla).toBeCloseTo(6, 6);
    expect(runtime.cooldowns.talus).toBeCloseTo(9, 6);
    expect(runtime.cooldowns.wren).toBe(0);
    expect(runtime.energy.isla).toBe(40);
  });

  it("announces 'party:joined' once when a joined flag turns on, and the companion joins at full HP", () => {
    const { gs, party, idle, drain } = setup(['kairen']);
    idle(1);
    expect(drain()).toEqual([]); // New Game's Kairen is not announced
    gs.party.hp.isla = 1;
    party.join('isla');
    party.join('isla');
    expect(gs.party.hp.isla).toBe(party.maxHp('isla'));
    gs.party.joined.push('wren'); // a flag set elsewhere is picked up on the next tick
    idle(2);
    expect(drain()).toEqual([
      { type: 'party:joined', payload: { characterId: 'isla' } },
      { type: 'party:joined', payload: { characterId: 'wren' } },
    ]);
    expect(party.slots().map((s) => [s.id, s.joined])).toEqual([['kairen', true], ['isla', true], ['wren', true], ['talus', false]]);
  });
});

describe('PartySystem Downed and wipe', () => {
  it('Downed at 0 HP blocks input for 0.8 s, then switches to the next slot skipping lock and context', () => {
    const { gs, party, switches, tick, idle, drain } = setup();
    tick('switch2'); // Isla active, lock restarted
    drain();
    gs.party.hp.isla = 0;
    party.afterHits();
    expect(drain()).toEqual([{ type: 'party:downed', payload: { characterId: 'isla' } }]);
    expect([gs.party.downed, party.inputBlocked]).toEqual([['isla'], true]);
    tick('switch1'); // held while down
    expect(gs.party.active).toBe('isla');
    idle(78, 0.01, 'glide');
    expect(gs.party.active).toBe('isla'); // 0.79 s
    idle(1, 0.01, 'glide');
    expect(gs.party.active).toBe('wren'); // 0.80 s, while gliding
    expect(switches.at(-1)).toEqual(['isla', 'wren']);
    expect(drain()).toEqual([{ type: 'party:switched', payload: { from: 'isla', to: 'wren' } }]);
    expect([party.inputBlocked, party.lockRemaining]).toEqual([false, expect.closeTo(0.8, 6)]);
    tick('switch1');
    expect(party.lastRejection).toEqual({ id: 'kairen', reason: 'cooldown' });
  });

  it("publishes 'party:wipe' 0.8 s after the last joined character goes down, and restoreAll answers it", () => {
    const { gs, party, idle, drain } = setup(['kairen', 'isla']);
    gs.party.hp.kairen = 0;
    party.afterHits();
    idle(80);
    expect(gs.party.active).toBe('isla');
    gs.party.hp.isla = 0;
    party.afterHits();
    party.afterHits();
    idle(Math.round(DOWNED_SECONDS / 0.01) - 1);
    expect(party.wipeActive).toBe(false);
    idle(1);
    expect([party.wipeActive, party.inputBlocked, gs.stats.partyWipes]).toEqual([true, true, 1]);
    expect(drain().map((e) => e.type)).toEqual(['party:downed', 'party:switched', 'party:downed', 'party:wipe']);
    idle(100);
    expect(drain()).toEqual([]);
    party.restoreAll();
    expect(gs.party.downed).toEqual([]);
    expect(gs.party.hp.kairen).toBe(party.maxHp('kairen'));
    expect([party.wipeActive, party.inputBlocked]).toEqual([false, false]);
  });

  it("carries the boss Phase in 'party:wipe'", () => {
    const { gs, party, idle, drain } = setup(['kairen']);
    gs.party.hp.kairen = 0;
    party.afterHits();
    idle(80);
    expect(drain().at(-1)).toEqual({ type: 'party:wipe', payload: { bossPhase: 2 } });
  });
});

describe('PartySystem in the play session', () => {
  const DT = 1 / 60;
  let terrain: TerrainField;
  beforeAll(() => {
    terrain = buildTerrain(20240601);
  });

  function session() {
    const gameState = createNewGameState(20240601);
    gameState.party.joined = [...PARTY_SLOTS];
    const input = new InputState();
    const sim = new PlaySim({ gameState, terrain, input, commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} } });
    const step = (events: RawInput[] = []): void => {
      input.beginTick(events, DT);
      sim.tick(DT, 0);
    };
    const tap = (code: string): RawInput[] => [{ kind: 'down', code, time: 0 }, { kind: 'up', code, time: 0 }];
    return { sim, gameState, step, tap };
  }

  it('hands the moving body over, cancels the attack and keeps enemy marks, projectiles and placed effects', () => {
    const { sim, gameState, step, tap } = session();
    for (let i = 0; i < 30; i++) step(); // settle on the ground
    const p = sim.player.state.pos;
    const enemyId = sim.enemies.spawn({ kind: 'bramblekin', pos: { x: p.x + 40, y: p.y, z: p.z } });
    const enemy = sim.runtime.enemies.get(enemyId);
    if (enemy === undefined) throw new Error('no enemy');
    enemy.element = applyElement(enemy.element, 'ember', sim.enemies.simTime).next;
    sim.runtime.zones.push({ id: 'zone_1', source: 'atk_talus_skill', owner: 'player', pos: { ...p }, radius: 2, until: 99 });
    // An arrow already in flight (straight up, clear of everything) keeps flying through the switch.
    const arrow = sim.combat.projectiles.spawn({
      attacker: {
        id: 'player', origin: { pos: { ...p }, yaw: 0 }, kind: 'normal', element: null, roll: () => 0,
        stats: { baseAtk: 100, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      },
      attackId: 'atk_isla_n1', hitIndex: 0, hit: CHARACTERS.isla.normal[0]!.hits[0]!,
      from: { x: p.x, y: p.y + 30, z: p.z }, dir: { x: 0, y: 1, z: 0 },
    });
    const marks = structuredClone(enemy.element);
    const placed = structuredClone(sim.runtime.zones);

    step(tap('Mouse0'));
    expect(sim.combat.attack).not.toBeNull();
    const flown = arrow.travelled;
    step(tap('Digit2'));
    expect([gameState.party.active, sim.player.character, sim.combat.attack]).toEqual(['isla', 'isla', null]);
    expect(sim.runtime.enemies.get(enemyId)?.element).toEqual(marks);
    expect(sim.runtime.zones).toEqual(placed);
    expect(sim.runtime.projectiles.active.map((a) => a.id)).toEqual([arrow.id]);
    expect(arrow.travelled).toBeGreaterThan(flown);

    // Mid-jump: position, yaw and the vertical velocity carry straight on under the new character.
    for (let i = 0; i < 50; i++) step();
    step(tap('Space'));
    for (let i = 0; i < 4; i++) step();
    const before = structuredClone(sim.player.state);
    expect(before.vel.y).toBeGreaterThan(1);
    step(tap('Digit3'));
    const after = sim.player.state;
    expect(sim.player.character).toBe('wren');
    expect(after.mode).toBe(before.mode);
    expect(after.yaw).toBeCloseTo(before.yaw, 9);
    expect(Math.abs(after.vel.y - before.vel.y)).toBeLessThan(0.5); // one tick of gravity
    expect(Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y, after.pos.z - before.pos.z)).toBeLessThan(0.2);
  });
});

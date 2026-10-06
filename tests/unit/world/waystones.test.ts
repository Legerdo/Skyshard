import { beforeAll, describe, expect, it } from 'vitest';
import { seeContextCinematics } from '../helpers/seenCinematics';
import type { GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { WAYSTONE_IDS, isRegionId } from '../../../src/data/ids';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { WAYSTONE_LIST, WAYSTONE_SPOT_DISTANCE, WAYSTONES } from '../../../src/data/waystones';
import { SANCTUM } from '../../../src/data/sanctum';
import { InputState } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import type { WaystoneNotice } from '../../../src/world/waystoneSystem';
import {
  FAST_TRAVEL_FADE_OUT, FAST_TRAVEL_MAX_SECONDS, FAST_TRAVEL_REFUSED_TEXT,
} from '../../../src/world/waystoneSystem';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';
import { BOT_DT, RouteBot } from '../helpers/routeBot';

// Waystones and fast travel in the headless session (task 13.7; Req 11.1–11.5): activation registers the stone and
// publishes 'waystone:activated' + 'save:request'; every interaction heals, clears Downed and sets the respawn point;
// fast travel is refused In_Combat with its message, else fades 0.5 s out, moves 2 m in front of the stone on the
// ground and fades 0.5 s in (≤ 3 s).

const SEED = 20240601;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

function setup() {
  const gameState = createNewGameState(SEED);
  gameState.party.joined = [...PARTY_SLOTS];
  seeContextCinematics(gameState); // task 21.2: no Landmark cinematic holds the prompt after a teleport
  const input = new InputState();
  const commands = new UiCommandQueue();
  const notices: WaystoneNotice[] = [];
  const sim = new PlaySim({
    gameState, terrain, input, commands,
    sinks: { partyWipe: () => {}, ending: () => {}, waystone: (n) => notices.push(n) },
  });
  const bot = new RouteBot(sim, input, commands, 300);
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  return { sim, bot, gameState, commands, notices, of };
}

describe('Waystone data', () => {
  it('places the six Waystones at the layout table with a spot 2 m in front on their flat pads', () => {
    expect(WAYSTONE_LIST.map((w) => w.id)).toEqual([...WAYSTONE_IDS]);
    for (const w of WAYSTONE_LIST) {
      expect(isRegionId(w.region), w.id).toBe(true);
      expect(Math.hypot(w.spot.x - w.x, w.spot.z - w.z), w.id).toBeCloseTo(WAYSTONE_SPOT_DISTANCE, 9);
      if (w.sanctumPiece) continue;
      const loc = LOCATIONS[w.id];
      expect([w.x, w.z, w.groundY, w.region]).toEqual([loc.x, loc.z, loc.groundY, loc.region]);
    }
    // ws_sanctum is the Sanctum's own stone and "Waystone으로 돌아가기" spot.
    const s = WAYSTONES.ws_sanctum;
    expect([s.x, s.groundY, s.z]).toEqual([SANCTUM.waystone.pos.x, SANCTUM.waystone.pos.y, SANCTUM.waystone.pos.z]);
    expect([s.spot.x, s.spot.groundY, s.spot.z, s.spot.yaw]).toEqual([
      SANCTUM.waystone.spot.pos.x, SANCTUM.waystone.spot.pos.y, SANCTUM.waystone.spot.pos.z, SANCTUM.waystone.spot.yaw,
    ]);
  });

  it('stands every ground spot on its pad height in the seeded terrain', () => {
    for (const w of WAYSTONE_LIST.filter((d) => !d.sanctumPiece)) {
      expect(terrain.heightAt(w.spot.x, w.spot.z), w.id).toBeCloseTo(w.groundY, 1);
    }
  });
});

describe('Waystone activation and rest', () => {
  it('activates on the first interaction: registered, events, heal, Downed cleared and the respawn point', () => {
    const { sim, bot, gameState, notices, of } = setup();
    const ws = WAYSTONES.ws_thistlewick;
    sim.player.teleport({ x: ws.spot.x, y: ws.spot.groundY, z: ws.spot.z }, ws.spot.yaw);
    bot.step();
    const { party } = gameState;
    party.hp.kairen = 5;
    party.hp.isla = 0;
    party.downed.push('isla');
    bot.interact('activate', 'waystone', 'ws_thistlewick', { x: ws.x, y: ws.groundY, z: ws.z });
    bot.idle(0.1);
    expect(gameState.world.waystones).toEqual(['ws_thistlewick']);
    expect(of('waystone:activated')).toEqual([{ waystoneId: 'ws_thistlewick', regionId: 'verdant' }]);
    expect(of('save:request')).toContainEqual({ reason: 'waystone' });
    for (const id of PARTY_SLOTS) expect(party.hp[id], id).toBe(sim.party.maxHp(id));
    expect(party.downed).toEqual([]);
    expect(gameState.respawn).toEqual({ kind: 'waystone', id: 'ws_thistlewick' });
    expect(notices).toEqual([{ kind: 'activated', waystoneId: 'ws_thistlewick' }]);

    // Later interactions heal and set the respawn point again, without another activation or save.
    gameState.respawn = { kind: 'hearth', id: 'hearth_thistlewick' };
    party.hp.wren = 1;
    const saves = of('save:request').length;
    bot.interact('rest', 'waystone', 'ws_thistlewick', { x: ws.x, y: ws.groundY, z: ws.z });
    bot.idle(0.1);
    expect(party.hp.wren).toBe(sim.party.maxHp('wren'));
    expect(gameState.respawn).toEqual({ kind: 'waystone', id: 'ws_thistlewick' });
    expect(of('waystone:activated')).toHaveLength(1);
    expect(of('save:request')).toHaveLength(saves);
    expect(notices.at(-1)).toEqual({ kind: 'rested', waystoneId: 'ws_thistlewick' });
  });

  it('offers ws_sanctum in the Sanctum hall through the same system', () => {
    const { sim, bot, gameState, of } = setup();
    const ws = WAYSTONES.ws_sanctum;
    sim.player.teleport({ x: ws.spot.x, y: ws.spot.groundY, z: ws.spot.z }, ws.spot.yaw);
    bot.idle(0.3);
    expect(sim.interaction.prompt).toMatchObject({ kind: 'waystone', id: 'ws_sanctum' });
    bot.interact('sanctum', 'waystone', 'ws_sanctum', { x: ws.x, y: ws.groundY, z: ws.z });
    bot.idle(0.1);
    expect(gameState.world.waystones).toContain('ws_sanctum');
    expect(of('waystone:activated')).toEqual([{ waystoneId: 'ws_sanctum', regionId: 'sanctum' }]);
  });
});

describe('fast travel', () => {
  it('refuses In_Combat with "전투 중에는 이동할 수 없습니다" and stays put (Req 11.5)', () => {
    const { sim, bot, gameState, commands, notices } = setup();
    gameState.world.waystones.push('ws_ember');
    bot.idle(0.1);
    const before = { ...sim.player.state.pos };
    sim.runtime.inCombat = true; // what the last tick found: an engaged enemy
    commands.push({ kind: 'fastTravel', waystoneId: 'ws_ember' });
    bot.step();
    expect(sim.waystones.travelling).toBe(false);
    expect(notices).toContainEqual({ kind: 'travelRefused', waystoneId: 'ws_ember', text: FAST_TRAVEL_REFUSED_TEXT });
    bot.idle(1.5);
    expect(Math.hypot(sim.player.state.pos.x - before.x, sim.player.state.pos.z - before.z)).toBeLessThan(0.5);
  });

  it('ignores Waystones that are not active, even when a Vista marked them (Req 11.2)', () => {
    const { sim, bot, gameState, commands } = setup();
    gameState.world.flags.map_ws_ember = true;
    commands.push({ kind: 'fastTravel', waystoneId: 'ws_ember' });
    bot.step();
    expect(sim.waystones.travelling).toBe(false);
  });

  it('fades out 0.5 s, stands 2 m in front of the stone on the ground and fades in, within 3 s (Req 11.4)', () => {
    const { sim, bot, gameState, commands } = setup();
    gameState.world.waystones.push('ws_thistlewick', 'ws_ember');
    bot.idle(0.1);
    commands.push({ kind: 'fastTravel', waystoneId: 'ws_ember' });
    const start = bot.t;
    bot.step();
    expect(sim.waystones.travelling).toBe(true);
    expect(sim.inputLocked).toBe(true);
    let movedAt: number | null = null;
    let peak = 0;
    const spot = WAYSTONES.ws_ember.spot;
    while (sim.inputLocked) {
      if (bot.t - start > FAST_TRAVEL_MAX_SECONDS) throw new Error('fast travel over 3 s');
      bot.hold(['KeyW']); // held input does nothing while it runs
      bot.step();
      peak = Math.max(peak, sim.waystones.fadeAlpha);
      if (movedAt === null && Math.hypot(sim.player.state.pos.x - spot.x, sim.player.state.pos.z - spot.z) < 1) movedAt = bot.t - start;
    }
    bot.hold([]);
    const total = bot.t - start;
    expect(total).toBeLessThanOrEqual(FAST_TRAVEL_MAX_SECONDS);
    expect(total).toBeGreaterThanOrEqual(1 - 2 * BOT_DT);
    expect(movedAt).not.toBeNull();
    expect(movedAt ?? 0).toBeGreaterThanOrEqual(FAST_TRAVEL_FADE_OUT - 2 * BOT_DT);
    expect(peak).toBeCloseTo(1, 6);
    expect(sim.waystones.fadeAlpha).toBe(0);
    const p = sim.player.state.pos;
    expect(Math.hypot(p.x - spot.x, p.z - spot.z)).toBeLessThan(0.05);
    expect(Math.hypot(p.x - WAYSTONES.ws_ember.x, p.z - WAYSTONES.ws_ember.z)).toBeCloseTo(2, 1);
    expect(p.y).toBeCloseTo(terrain.heightAt(p.x, p.z), 1);
    bot.idle(0.5);
    expect(sim.player.state.mode).toBe('grounded');
  });

  it('lands on the Sanctum hall floor for ws_sanctum', () => {
    const { sim, bot, gameState, commands } = setup();
    gameState.world.waystones.push('ws_sanctum');
    commands.push({ kind: 'fastTravel', waystoneId: 'ws_sanctum' });
    bot.step();
    bot.settle();
    bot.idle(0.5);
    const p = sim.player.state.pos;
    expect(Math.hypot(p.x - WAYSTONES.ws_sanctum.spot.x, p.z - WAYSTONES.ws_sanctum.spot.z)).toBeLessThan(0.1);
    expect(p.y).toBeCloseTo(SANCTUM.waystone.spot.pos.y, 1);
    expect(sim.player.state.mode).toBe('grounded');
  });

  it('restarts a Party_Wipe at the Waystone respawn spot in front of the stone', () => {
    const { sim, bot, gameState, commands } = setup();
    gameState.respawn = { kind: 'waystone', id: 'ws_crater' };
    commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    bot.step();
    const spot = WAYSTONES.ws_crater.spot;
    expect(Math.hypot(sim.player.state.pos.x - spot.x, sim.player.state.pos.z - spot.z)).toBeLessThan(0.05);
  });
});

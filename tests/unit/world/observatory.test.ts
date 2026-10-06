import { beforeAll, describe, expect, it } from 'vitest';
import { seeContextCinematics } from '../helpers/seenCinematics';
import type { GameEventName } from '../../../src/core/gameEvents';
import { yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import {
  CONSTELLATION_TIMING, OBSERVATORY, OBSERVATORY_PEDESTALS, OBSERVATORY_WAVE_DELAY, OBSERVATORY_Y, type RoutePoint,
} from '../../../src/data/challengeAreas';
import type { CharacterId, ElementId } from '../../../src/data/ids';
import { observatoryOrder } from '../../../src/data/puzzles';
import { MAIN_QUEST } from '../../../src/data/quests';
import { InputState } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { STAMINA_RULES } from '../../../src/logic/stamina';
import { PlaySim } from '../../../src/playSim';
import { RECOVERY_FADE_IN, RECOVERY_FADE_OUT } from '../../../src/player/recovery';
import { checkpointFlag, roomClearedFlag } from '../../../src/world/challengeArea';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';
import { BOT_DT, RouteBot } from '../helpers/routeBot';

// Starfall Observatory in the play session (task 9.8; design "Starfall Observatory", "체크포인트와 실패 처리"; Req 12.3,
// 12.7–12.9, 13.5, 13.6), on the real terrain: the great hall and its seeded constellation puzzle solved with the party's
// Elements within 15 s, wrong steps and timeouts, the ring corridor's two shielded waves, Sentinel Prime and its
// drones, Skyshard 3, the balcony glide, the checkpoints and the Party_Wipe restart.

const SEED = 20240601;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const [CP1, CP2] = OBSERVATORY.checkpoints;
if (CP1 === undefined || CP2 === undefined) throw new Error('Observatory checkpoints missing');
const PUZZLE = 'pz_observatory_1';
const [WAVE_1, WAVE_2] = OBSERVATORY.combatRooms[0]?.waves ?? [];
if (WAVE_1 === undefined || WAVE_2 === undefined) throw new Error('Observatory waves missing');
const route = (room: string): RoutePoint[] => OBSERVATORY.route.filter((r) => r.room === room);
const pts = (room: string): Vec3[] => route(room).map((r) => r.pos);
const lift = (id: string) => {
  const l = OBSERVATORY.lifts.find((x) => x.id === id);
  if (l === undefined) throw new Error(`no lift ${id}`);
  return l;
};
const pedestal = (element: ElementId) => {
  const p = OBSERVATORY_PEDESTALS.find((x) => x.element === element);
  if (p === undefined) throw new Error(`no pedestal ${element}`);
  return p;
};
const partOf = (element: ElementId): string => `${PUZZLE}_${pedestal(element).id}`;
const CHARACTER_OF: Readonly<Record<ElementId, CharacterId>> = { ember: 'kairen', tide: 'isla', gale: 'wren', terra: 'talus' };

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

/** GameState past the constellation puzzle, on its landing. */
const solved = (gs: GameState): void => {
  gs.world.puzzles.push(PUZZLE);
  gs.checkpoint = { area: 'observatory', id: 'cp_observatory_1' };
};
/** GameState past both waves, at the dome stairs. */
const wavesCleared = (gs: GameState): void => {
  solved(gs);
  gs.world.flags[roomClearedFlag(WAVE_1)] = true;
  gs.world.flags[roomClearedFlag(WAVE_2)] = true;
  gs.checkpoint = { area: 'observatory', id: 'cp_observatory_2' };
};

function setup(objectiveId: string, prep?: (gs: GameState) => void) {
  const gameState = createNewGameState(SEED);
  gameState.party.joined = [...PARTY_SLOTS];
  gameState.skyshards = 2;
  gameState.party.level = 6;
  at(gameState, objectiveId);
  seeContextCinematics(gameState); // task 21.2: the Landmark / area cinematics of the way here were seen
  prep?.(gameState);
  const input = new InputState();
  const commands = new UiCommandQueue();
  let bot: RouteBot | null = null;
  const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: (p) => bot?.onWipe(p), ending: () => {} } });
  bot = new RouteBot(sim, input, commands, 600);
  const events: { t: number; type: GameEventName; payload: unknown }[] = [];
  const b = bot;
  sim.bus.onAny((type, payload) => events.push({ t: b.t, type, payload }));
  sim.quests.resume();
  const place = (pos: Vec3, yaw = 0): void => {
    sim.player.teleport({ ...pos }, yaw);
    b.cameraYaw = yaw;
    b.step();
  };
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  const members = (groupId: string) => [...sim.runtime.enemies.values()].filter((e) => e.campId === groupId && e.state !== 'dead');
  const objective = (): string | undefined => sim.quests.objectiveView('main')?.objective.id;
  /** A hit of `amount` (default lethal) on an enemy or drone through its receiver. */
  const hit = (id: string, amount = 1e6, element: ElementId | null = null): void => {
    for (const r of sim.enemies.receivers()) {
      if (r.id !== id) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount, crit: false, element,
        stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      });
    }
  };
  /** A hit carrying `element` on a star pedestal, through its hit receiver. */
  const hitPart = (part: string, element: ElementId): void => {
    for (const r of sim.devices.hitTargets()) {
      if (r.id !== part) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 50, crit: false, element,
        stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      });
    }
  };
  return { sim, gameState, bot: b, events, commands, place, of, members, objective, hit, hitPart };
}

describe('the great hall and the constellation puzzle (Req 12.3, 13.5, 13.6)', () => {
  it('walks up the entrance stair into the hall, whose ceiling shows the save-seeded order in turn', () => {
    const s = setup('ms7_hall');
    s.place(OBSERVATORY.entrance.pos, OBSERVATORY.entrance.yaw);
    expect(s.sim.challenge.current?.id).toBe('observatory');
    expect(s.sim.challenge.music).toBe('mus_area_observatory');
    s.bot.walk('into the hall', pts('hall').slice(0, 3));
    expect(s.bot.pos.y).toBeCloseTo(OBSERVATORY_Y.hall, 1);
    s.bot.idle(0.1);
    expect(s.objective()).toBe('ms7_constellation');
    const order = observatoryOrder(SEED);
    expect(s.sim.puzzles.sequenceOrder(PUZZLE)).toEqual(order);
    const views = () => s.sim.challenge.constellationViews();
    expect(views().map((v) => [v.def.step, v.element])).toEqual(order.map((el, i) => [i, el]));
    // Over one cycle each constellation lights alone in its turn, then the ceiling rests.
    const period = order.length * CONSTELLATION_TIMING.stepSeconds + CONSTELLATION_TIMING.pauseSeconds;
    const seen: (number | null)[] = [];
    for (let t = 0; t < period; t += BOT_DT) {
      const lit = views().filter((v) => v.lit).map((v) => v.def.step);
      expect(lit.length).toBeLessThanOrEqual(1);
      const step = lit[0] ?? null;
      if (seen[seen.length - 1] !== step) seen.push(step);
      s.bot.step();
    }
    expect(seen.filter((x) => x !== null).slice(0, 3).sort()).toEqual([0, 1, 2]);
    expect(seen).toContain(null);
  });

  it('solves pz_observatory_1 with the party’s Elements within 15 s of the first right one; the ring lift runs up to cp_observatory_1', () => {
    const s = setup('ms7_constellation');
    s.place(OBSERVATORY.route[3]?.pos ?? OBSERVATORY.entrance.pos, yawFromDir(0, -1));
    const order = observatoryOrder(SEED);
    const upLift = lift('lift_observatory_up');
    expect(s.sim.challenge.liftRuns(upLift)).toBe(false);
    for (const [i, element] of order.entries()) {
      s.bot.switchTo(`step ${i + 1}`, CHARACTER_OF[element]);
      s.bot.strike(`step ${i + 1}`, pedestal(element).pos, () => (s.sim.puzzles.runtime(PUZZLE)?.step ?? 0) > i || s.sim.puzzles.isSolved(PUZZLE), 1.9, 8);
    }
    expect(s.sim.puzzles.isSolved(PUZZLE)).toBe(true);
    const progress = s.events.filter((e) => e.type === 'puzzle:progress');
    const solvedAt = s.events.find((e) => e.type === 'puzzle:solved')?.t ?? Infinity;
    expect(progress).toHaveLength(2);
    expect(solvedAt - (progress[0]?.t ?? 0)).toBeLessThanOrEqual(15);
    expect(s.of('puzzle:failed')).toEqual([]);
    expect(s.gameState.world.puzzles).toContain(PUZZLE);
    s.bot.idle(0.1);
    expect(s.objective()).toBe('ms7_waves');
    expect(s.sim.challenge.liftRuns(upLift)).toBe(true);
    // Every pedestal of the order is lit; the decoy stays dark.
    const view = s.sim.puzzles.views().find((v) => v.id === PUZZLE);
    expect(view?.parts.map((p) => [p.id, p.active])).toEqual([...order.map((el) => [partOf(el), true]), [expect.any(String), false]]);
    s.bot.ride('ring lift', 'lift_observatory_up');
    expect(s.bot.pos.y).toBeCloseTo(OBSERVATORY_Y.ring, 1);
    expect(s.gameState.checkpoint).toEqual({ area: 'observatory', id: 'cp_observatory_1' });
    expect(s.sim.challenge.constellationViews().every((v) => v.lit && v.solved)).toBe(true);
  });

  it('a wrong pedestal, a wrong Element or running out of the 15 s resets the attempt; from the 3rd failure the hint shows', () => {
    const s = setup('ms7_constellation');
    s.place(OBSERVATORY.route[3]?.pos ?? OBSERVATORY.entrance.pos);
    const [first, second, third] = observatoryOrder(SEED);
    if (first === undefined || second === undefined || third === undefined) throw new Error('order');
    const decoy = OBSERVATORY_PEDESTALS.find((p) => ![first, second, third].includes(p.element));
    if (decoy === undefined) throw new Error('no decoy');
    const rt = () => s.sim.puzzles.runtime(PUZZLE);
    const state = (el: ElementId) => s.sim.puzzles.device(partOf(el))?.stateAt(s.sim.devices.time);
    // Wrong pedestal after a right first step.
    s.hitPart(partOf(first), first);
    s.bot.step();
    expect(rt()).toMatchObject({ step: 1, solved: false });
    expect(state(first)).toBe('lit');
    s.hitPart(`${PUZZLE}_${decoy.id}`, decoy.element);
    s.bot.step();
    expect(rt()).toMatchObject({ step: 0, startedAt: null, failures: 1 });
    expect(state(first)).toBe('dark');
    // The right pedestal with the wrong Element.
    s.hitPart(partOf(first), first);
    s.hitPart(partOf(second), third);
    s.bot.step();
    expect(rt()).toMatchObject({ step: 0, failures: 2 });
    // Out of time: 15 s after the first right input the attempt is over.
    s.hitPart(partOf(first), first);
    s.bot.step();
    s.bot.idle(14.5);
    expect(rt()).toMatchObject({ step: 1, failures: 2 });
    s.bot.idle(0.7);
    expect(rt()).toMatchObject({ step: 0, startedAt: null, failures: 3 });
    expect(s.of('puzzle:failed').map((p) => (p as { cause: string }).cause)).toEqual(['order', 'order', 'timeout']);
    expect(state(first)).toBe('dark');
    expect(s.gameState.world.puzzles).not.toContain(PUZZLE);
    // It can be tried again and solved.
    for (const el of [first, second, third]) s.hitPart(partOf(el), el);
    s.bot.step();
    expect(s.sim.puzzles.isSolved(PUZZLE)).toBe(true);
  });
});

describe('the ring corridor’s shielded waves (Req 12.3)', () => {
  it('closes both ends and calls wave 1; 2 s after its clear comes wave 2; its clear opens the barriers and lights cp_observatory_2', () => {
    const s = setup('ms7_waves', solved);
    s.place(CP1.spot.pos, CP1.spot.yaw);
    expect(s.sim.challenge.doorOpen('obs_barrier_lift')).toBe(true);
    expect(s.sim.challenge.doorOpen('obs_barrier_stair')).toBe(false);
    expect(s.members(WAVE_1)).toEqual([]);
    const [enter] = pts('ring').slice(1);
    s.bot.walk('into the corridor', [enter ?? CP1.spot.pos], 0.4);
    expect(s.sim.challenge.roomLocked('observatory_waves')).toBe(true);
    s.bot.step();
    expect(s.sim.challenge.doorOpen('obs_barrier_lift')).toBe(false);
    expect(s.sim.challenge.liftRuns(lift('lift_observatory_down'))).toBe(false);
    const wave1 = s.members(WAVE_1);
    expect(wave1.map((e) => e.def).sort()).toEqual(['aetherSentinel', 'windcutter', 'windcutter']);
    for (const e of wave1) expect(e.pos.y).toBeCloseTo(OBSERVATORY_Y.ring, 3);
    expect(s.sim.challenge.currentWave('observatory_waves')).toBe(WAVE_1);
    for (const e of wave1) s.hit(e.id);
    s.bot.step();
    expect(s.of('camp:cleared')).toEqual([{ campId: WAVE_1, regionId: 'azure' }]);
    expect(s.gameState.world.flags[roomClearedFlag(WAVE_1)]).toBe(true);
    expect(s.objective()).toBe('ms7_waves'); // wave 1 is not the quest's `defeat observatory_waves`
    const clearedAt = s.sim.devices.time;
    s.bot.idle(OBSERVATORY_WAVE_DELAY - 0.2);
    expect(s.members(WAVE_2)).toEqual([]);
    expect(s.sim.challenge.waveDueIn('observatory_waves')).toBeGreaterThan(0);
    s.bot.waitUntil('wave 2', () => s.members(WAVE_2).length > 0, 1);
    expect(s.sim.devices.time - clearedAt).toBeGreaterThanOrEqual(OBSERVATORY_WAVE_DELAY - 1e-9);
    expect(s.sim.devices.time - clearedAt).toBeLessThan(OBSERVATORY_WAVE_DELAY + 0.1);
    const wave2 = s.members(WAVE_2);
    expect(wave2.map((e) => e.def)).toEqual(['aetherSentinel', 'aetherSentinel']);
    expect(wave2.every((e) => e.element.shield?.element === 'ember' && e.element.shield.durability === 400)).toBe(true);
    expect(s.sim.challenge.doorOpen('obs_barrier_stair')).toBe(false);
    for (const e of wave2) s.hit(e.id);
    s.bot.step();
    expect(s.of('camp:cleared')).toEqual([{ campId: WAVE_1, regionId: 'azure' }, { campId: WAVE_2, regionId: 'azure' }]);
    expect(s.objective()).toBe('ms7_prime');
    expect(s.sim.challenge.isRoomCleared('observatory_waves')).toBe(true);
    s.bot.step();
    expect(s.sim.challenge.doorOpen('obs_barrier_lift')).toBe(true);
    expect(s.sim.challenge.doorOpen('obs_barrier_stair')).toBe(true);
    s.bot.walk('to the dome stairs', pts('ring').slice(2));
    expect(s.gameState.checkpoint).toEqual({ area: 'observatory', id: 'cp_observatory_2' });
    // The stairs lead up to the dome (y 150).
    s.bot.walk('dome stairs', pts('stair'));
    expect(s.bot.pos.y).toBeCloseTo(OBSERVATORY_Y.dome, 1);
  });

  it('switches each wave-2 Aether Sentinel’s Element_Shield ember → tide → gale → terra every 10 s from its arrival', () => {
    const s = setup('ms7_waves', (gs) => {
      solved(gs);
      gs.world.flags[roomClearedFlag(WAVE_1)] = true;
    });
    s.place(CP1.spot.pos, CP1.spot.yaw);
    s.bot.walk('into the corridor', pts('ring').slice(1, 2), 0.4);
    const sentinels = s.members(WAVE_2);
    expect(sentinels).toHaveLength(2); // wave 1 is cleared: the lock calls wave 2 at once
    // Their shields were raised as the wave arrived.
    const raisedAt = sentinels.map((e) => e.shieldSince);
    expect(new Set(raisedAt).size).toBe(1);
    const spawnedAt = raisedAt[0] ?? 0;
    s.place(CP1.spot.pos, CP1.spot.yaw); // back on the landing, out of their sight: they stay idle at their spawns
    const shields = () => sentinels.map((e) => s.sim.enemies.get(e.id)?.element.shield);
    expect(shields().map((sh) => [sh?.element, sh?.durability])).toEqual([['ember', 400], ['ember', 400]]);
    const seen: ElementId[][] = [];
    for (let n = 1; n <= 3; n++) {
      s.bot.waitUntil(`just before switch ${n}`, () => s.sim.enemies.simTime - spawnedAt >= 10 * n - 3 * BOT_DT, 11);
      expect(shields().map((sh) => sh?.element)).toEqual(seen.length === 0 ? ['ember', 'ember'] : seen[seen.length - 1]);
      s.bot.idle(4 * BOT_DT);
      seen.push(shields().map((sh) => sh?.element ?? 'ember'));
    }
    expect(seen).toEqual([['tide', 'tide'], ['gale', 'gale'], ['terra', 'terra']]);
    for (const sh of shields()) expect(sh?.max).toBe(400);
  });
});

describe('the dome: Sentinel Prime, Skyshard 3 and the balcony glide (Req 12.3, 12.9)', () => {
  it('Sentinel Prime and its two drones guard the dome; its defeat opens the star cage, Skyshard 3 the balcony gate and the glide lands safely', () => {
    const s = setup('ms7_prime', wavesCleared);
    const prime = s.members('sentinelPrime');
    expect(prime.map((e) => e.def)).toEqual(['sentinelPrime']);
    expect(prime[0]?.pos.y).toBeCloseTo(OBSERVATORY_Y.dome, 3);
    expect(flat(prime[0]?.pos ?? { x: 0, z: 0 }, OBSERVATORY.arena.center)).toBeLessThan(OBSERVATORY.arena.radius);
    expect(prime[0]?.element.shield).toMatchObject({ element: 'ember', durability: 400 });
    const drones = s.sim.enemies.drones();
    expect(drones.map((d) => d.owner)).toEqual([prime[0]?.id, prime[0]?.id]);
    for (const d of drones) {
      expect(flat(d.pos, prime[0]?.pos ?? { x: 0, z: 0 })).toBeCloseTo(3, 3);
      expect(d.pos.y - OBSERVATORY_Y.dome).toBeCloseTo(3.5, 3);
    }
    expect(s.sim.challenge.doorOpen('obs_cage_skyshard')).toBe(false);
    expect(s.sim.challenge.doorOpen('obs_gate_balcony')).toBe(false);
    // On the dome the Prime engages and its drones fire their bolts at the party.
    s.place(pts('dome')[0] ?? OBSERVATORY.arena.center, yawFromDir(1, 0));
    s.bot.waitUntil('a drone bolt', () => s.events.some((e) => e.type === 'enemy:telegraph' && (e.payload as { entityId: string }).entityId.includes('_drone_')), 8);
    // A drone falls on its own; the other goes with the Prime.
    const [d1] = s.sim.enemies.drones();
    if (d1 === undefined) throw new Error('no drone');
    s.hit(d1.id);
    expect(s.sim.enemies.drones()).toHaveLength(1);
    s.hit(prime[0]?.id ?? '');
    s.bot.idle(0.1);
    expect(s.gameState.world.elites).toContain('sentinelPrime');
    expect(s.sim.enemies.drones()).toEqual([]);
    expect(s.objective()).toBe('ms7_skyshard');
    expect(s.sim.challenge.doorOpen('obs_cage_skyshard')).toBe(true);
    const pedestal3 = s.sim.stubs.pedestals.find((p) => p.def.index === 3);
    if (pedestal3 === undefined) throw new Error('no pedestal 3');
    expect(pedestal3.pos).toEqual(OBSERVATORY.skyshard.pos);
    s.bot.interact('skyshard', 'skyshard', 'skyshard_3', pedestal3.pos);
    s.bot.settle();
    expect(s.gameState.skyshards).toBe(3);
    expect(s.objective()).toBe('ms8_light_pillar');
    s.bot.step();
    expect(s.sim.challenge.doorOpen('obs_gate_balcony')).toBe(true);
    expect(s.sim.challenge.fallJudgement('observatory')).toBe(false);
    // The balcony glide: off the tip toward the crater on the base Stamina, down onto the slope below, no recovery.
    s.bot.walk('balcony', pts('dome').slice(-1));
    s.bot.rest('balcony', STAMINA_RULES.baseMax);
    const start = { ...s.bot.pos };
    const hpBefore = s.gameState.party.hp[s.gameState.party.active];
    const { used, glided } = s.bot.glideToward('exit glide', OBSERVATORY.exitGlide.start, OBSERVATORY.exitGlide.toward);
    expect(glided).toBe(true);
    expect(s.sim.recovery.active).toBe(false);
    expect(used).toBeLessThanOrEqual(STAMINA_RULES.baseMax);
    expect(s.sim.player.state.grounded).toBe(true);
    expect(s.bot.pos.y).toBeCloseTo(terrain.heightAt(s.bot.pos.x, s.bot.pos.z), 0);
    expect(flat(s.bot.pos, start)).toBeGreaterThan(100); // well down the slope toward the crater
    expect(flat(s.bot.pos, OBSERVATORY.exitGlide.toward)).toBeLessThan(flat(start, OBSERVATORY.exitGlide.toward) - 100);
    expect(s.gameState.party.hp[s.gameState.party.active]).toBe(hpBefore);
    expect(s.sim.challenge.current).toBeNull();
    expect(s.sim.recovery.checkpointOverride).toBeNull();
  });
});

describe('Observatory checkpoints and the Party_Wipe restart (Req 12.7, 12.8)', () => {
  it('a fall from the dome stairs into the courtyard fades back to cp_observatory_2 within 1 s', () => {
    const s = setup('ms7_prime', wavesCleared);
    s.place(CP2.spot.pos, CP2.spot.yaw);
    expect(s.sim.recovery.checkpointOverride?.spot.pos).toEqual(CP2.spot.pos);
    const [court] = OBSERVATORY.hazards;
    if (court === undefined) throw new Error('no courtyard');
    s.place({ x: court.center.x, y: terrain.heightAt(court.center.x, court.center.z + 3), z: court.center.z + 3 });
    expect(s.sim.recovery.reason).toBe('hazard');
    let ticks = 0;
    while (s.sim.recovery.active) {
      s.bot.step();
      ticks++;
    }
    expect(ticks * BOT_DT).toBeLessThanOrEqual(Math.min(1, RECOVERY_FADE_OUT + RECOVERY_FADE_IN + BOT_DT));
    expect(flat(s.bot.pos, CP2.spot.pos)).toBeLessThan(0.05);
    expect(s.bot.pos.y).toBeCloseTo(CP2.spot.pos.y, 1);
  });

  it('a Party_Wipe in wave 2 restarts on cp_observatory_1 with the puzzle solved, wave 1 cleared and wave 2 whole again', () => {
    const s = setup('ms7_waves', (gs) => {
      solved(gs);
      gs.world.flags[checkpointFlag('cp_observatory_1')] = true;
    });
    s.place(CP1.spot.pos, CP1.spot.yaw);
    s.bot.walk('into the corridor', pts('ring').slice(1, 2), 0.4);
    expect(s.members(WAVE_1)).toHaveLength(3);
    for (const e of s.members(WAVE_1)) s.hit(e.id);
    s.bot.idle(OBSERVATORY_WAVE_DELAY + 0.2);
    const wave2 = s.members(WAVE_2);
    expect(wave2).toHaveLength(2);
    const [hurt] = wave2;
    if (hurt === undefined) throw new Error('no wave 2');
    s.hit(hurt.id, 900); // its shield broken and some HP gone
    expect(s.sim.enemies.get(hurt.id)?.element.shield).toBeNull();
    for (const id of PARTY_SLOTS) s.gameState.party.hp[id] = 1;
    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.bot.step();
    expect(flat(s.bot.pos, CP1.spot.pos)).toBeLessThan(0.05);
    for (const id of PARTY_SLOTS) expect(s.gameState.party.hp[id], id).toBe(s.sim.party.maxHp(id));
    expect(s.sim.puzzles.isSolved(PUZZLE)).toBe(true);
    expect(s.sim.challenge.liftRuns(lift('lift_observatory_up'))).toBe(true);
    expect(s.sim.challenge.roomLocked('observatory_waves')).toBe(false);
    const again = s.members(WAVE_2);
    expect(again).toHaveLength(2);
    for (const e of again) {
      expect(e.hp).toBe(e.maxHp);
      expect(e.element.shield).toMatchObject({ element: 'ember', durability: 400 });
    }
    // Back into the corridor: locked again with wave 2, and wave 1 stays cleared.
    s.bot.walk('back into the corridor', pts('ring').slice(1, 2), 0.4);
    expect(s.sim.challenge.roomLocked('observatory_waves')).toBe(true);
    s.bot.idle(0.2);
    expect(s.members(WAVE_1)).toEqual([]);
    expect(s.members(WAVE_2)).toHaveLength(2);
    expect(s.sim.challenge.currentWave('observatory_waves')).toBe(WAVE_2);
  });

  it('a Party_Wipe mid-sequence drops the attempt in progress; a load after the waves keeps the corridor open', () => {
    const s = setup('ms7_constellation');
    s.place(OBSERVATORY.route[3]?.pos ?? OBSERVATORY.entrance.pos);
    const [first] = observatoryOrder(SEED);
    if (first === undefined) throw new Error('order');
    s.hitPart(partOf(first), first);
    s.bot.step();
    expect(s.sim.puzzles.runtime(PUZZLE)?.step).toBe(1);
    for (const id of PARTY_SLOTS) s.gameState.party.hp[id] = 1;
    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.bot.step();
    expect(flat(s.bot.pos, OBSERVATORY.entrance.pos)).toBeLessThan(0.05); // no checkpoint yet: the entrance
    expect(s.sim.puzzles.runtime(PUZZLE)).toMatchObject({ step: 0, startedAt: null, solved: false });

    const loaded = setup('ms7_prime', wavesCleared);
    loaded.place(CP2.spot.pos, CP2.spot.yaw);
    loaded.bot.idle(0.2);
    expect(loaded.sim.challenge.roomLocked('observatory_waves')).toBe(false);
    expect(loaded.members(WAVE_1)).toEqual([]);
    expect(loaded.members(WAVE_2)).toEqual([]);
    expect(loaded.sim.challenge.doorOpen('obs_barrier_stair')).toBe(true);
  });
});

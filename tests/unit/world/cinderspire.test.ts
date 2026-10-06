import { beforeAll, describe, expect, it } from 'vitest';
import { seeContextCinematics } from '../helpers/seenCinematics';
import type { GameEventName } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import {
  CINDERSPIRE, CINDERSPIRE_CLUSTER_PARTS, CINDERSPIRE_DEVICES, CINDERSPIRE_EXIT_END, type AreaLegDef, type AreaUpdraftDef,
  type RestLedgeId,
} from '../../../src/data/challengeAreas';
import { MAIN_QUEST } from '../../../src/data/quests';
import { HEAT_CRYSTAL_COOL_SECONDS, HEAT_CRYSTAL_WARNING_SECONDS, UNSTABLE_CRYSTAL } from '../../../src/data/receivers';
import { AREA_VOLUMES, volumeContains } from '../../../src/data/volumes';
import { InputState } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { STAMINA_RULES } from '../../../src/logic/stamina';
import { PlaySim } from '../../../src/playSim';
import { CAPSULE_HEIGHT, CLIMB_CHEST_HEIGHT } from '../../../src/player/core/constants';
import { RECOVERY_FADE_IN, RECOVERY_FADE_OUT } from '../../../src/player/recovery';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';
import { BOT_DT, RouteBot } from '../helpers/routeBot';

// Cinderspire in the play session (task 9.7; design "Cinderspire", "체크포인트와 실패 처리"; Req 12.2, 12.6–12.9, 13.8,
// 13.9, 2.3), on the real terrain: the mandatory climbs and the Updraft flights on base Stamina through the real
// controller, the Heat_Crystal wall's 10 s and its warning, a reheated wall dropping its climber, the Unstable_Crystal
// blasts and vent ledges, pz_cinderspire_1, Cinder Alpha → Skyshard 2 → the exit stairs, checkpoints and the fall
// judgement.

const SEED = 20240601;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const legOf = <K extends AreaLegDef['kind']>(id: string, kind: K): Extract<AreaLegDef, { kind: K }> => {
  const leg = CINDERSPIRE.legs.find((l) => l.id === id);
  if (leg?.kind !== kind) throw new Error(`no ${kind} leg ${id}`);
  return leg as Extract<AreaLegDef, { kind: K }>;
};
const ledge = (id: RestLedgeId): Vec3 => {
  const l = CINDERSPIRE.ledges.find((x) => x.id === id);
  if (l === undefined) throw new Error(`no ledge ${id}`);
  return l.center;
};
const column = (i: 0 | 1): AreaUpdraftDef => {
  const u = CINDERSPIRE.updrafts[i];
  if (u === undefined) throw new Error('no updraft');
  return u;
};
const [CP1, CP2] = CINDERSPIRE.checkpoints;
if (CP1 === undefined || CP2 === undefined) throw new Error('Cinderspire checkpoints missing');
const WALL = 'cs_heat_wall';
const WALL_PART = 'pz_cinderspire_1_wall';

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

function setup(objective: string, prep?: (gs: GameState) => void) {
  const gameState = createNewGameState(SEED);
  gameState.party.joined = [...PARTY_SLOTS];
  gameState.skyshards = 1;
  gameState.party.level = 4;
  at(gameState, objective);
  seeContextCinematics(gameState); // task 21.2: the Landmark / area cinematics of the way here were seen
  prep?.(gameState);
  const input = new InputState();
  const commands = new UiCommandQueue();
  let bot: RouteBot | null = null;
  const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: (p) => bot?.onWipe(p), ending: () => {} } });
  bot = new RouteBot(sim, input, commands, 400);
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  sim.quests.resume();
  const b = bot;
  /** Stands the Active_Character at `pos` facing `yaw` and ticks once. */
  const place = (pos: Vec3, yaw = 0): void => {
    sim.player.teleport({ ...pos }, yaw);
    b.cameraYaw = yaw;
    b.step();
  };
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  const now = (): number => sim.devices.time;
  const wallView = () => sim.challenge.heatWallViews().find((w) => w.def.id === WALL);
  const hp = (): number => gameState.party.hp[gameState.party.active];
  /** A hit carrying `element` on a placed device, through its hit receiver (the field's judgement is the combat tests'). */
  const hitDevice = (part: string, element: 'ember' | 'tide'): void => {
    for (const r of sim.devices.hitTargets()) {
      if (r.id !== part) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 50, crit: false, element,
        stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      });
    }
  };
  return { sim, gameState, bot: b, events, commands, place, of, now, wallView, hp, hitDevice };
}

describe('Cinderspire on base Stamina (Req 12.6, 2.3)', () => {
  it('climbs C1, H1 and C3 from their ledges to the next with ≤ 70 of the base 100 Stamina each', () => {
    const s = setup('ms5_ledge_1');
    expect(s.sim.runtime.stamina.max).toBe(STAMINA_RULES.baseMax);
    const used: Record<string, number> = {};
    const c1 = legOf('C1', 'climb');
    s.place(ledge('L1'), c1.face);
    used.C1 = s.bot.climb('C1', c1.foot, c1.face, c1.toY);
    expect(s.bot.pos.y).toBeCloseTo(ledge('L2').y, 1);
    expect(flat(s.bot.pos, ledge('L2'))).toBeLessThan(3.5);
    // H1 once Isla's Tide has cooled the wall.
    const h1 = legOf('H1', 'climb');
    s.place(ledge('L3'), h1.face);
    s.bot.switchTo('isla', 'isla');
    s.bot.rest('L3', 100);
    s.bot.strike('tide', CINDERSPIRE_DEVICES.heatWall, () => s.sim.challenge.heatWallClimbable(WALL), 3);
    used.H1 = s.bot.climb('H1', h1.foot, h1.face, h1.toY);
    expect(s.bot.pos.y).toBeCloseTo(ledge('L4').y, 1);
    const c3 = legOf('C3', 'climb');
    s.bot.rest('L4', 100);
    used.C3 = s.bot.climb('C3', c3.foot, c3.face, c3.toY);
    expect(s.bot.pos.y).toBeCloseTo(ledge('L5').y, 1);
    for (const [id, u] of Object.entries(used)) {
      expect(u, id).toBeGreaterThan(40);
      expect(u, id).toBeLessThanOrEqual(0.7 * STAMINA_RULES.baseMax);
    }
    expect(s.sim.runtime.stamina.exhausted).toBe(false);
  });

  it('rides U1 from L2 onto L3 and U2 from L5 onto the summit arena, each within the base Stamina', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_1' };
    });
    const u1 = legOf('U1', 'updraft');
    s.place(ledge('L2'), u1.jump.yaw);
    const flight1 = s.bot.glideUpdraft('U1', u1.jump, column(0), ledge('L3'), legOf('G1', 'glide').toY);
    expect(flat(s.bot.pos, ledge('L3'))).toBeLessThan(6);
    expect(s.gameState.checkpoint?.id).toBe('cp_cinderspire_1'); // no fall judgement on the way
    const u2 = legOf('U2', 'updraft');
    s.place(ledge('L5'), u2.jump.yaw);
    s.bot.rest('L5', 100); // the rest ledge refills what U1 and G1 used
    const flight2 = s.bot.glideUpdraft('U2', u2.jump, column(1), CINDERSPIRE.arena.center, legOf('G2', 'glide').toY);
    expect(flat(s.bot.pos, CINDERSPIRE.arena.center)).toBeLessThan(CINDERSPIRE.arena.radius);
    for (const f of [flight1, flight2]) expect(f).toBeLessThan(STAMINA_RULES.baseMax);
    expect(s.sim.recovery.active).toBe(false);
  });
});

describe('the H1 Heat_Crystal wall (Req 13.8)', () => {
  it('is climbable for 10 s after Isla’s Tide, flashing its warning for the last 2 s, then hot again', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.party.active = 'isla';
    });
    const h1 = legOf('H1', 'climb');
    s.place(ledge('L3'), h1.face);
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(false);
    expect(s.wallView()).toMatchObject({ cooled: false, cooledLeft: 0, warning: false });
    // Hot, the wall is not in the climb query: nothing to hold on to in front of it.
    const onWall: Vec3 = { x: h1.foot.x, y: 57, z: h1.foot.z };
    expect(s.sim.collision.closestSurface(onWall, 0.9, { mask: 'climb' })).toBeNull();
    s.bot.strike('tide', CINDERSPIRE_DEVICES.heatWall, () => s.sim.challenge.heatWallClimbable(WALL), 3);
    const left = s.wallView()?.cooledLeft ?? 0;
    expect(left).toBeGreaterThan(HEAT_CRYSTAL_COOL_SECONDS - 0.5); // the strike helper idles 0.25 s after the hit
    expect(left).toBeLessThanOrEqual(HEAT_CRYSTAL_COOL_SECONDS);
    const cooledAt = s.now() - (HEAT_CRYSTAL_COOL_SECONDS - left);
    expect(s.sim.collision.closestSurface(onWall, 0.9, { mask: 'climb' })).not.toBeNull();
    expect(s.sim.puzzles.runtime('pz_cinderspire_1')).toMatchObject({ active: [WALL_PART], solved: false });
    expect(s.of('puzzle:progress')).toEqual([{ puzzleId: 'pz_cinderspire_1', step: 1, total: 2 }]);
    s.bot.waitUntil('before the warning', () => s.now() - cooledAt >= HEAT_CRYSTAL_COOL_SECONDS - HEAT_CRYSTAL_WARNING_SECONDS - 0.1, 10);
    expect(s.wallView()).toMatchObject({ cooled: true, warning: false });
    s.bot.idle(0.2);
    expect(s.wallView()).toMatchObject({ cooled: true, warning: true });
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(true);
    s.bot.waitUntil('hot again', () => s.now() - cooledAt >= HEAT_CRYSTAL_COOL_SECONDS + BOT_DT, 5);
    s.bot.step();
    expect(s.wallView()).toMatchObject({ cooled: false, cooledLeft: 0, warning: false });
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(false);
    expect(s.sim.collision.closestSurface(onWall, 0.9, { mask: 'climb' })).toBeNull();
    expect(s.gameState.world.puzzles).not.toContain('pz_cinderspire_1');
  });

  it('drops a climber whose wall heats up again back onto L3 below it', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.party.active = 'isla';
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_1' };
    });
    const h1 = legOf('H1', 'climb');
    s.place(ledge('L3'), h1.face);
    s.bot.strike('tide', CINDERSPIRE_DEVICES.heatWall, () => s.sim.challenge.heatWallClimbable(WALL), 3);
    s.bot.walkTo('foot', h1.foot, 0.45);
    // Up for about 1.5 s, then hang on (climbIdle) until the cooling runs out.
    s.bot.cameraYaw = h1.face;
    let climbed = 0;
    s.bot.hold(['KeyW']);
    while (climbed < 90) {
      s.bot.step();
      if (s.sim.player.state.mode === 'climb') climbed++;
      if (s.bot.t > 30) throw new Error(`no climb (at ${s.bot.where()})`);
    }
    s.bot.hold([]);
    const hangY = s.sim.player.state.pos.y;
    expect(hangY).toBeGreaterThan(ledge('L3').y + 2);
    s.bot.waitUntil('off the wall', () => s.sim.player.state.mode !== 'climb', HEAT_CRYSTAL_COOL_SECONDS);
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(false);
    s.bot.waitUntil('landed', () => s.sim.player.state.grounded, 3);
    expect(s.sim.player.state.pos.y).toBeCloseTo(ledge('L3').y, 1);
    expect(s.sim.recovery.active).toBe(false);
    expect(s.gameState.world.puzzles).not.toContain('pz_cinderspire_1');
  });

  it('pz_cinderspire_1 is allOf: the L4 arrival alone does not solve it, with the wall cooled it does and the wall stays cooled', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_1' };
    });
    s.place(ledge('L4'));
    expect(s.sim.puzzles.runtime('pz_cinderspire_1')).toMatchObject({ active: ['pz_cinderspire_1_top'], solved: false });
    expect(s.gameState.checkpoint?.id).toBe('cp_cinderspire_2');
    s.bot.idle(0.1);
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms5_heat_crystal');
    s.hitDevice(WALL_PART, 'tide');
    s.bot.idle(0.1);
    expect(s.gameState.world.puzzles).toContain('pz_cinderspire_1');
    expect(s.of('puzzle:solved')).toContainEqual({ puzzleId: 'pz_cinderspire_1', regionId: 'ember' });
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms5_alpha');
    s.bot.idle(HEAT_CRYSTAL_COOL_SECONDS + 1);
    expect(s.wallView()).toMatchObject({ cooled: true, cooledLeft: Number.POSITIVE_INFINITY, warning: false });
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(true);
  });
});

describe('Unstable_Crystal clusters at the vents (Req 13.9)', () => {
  it('Ember primes a cluster: 1 s of Telegraph, then a 4 m blast that hurts the party and frees the vent ledge', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_1' };
    });
    const part = CINDERSPIRE_CLUSTER_PARTS.u1;
    const cluster = CINDERSPIRE_DEVICES.clusterU1;
    // Kairen on L2, 2 m from the cluster (inside the 4 m blast).
    const stand: Vec3 = { x: cluster.x + 1, y: cluster.y, z: cluster.z - 1.8 };
    s.place(stand);
    expect(s.sim.challenge.riserUp('cs_vent_ledge_1')).toBe(false);
    expect(s.sim.puzzles.bodySolid(part)).toBe(true);
    const tip: Vec3 = { x: CINDERSPIRE_DEVICES.ventLedgeU1.x, y: CINDERSPIRE_DEVICES.ventLedgeU1.y + 1, z: CINDERSPIRE_DEVICES.ventLedgeU1.z + 1.5 };
    expect(s.sim.collision.groundProbe(tip, 3)).toBeNull(); // nothing to stand on toward the vent yet
    const before = s.hp();
    s.hitDevice(part, 'ember');
    s.bot.step();
    const device = s.sim.puzzles.device(part);
    expect(device?.stateAt(s.now())).toBe('primed');
    expect(device?.telegraphLeft(s.now())).toBeGreaterThan(UNSTABLE_CRYSTAL.telegraph - 0.05);
    expect(s.gameState.world.puzzles).toContain('pz_cinderspire_2');
    s.bot.idle(UNSTABLE_CRYSTAL.telegraph - 0.1);
    expect(s.hp()).toBe(before);
    expect(s.sim.puzzles.partPresent(part)).toBe(true);
    s.bot.idle(0.2);
    expect(device?.stateAt(s.now())).toBe('exploded');
    expect(s.hp()).toBeLessThan(before);
    expect(s.sim.puzzles.bodySolid(part)).toBe(false);
    expect(s.sim.challenge.riserUp('cs_vent_ledge_1')).toBe(true);
    const ground = s.sim.collision.groundProbe(tip, 3);
    expect(ground?.walkable).toBe(true);
    expect(ground?.point.y).toBeCloseTo(cluster.y, 3);
  });

  it('a blast more than 4 m away hurts nobody; the freed ledge is a walk-off straight into U2', () => {
    const s = setup('ms5_alpha', (gs) => {
      gs.world.puzzles.push('pz_cinderspire_1');
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_2' };
    });
    s.place(ledge('L4'));
    expect(flat(ledge('L4'), CINDERSPIRE_DEVICES.clusterU2) + Math.abs(ledge('L4').y - CINDERSPIRE_DEVICES.clusterU2.y)).toBeGreaterThan(UNSTABLE_CRYSTAL.radius);
    const before = s.hp();
    s.hitDevice(CINDERSPIRE_CLUSTER_PARTS.u2, 'ember');
    s.bot.idle(UNSTABLE_CRYSTAL.telegraph + 0.2);
    expect(s.hp()).toBe(before);
    expect(s.sim.challenge.riserUp('cs_vent_ledge_2')).toBe(true);
    // Off the ledge's tip toward the column: the glider opens right in U2 and rises.
    const ledgeRiser = CINDERSPIRE.risers.find((r) => r.id === 'cs_vent_ledge_2');
    if (ledgeRiser === undefined) throw new Error('no vent ledge');
    const { center, yaw } = ledgeRiser.shape;
    const from = { pos: { x: center.x - Math.sin(yaw) * 0.5, y: ledge('L5').y, z: center.z - Math.cos(yaw) * 0.5 }, yaw };
    s.place(ledge('L5'), yaw);
    s.bot.rest('L5', 100);
    const used = s.bot.glideUpdraft('vent ledge', from, column(1), CINDERSPIRE.arena.center, legOf('G2', 'glide').toY);
    expect(used).toBeLessThan(STAMINA_RULES.baseMax);
    expect(flat(s.bot.pos, CINDERSPIRE.arena.center)).toBeLessThan(CINDERSPIRE.arena.radius);
  });
});

describe('the summit: Cinder Alpha, Skyshard 2 and the exit stairs (Req 12.2, 12.9)', () => {
  it('Cinder Alpha’s defeat opens the Skyshard cage; Skyshard 2 raises the stairs toward ws_ember and ends the fall judgement', () => {
    const s = setup('ms5_alpha', (gs) => {
      gs.world.puzzles.push('pz_cinderspire_1');
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_2' };
    });
    const alpha = [...s.sim.runtime.enemies.values()].filter((e) => e.campId === 'cinderAlpha' && e.state !== 'dead');
    expect(alpha.map((e) => e.def)).toEqual(['cinderAlpha']);
    expect(flat(alpha[0]?.pos ?? { x: 0, z: 0 }, CINDERSPIRE.arena.center)).toBeLessThan(CINDERSPIRE.arena.radius);
    expect(alpha[0]?.pos.y).toBeCloseTo(CINDERSPIRE.arena.center.y, 3);
    expect(s.sim.challenge.doorOpen('cs_door_skyshard')).toBe(false);
    expect(CINDERSPIRE.exitRisers.some((id) => s.sim.challenge.riserUp(id))).toBe(false);
    expect(s.sim.challenge.fallJudgement('cinderspire')).toBe(true);
    s.place(CINDERSPIRE.arena.center);
    for (const r of s.sim.enemies.receivers()) {
      if (r.id !== alpha[0]?.id) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount: 1e6, crit: false, element: null,
        stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
      });
    }
    s.bot.idle(0.1);
    expect(s.gameState.world.elites).toContain('cinderAlpha');
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms5_skyshard');
    expect(s.sim.challenge.doorOpen('cs_door_skyshard')).toBe(true);
    const pedestal = s.sim.stubs.pedestals.find((p) => p.def.index === 2);
    if (pedestal === undefined) throw new Error('no pedestal 2');
    expect(pedestal.pos).toEqual(CINDERSPIRE.skyshard.pos);
    s.bot.interact('skyshard', 'skyshard', 'skyshard_2', pedestal.pos);
    s.bot.settle();
    expect(s.gameState.skyshards).toBe(2);
    expect(s.of('skyshard:acquired')).toEqual([{ index: 2, regionId: 'ember' }]);
    s.bot.step();
    expect(CINDERSPIRE.exitRisers.every((id) => s.sim.challenge.riserUp(id))).toBe(true);
    expect(s.sim.challenge.fallJudgement('cinderspire')).toBe(false);
    // Down the stairs from the platform's west edge to the canyon floor toward ws_ember, outside the area.
    s.bot.walk('stairs', [{ x: CINDERSPIRE.arena.center.x - 15, z: CINDERSPIRE.arena.center.z }, CINDERSPIRE_EXIT_END]);
    s.bot.idle(0.5);
    expect(s.bot.pos.y).toBeCloseTo(terrain.heightAt(s.bot.pos.x, s.bot.pos.z), 1);
    expect(s.sim.challenge.current).toBeNull();
    expect(s.sim.recovery.checkpointOverride).toBeNull();
    expect(s.sim.recovery.active).toBe(false);
  });

  it('a load after Skyshard 2 has the stairs up and the cage open at once', () => {
    const s = setup('ms6_pass', (gs) => {
      gs.skyshards = 2;
      gs.world.puzzles.push('pz_cinderspire_1');
      gs.world.elites.push('cinderAlpha');
    });
    expect(CINDERSPIRE.exitRisers.every((id) => s.sim.challenge.riserUp(id))).toBe(true);
    expect(s.sim.challenge.doorOpen('cs_door_skyshard')).toBe(true);
    expect([...s.sim.runtime.enemies.values()].some((e) => e.campId === 'cinderAlpha')).toBe(false);
  });
});

describe('Cinderspire checkpoints and recovery (Req 12.7, 12.8)', () => {
  it('returns from the entrance, then L2’s rune; a fall onto the floor between the spires fades back to it within 1 s', () => {
    const s = setup('ms5_ledge_1');
    s.place(CINDERSPIRE.entrance.pos, CINDERSPIRE.entrance.yaw);
    expect(s.sim.challenge.current?.id).toBe('cinderspire');
    expect(s.sim.recovery.checkpointOverride).toEqual({ areaId: 'cinderspire', spot: { pos: CINDERSPIRE.entrance.pos, yaw: CINDERSPIRE.entrance.yaw } });
    s.place(CP1.spot.pos, CP1.spot.yaw);
    expect(s.gameState.checkpoint).toEqual({ area: 'cinderspire', id: 'cp_cinderspire_1' });
    expect(s.of('checkpoint:reached')).toEqual([{ areaId: 'cinderspire', checkpointId: 'cp_cinderspire_1', first: true }]);
    s.bot.idle(0.1);
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms5_ledge_2');
    // Fallen short of spire B: the ember floor is the fall judgement.
    const [floor] = CINDERSPIRE.hazards;
    if (floor === undefined) throw new Error('no hazard');
    s.place({ x: floor.center.x - 12, y: terrain.heightAt(floor.center.x - 12, floor.center.z), z: floor.center.z });
    expect(s.sim.recovery.reason).toBe('hazard');
    let ticks = 0;
    while (s.sim.recovery.active) {
      s.bot.step();
      ticks++;
    }
    expect(ticks * BOT_DT).toBeLessThanOrEqual(Math.min(1, RECOVERY_FADE_OUT + RECOVERY_FADE_IN + BOT_DT));
    expect(flat(s.bot.pos, CP1.spot.pos)).toBeLessThan(0.05);
    expect(s.bot.pos.y).toBeCloseTo(CP1.spot.pos.y, 1);
  });

  it('a Party_Wipe restarts at the latest checkpoint with the Heat_Crystal hot again; after Skyshard 2 the floor judges no falls', () => {
    const s = setup('ms5_ledge_2', (gs) => {
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_1' };
    });
    s.place(ledge('L3'));
    s.hitDevice(WALL_PART, 'tide');
    s.bot.step();
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(true);
    for (const id of PARTY_SLOTS) s.gameState.party.hp[id] = 1;
    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.bot.step();
    expect(flat(s.bot.pos, CP1.spot.pos)).toBeLessThan(0.05);
    for (const id of PARTY_SLOTS) expect(s.gameState.party.hp[id], id).toBe(s.sim.party.maxHp(id));
    expect(s.sim.challenge.heatWallClimbable(WALL)).toBe(false);
    expect(s.wallView()?.cooledLeft).toBe(0);

    const after = setup('ms6_pass', (gs) => {
      gs.skyshards = 2;
      gs.world.puzzles.push('pz_cinderspire_1');
      gs.world.elites.push('cinderAlpha');
      gs.checkpoint = { area: 'cinderspire', id: 'cp_cinderspire_2' };
    });
    const [floor] = CINDERSPIRE.hazards;
    if (floor === undefined) throw new Error('no hazard');
    after.place({ x: floor.center.x - 12, y: terrain.heightAt(floor.center.x - 12, floor.center.z), z: floor.center.z });
    after.bot.idle(1);
    expect(after.sim.recovery.active).toBe(false);
    expect(after.sim.challenge.fallJudgement('cinderspire')).toBe(false);
  });

  it('keeps the ms5 reach volumes on the rest ledges, not on the wall below them', () => {
    const cp2 = AREA_VOLUMES.find((v) => v.id === 'cp_cinderspire_2');
    if (cp2 === undefined) throw new Error('no cp_cinderspire_2 area');
    const h1 = legOf('H1', 'climb');
    // A climber on H1 just below its top (head over the lip) is not on L4 yet.
    expect(volumeContains(cp2.shape, { x: h1.foot.x, y: ledge('L4').y - CAPSULE_HEIGHT + CLIMB_CHEST_HEIGHT - 1, z: h1.foot.z })).toBe(false);
    expect(volumeContains(cp2.shape, ledge('L4'))).toBe(true);
  });
});

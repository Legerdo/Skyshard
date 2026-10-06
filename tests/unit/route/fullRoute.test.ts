import { describe, expect, it } from 'vitest';
import type { GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import type { Vec3 } from '../../../src/core/types';
import {
  CINDERSPIRE, CINDERSPIRE_DEVICES, CINDERSPIRE_EXIT_END, HOLLOWROOT, HOLLOWROOT_DEVICES, OBSERVATORY, OBSERVATORY_HALL_CENTER,
  OBSERVATORY_PEDESTALS,
} from '../../../src/data/challengeAreas';
import type { CharacterId, ElementId } from '../../../src/data/ids';
import { observatoryOrder } from '../../../src/data/puzzles';
import { MAIN_QUEST } from '../../../src/data/quests';
import { STARLIT_STAIR } from '../../../src/data/starlitStair';
import { InputState } from '../../../src/input/inputState';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { STAMINA_RULES } from '../../../src/logic/stamina';
import { PlaySim } from '../../../src/playSim';
import { buildTerrain } from '../../../src/world/terrain';
import { RouteBot } from '../helpers/routeBot';

// Minimal full route (task 4.9, M2 completion; Req 2.1, 2.9): a scripted player drives the headless session from
// New Game to cin_ending and the Victory Screen, then through "탐험 계속" to the end of the Main_Quest, with
// keyboard and mouse events and the camera yaw only. No debug path is used: every Objective completes from the
// events the world publishes (NPC dialogues read through with F, area volumes, the real Hollowroot Shrine, Cinderspire (its climbs, Updrafts
// and glides on base Stamina, Req 2.3, 12.6) and Starfall Observatory (its seeded constellation puzzle, shielded waves,
// Sentinel Prime and the balcony glide, Req 12.3, 12.9), lifts standing in for the other climbs / glides / Updrafts,
// encounter groups, Skyshard pedestals, the altar, Caelith, the cinematic stand-in).

const SEED = 20240601; // main.ts WORLD_SEED
const terrain = buildTerrain(SEED);
/** Who applies each Element to the Observatory's pedestals. */
const ELEMENT_CHARACTER: Readonly<Record<ElementId, CharacterId>> = { ember: 'kairen', tide: 'isla', gale: 'wren', terra: 'talus' };

function setup() {
  const gameState = createNewGameState(SEED);
  const input = new InputState();
  const commands = new UiCommandQueue();
  const log = { victory: 0, cinematics: [] as (string | null)[] };
  /** Every Party_Wipe: the Caelith Phase (null outside the fight), the Objective and the checkpoint it happened at. */
  const wipes: { phase: 1 | 2 | 3 | null; objective: string; checkpoint: GameState['checkpoint'] }[] = [];
  let bot: RouteBot | null = null;
  const sim = new PlaySim({
    gameState, terrain, input, commands,
    sinks: {
      partyWipe: (phase) => {
        wipes.push({ phase, objective: sim.quests.objectiveView('main')?.objective.id ?? '', checkpoint: gameState.checkpoint });
        bot?.onWipe(phase);
      },
      ending: () => log.victory++,
      cinematic: (id) => log.cinematics.push(id),
    },
  });
  bot = new RouteBot(sim, input, commands, 2400);
  const events: { t: number; type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ t: bot?.t ?? 0, type, payload }));
  return { sim, bot, gameState, events, log, commands, wipes };
}

const of = <T>(events: { type: GameEventName; payload: unknown }[], type: GameEventName): T[] =>
  events.filter((e) => e.type === type).map((e) => e.payload as T);
const flatDistance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe('minimal full route (headless)', () => {
  it('plays from New Game through all three Skyshards, the altar and Caelith to Victory and the end of the Main_Quest', () => {
    const { sim, bot, gameState, events, log, commands, wipes } = setup();
    // The NPCs (and the companions until they join) stand and walk where the NpcSystem puts them (task 13.2); the
    // live position follows a walking NPC.
    const npc = (id: Parameters<typeof sim.npcs.position>[0]): Readonly<Vec3> => {
      const n = sim.npcs.position(id);
      if (n === null) throw new Error(`no npc ${id}`);
      return n;
    };
    const pedestal = (index: number): Vec3 => {
      const p = sim.stubs.pedestals.find((s) => s.def.index === index);
      if (p === undefined) throw new Error(`no pedestal ${index}`);
      return p.pos;
    };
    const objective = (): string | undefined => sim.quests.objectiveView('main')?.objective.id;
    const expectObjective = (id: string): void => expect(objective(), `at ${bot.t.toFixed(1)} s, ${bot.where()}`).toBe(id);

    sim.begin();
    expectObjective('ms1_maren');

    // ── ms1 Thistlewick ──
    bot.interact('ms1 maren', 'npc', 'maren', npc('maren'));
    bot.interact('ms1 isla', 'npc', 'isla', npc('isla'));
    expect(gameState.party.joined).toContain('isla');
    bot.fight('ms1 raid', 'village_raid');
    bot.idle(0.2);
    bot.interact('ms1 report', 'npc', 'maren', npc('maren'));
    expectObjective('ms2_breezewatch');

    // ── ms2 Breezewatch → Elderbough ──
    bot.goTo('ms2 breezewatch', { x: -126, z: 247 });
    bot.ride('ms2 windmill', 'lift_breezewatch');
    bot.interact('ms2 wren', 'npc', 'wren', npc('wren'));
    expect(gameState.party.joined).toContain('wren');
    bot.ride('ms2 glide', 'glide_breezewatch');
    bot.idle(0.2);
    expectObjective('ms3_talus');

    // ── ms3 Hollowroot Shrine (task 9.6): the real Challenge_Area, solved with the party's Elements ──
    bot.interact('ms3 talus', 'npc', 'talus', npc('talus'));
    expect(gameState.party.joined).toEqual(['kairen', 'isla', 'wren', 'talus']);
    const shrine = (room: string): Vec3[] => HOLLOWROOT.route.filter((r) => r.room === room).map((r) => r.pos);
    const [r1Front, cp1] = shrine('R1');
    const [r3Arrival, ...r3Walk] = shrine('R3');
    const r3BeforeBoulder = r3Walk.findIndex((p) => flatDistance(p, HOLLOWROOT_DEVICES.boulder) < 2.5) + 1;
    bot.walk('ms3 spiral ramp', [...shrine('R0').slice(1), r1Front]);
    expect(sim.challenge.current?.id).toBe('hollowroot');
    // R1: Kairen's Ember combo finisher burns the bramble gate.
    bot.switchTo('ms3 kairen', 'kairen');
    bot.strike('ms3 bramble', HOLLOWROOT_DEVICES.bramble, () => sim.puzzles.isSolved('pz_hollowroot_1'), 2.2);
    bot.idle(0.2);
    expectObjective('ms3_wind_wheel');
    bot.walk('ms3 checkpoint 1', [cp1]);
    expect(gameState.checkpoint).toEqual({ area: 'hollowroot', id: 'cp_hollowroot_1' });
    // R2: Wren's Gale Skill spins the wind wheel; the root lift rises to the upper corridor.
    bot.walk('ms3 wind wheel', [shrine('R2')[0], { x: HOLLOWROOT_DEVICES.windWheel.x + 1.5, z: HOLLOWROOT_DEVICES.windWheel.z }]);
    bot.switchTo('ms3 wren', 'wren');
    bot.castSkill('ms3 wind wheel', HOLLOWROOT_DEVICES.windWheel, () => sim.puzzles.isSolved('pz_hollowroot_2'));
    bot.ride('ms3 root lift', 'lift_hollowroot_up');
    expect(flatDistance(bot.pos, r3Arrival)).toBeLessThan(0.5);
    // R3: Talus's pillar holds the plate while the party passes the root door 12 m on; Terra breaks the boulder.
    bot.switchTo('ms3 talus', 'talus');
    bot.castSkill('ms3 pillar', HOLLOWROOT_DEVICES.plate, () => sim.challenge.doorOpen('hr_door_root'), 3);
    bot.walk('ms3 root door', r3Walk.slice(0, r3BeforeBoulder));
    bot.strike('ms3 boulder', HOLLOWROOT_DEVICES.boulder, () => sim.puzzles.isSolved('pz_hollowroot_3'), 2);
    bot.idle(0.2);
    expect(sim.challenge.doorOpen('hr_door_root')).toBe(true); // fixed open once solved
    // R4: the room locks with the party inside until bramblekin ×4 and thornspitter ×2 fall.
    const [r4Entry, r4Center, r4Exit] = shrine('R4');
    bot.walk('ms3 descent', [...r3Walk.slice(r3BeforeBoulder), r4Entry]);
    bot.switchTo('ms3 kairen again', 'kairen');
    bot.walk('ms3 room', [r4Center], 3);
    bot.fight('ms3 room', 'hollowroot_room', r4Center);
    bot.idle(0.2);
    expect(sim.challenge.doorOpen('hr_door_room_out')).toBe(true);
    // R5: cp_hollowroot_2 in the corridor, then the Rootbound Warden in its 14 m arena.
    const [cp2, r5Inner] = shrine('R5');
    bot.walk('ms3 checkpoint 2', [r4Exit, cp2]);
    expect(gameState.checkpoint).toEqual({ area: 'hollowroot', id: 'cp_hollowroot_2' });
    bot.walk('ms3 arena', [r5Inner]);
    bot.fight('ms3 warden', 'rootboundWarden', HOLLOWROOT.arena.center);
    expect(gameState.world.elites).toContain('rootboundWarden');
    // R6: the Skyshard, then the root lift out to the Elderbough foot.
    bot.walk('ms3 skyshard room', shrine('R6'));
    bot.interact('ms3 skyshard', 'skyshard', 'skyshard_1', pedestal(1));
    bot.settle();
    expect(gameState.skyshards).toBe(1);
    expectObjective('ms4_ashgate');
    expect(sim.challenge.fallJudgement('hollowroot')).toBe(false);
    bot.ride('ms3 exit lift', 'lift_hollowroot_exit');
    expect(sim.challenge.current).toBeNull();

    // ── ms4 Ember Ravine ──
    bot.goTo('ms4 ashgate', { x: 50, z: 300 });
    bot.walk('ms4 through the gate', [{ x: 74, z: 296 }]);
    bot.goTo('ms4 bridge', { x: 168, z: 260 });
    bot.walk('ms4 plank', [{ x: 212, z: 243.6 }]);
    bot.goTo('ms4 durga', { x: npc('durga').x - 2, z: npc('durga').z });
    bot.interact('ms4 durga', 'npc', 'durga', npc('durga'));
    bot.goTo('ms4 pass', { x: 282, z: 168 });
    bot.fight('ms4 pack', 'ember_pass_pack');
    bot.goTo('ms4 cinderspire', { x: 327, z: 123 });
    expectObjective('ms5_ledge_1');

    // ── ms5 Cinderspire (task 9.7): the real Challenge_Area, walked, climbed and glided on the party's base Stamina ──
    const [, c1, u1, g1, h1, c3, u2, g2] = CINDERSPIRE.legs;
    const [column1, column2] = CINDERSPIRE.updrafts;
    if (c1?.kind !== 'climb' || u1?.kind !== 'updraft' || g1?.kind !== 'glide' || h1?.kind !== 'climb' || c3?.kind !== 'climb'
      || u2?.kind !== 'updraft' || g2?.kind !== 'glide' || column1 === undefined || column2 === undefined) throw new Error('Cinderspire legs');
    const ledge = (id: string): Vec3 => CINDERSPIRE.ledges.find((l) => l.id === id)?.center ?? bot.pos;
    const staminaBudget = 0.7 * STAMINA_RULES.baseMax; // Req 12.6: each mandatory climb within 70 % of the base 100
    bot.walk('ms5 foot ramp', CINDERSPIRE.route.map((r) => r.pos));
    expect(sim.challenge.current?.id).toBe('cinderspire');
    expect(bot.climb('ms5 C1', c1.foot, c1.face, c1.toY)).toBeLessThanOrEqual(staminaBudget);
    bot.walk('ms5 L2', [c1.top], 0.8);
    expect(gameState.checkpoint).toEqual({ area: 'cinderspire', id: 'cp_cinderspire_1' });
    expectObjective('ms5_ledge_2');
    bot.rest('ms5 L2');
    expect(bot.glideUpdraft('ms5 U1 → G1', u1.jump, column1, ledge('L3'), g1.toY)).toBeLessThan(100);
    // H1: Isla's Tide cools the Heat_Crystal wall for 10 s; the climb to L4 solves pz_cinderspire_1 and reaches cp 2.
    bot.switchTo('ms5 isla', 'isla');
    bot.strike('ms5 tide', CINDERSPIRE_DEVICES.heatWall, () => sim.challenge.heatWallClimbable('cs_heat_wall'), 3);
    expect(bot.climb('ms5 H1', h1.foot, h1.face, h1.toY)).toBeLessThanOrEqual(staminaBudget);
    bot.walk('ms5 L4', [h1.top], 0.6);
    bot.idle(0.2);
    expect(gameState.checkpoint).toEqual({ area: 'cinderspire', id: 'cp_cinderspire_2' });
    expect(gameState.world.puzzles).toContain('pz_cinderspire_1');
    expectObjective('ms5_alpha');
    bot.switchTo('ms5 kairen', 'kairen');
    // C3's mantle onto L5 only finds room from the leg's foot line westward (a solid body stands just east of the
    // landing), and where the H1 mantle left the character depends on the route's timing (dialogues, fights). So the
    // character lines up 0.2 m west of the foot line, 1.2 m back from the wall, and climbs straight in from there.
    const into = { x: Math.sin(c3.face), z: Math.cos(c3.face) };
    const c3Foot: Vec3 = { x: c3.foot.x - into.z * 0.2, y: c3.foot.y, z: c3.foot.z + into.x * 0.2 };
    bot.walk('ms5 C3 line-up', [{ x: c3Foot.x - into.x * 1.2, z: c3Foot.z - into.z * 1.2 }], 0.15);
    bot.rest('ms5 L4');
    expect(bot.climb('ms5 C3', c3Foot, c3.face, c3.toY)).toBeLessThanOrEqual(staminaBudget);
    bot.rest('ms5 L5');
    expect(bot.glideUpdraft('ms5 U2 → G2', u2.jump, column2, CINDERSPIRE.arena.center, g2.toY)).toBeLessThan(100);
    bot.fight('ms5 alpha', 'cinderAlpha', CINDERSPIRE.arena.center);
    expect(gameState.world.elites).toContain('cinderAlpha');
    bot.idle(0.2);
    expect(sim.challenge.doorOpen('cs_door_skyshard')).toBe(true);
    bot.interact('ms5 skyshard', 'skyshard', 'skyshard_2', pedestal(2));
    bot.settle();
    expect(gameState.skyshards).toBe(2);
    expectObjective('ms6_pass');
    expect(sim.challenge.fallJudgement('cinderspire')).toBe(false);
    // The crystal stairs risen from the summit's west edge lead down toward ws_ember (Req 12.9).
    expect(CINDERSPIRE.exitRisers.every((id) => sim.challenge.riserUp(id))).toBe(true);
    bot.walk('ms5 exit stairs', [{ x: CINDERSPIRE.arena.center.x - 15, z: CINDERSPIRE.arena.center.z }, CINDERSPIRE_EXIT_END]);
    bot.idle(0.5);
    expect(sim.challenge.current).toBeNull();

    // ── ms6 Azure Highlands ──
    bot.goTo('ms6 crater', { x: 0, z: -20 });
    bot.walk('ms6 north rim', [{ x: 40, z: -115 }]);
    bot.walk('ms6 gate', [{ x: 40, z: -134 }]);
    bot.goTo('ms6 oriel', { x: npc('oriel').x + 1.5, z: npc('oriel').z - 1 });
    bot.interact('ms6 oriel', 'npc', 'oriel', npc('oriel'));
    bot.ride('ms6 wind glide', 'glide_oriel');
    bot.ride('ms6 ridge climb', 'lift_azure_ridge');
    bot.fight('ms6 pack', 'azure_ridge_pack');
    expectObjective('ms7_hall');

    // ── ms7 Starfall Observatory (task 9.8): the real Challenge_Area, its seeded puzzle, waves and guardian ──
    bot.goTo('ms7 cliff', { x: 121, z: -355 });
    bot.ride('ms7 plateau', 'lift_observatory_cliff');
    const obs = (room: string): Vec3[] => OBSERVATORY.route.filter((r) => r.room === room).map((r) => r.pos);
    bot.walk('ms7 entrance', obs('entrance'));
    expect(sim.challenge.current?.id).toBe('observatory');
    const hall = obs('hall');
    bot.walk('ms7 hall', hall.slice(0, 3));
    bot.idle(0.2);
    expectObjective('ms7_constellation');
    // The ceiling shows the save-seeded order; each step's Element from its character, all within 15 s.
    const order = sim.puzzles.sequenceOrder('pz_observatory_1') ?? [];
    expect(order).toEqual(observatoryOrder(SEED));
    expect(sim.challenge.constellationViews().map((c) => c.element)).toEqual(order);
    for (const [i, element] of order.entries()) {
      const at = OBSERVATORY_PEDESTALS.find((p) => p.element === element)?.pos;
      if (at === undefined) throw new Error(`no pedestal for ${element}`);
      bot.switchTo(`ms7 step ${i + 1}`, ELEMENT_CHARACTER[element]);
      bot.strike(`ms7 pedestal ${i + 1}`, at, () => (sim.puzzles.runtime('pz_observatory_1')?.step ?? 0) > i || sim.puzzles.isSolved('pz_observatory_1'), 1.9, 8);
    }
    expect(sim.puzzles.isSolved('pz_observatory_1')).toBe(true);
    bot.idle(0.2);
    expectObjective('ms7_waves');
    bot.walk('ms7 to the ring lift', [...hall.slice(3)]);
    bot.ride('ms7 ring lift', 'lift_observatory_up');
    expect(gameState.checkpoint).toEqual({ area: 'observatory', id: 'cp_observatory_1' });
    // Ring corridor: stepping in closes both ends and calls wave 1; 2 s after its clear comes wave 2 (shielded).
    bot.switchTo('ms7 kairen', 'kairen');
    const ringCenter = OBSERVATORY_HALL_CENTER;
    bot.walk('ms7 into the corridor', obs('ring').slice(1, 2), 0.4);
    expect(sim.challenge.roomLocked('observatory_waves')).toBe(true);
    bot.fight('ms7 wave 1', 'observatory_wave_1', ringCenter);
    bot.fight('ms7 wave 2', 'observatory_waves', ringCenter);
    bot.idle(0.2);
    expectObjective('ms7_prime');
    // Around the oculus to cp_observatory_2 at the dome stairs' foot, then up to the dome and Sentinel Prime.
    const domeStairsRune = OBSERVATORY.checkpoints[1]?.spot.pos ?? ringCenter;
    bot.circleTo('ms7 to the dome stairs', ringCenter, 8.5, 0, flatDistance(domeStairsRune, ringCenter));
    expect(gameState.checkpoint).toEqual({ area: 'observatory', id: 'cp_observatory_2' });
    bot.walk('ms7 dome stairs', obs('stair'));
    bot.fight('ms7 prime', 'sentinelPrime', OBSERVATORY.arena.center);
    expect(gameState.world.elites).toContain('sentinelPrime');
    bot.idle(0.2);
    expect(sim.challenge.doorOpen('obs_cage_skyshard')).toBe(true);
    bot.interact('ms7 skyshard', 'skyshard', 'skyshard_3', pedestal(3));
    bot.settle();
    expect(gameState.skyshards).toBe(3);
    expect(sim.altar.pillarVisible).toBe(true);
    expectObjective('ms8_light_pillar');
    expect(sim.challenge.fallJudgement('observatory')).toBe(false);
    // The balcony gate opened with Skyshard 3: glide off it toward the crater's light pillar (Req 12.9), then walk
    // down through gate_azure.
    bot.idle(0.1);
    expect(sim.challenge.doorOpen(OBSERVATORY.exitGlide.door)).toBe(true);
    bot.walk('ms7 balcony', obs('dome').slice(-1));
    bot.rest('ms7 balcony', STAMINA_RULES.baseMax);
    const glide = bot.glideToward('ms7 exit glide', OBSERVATORY.exitGlide.start, OBSERVATORY.exitGlide.toward);
    expect(glide.glided).toBe(true);
    expect(sim.challenge.current).toBeNull();

    // ── ms8 Resonance_Altar and the Starlit_Stair ──
    bot.goTo('ms8 down to gate_azure', { x: 40, z: -134 });
    bot.walk('ms8 north rim', [{ x: 40, z: -115 }]);
    bot.goTo('ms8 crater', { x: 0, z: -24 });
    bot.walk('ms8 pillar', [{ x: 0, z: -9 }]);
    bot.interact('ms8 altar', 'altar', 'resonance_altar', { x: 0, y: 4, z: 0 }, 2.2);
    bot.settle();
    expect(gameState.altarActivated).toBe(true);
    bot.waitUntil('ms8 stair', () => sim.stair.active, 5);
    const [s1, s2, s3, s4, l1, l2, s6, s7, l3] = STARLIT_STAIR.platforms;
    const step = (p: typeof s1) => ({ x: p.x, z: p.z, top: p.topY, half: Math.min(p.halfX, p.halfZ) });
    bot.walk('ms8 stair start', [{ x: 20, z: -10 }]);
    bot.hopSteps('ms8 tier 1', [s1, s2, s3, s4, l1].map(step));
    bot.ride('ms8 updraft 1', 'lift_stair_1');
    expect(l2.topY).toBe(90);
    bot.hopSteps('ms8 tier 2', [s6, s7, l3].map(step));
    bot.ride('ms8 updraft 2', 'lift_stair_2');
    bot.walk('ms8 walkway', [{ x: 1, z: -52 }, { x: 0, z: -46 }, { x: 0, z: -40 }]);
    expectObjective('ms9_mural');

    // ── ms9 Astral Sanctum and Caelith ──
    bot.walk('ms9 hall', [{ x: 0, z: -30 }, { x: 0, z: -16 }]);
    bot.interact('ms9 mural', 'mural', 'sanctum_mural', sim.sanctum.mural, 2.2);
    bot.walk('ms9 arena', [{ x: 0, z: -4 }, { x: 0, z: 6 }]);
    bot.idle(0.2);
    expectObjective('ms9_caelith');
    bot.bossFight('ms9 caelith');
    bot.waitUntil('ms10 ending', () => log.victory > 0, 10);
    const victoryAt = bot.t;

    // ── ms10: Victory → "탐험 계속" → Thistlewick → Maren ──
    expectObjective('ms10_return');
    commands.push({ kind: 'continueExploring' }); // the Victory Screen's "탐험 계속"
    bot.idle(0.3);
    expectObjective('ms10_maren');
    bot.interact('ms10 maren', 'npc', 'maren', npc('maren'));
    expect(gameState.quests.main.done).toBe(true);

    // Every Main_Quest Objective completed once, in data order, from the world's own events.
    const completed = of<{ objectiveId: string }>(events, 'quest:objectiveCompleted').map((p) => p.objectiveId);
    expect(completed).toEqual(MAIN_QUEST.stages.flatMap((s) => s.objectives.map((o) => o.id)));
    expect(of<{ index: number }>(events, 'skyshard:acquired').map((p) => p.index)).toEqual([1, 2, 3]);
    expect(of<{ barrierId: string }>(events, 'barrier:opened').map((p) => p.barrierId)).toEqual([
      'gate_ember', 'veil_ember', 'gate_azure', 'veil_azure', 'seal_sanctum',
    ]);
    expect(of(events, 'altar:activated')).toHaveLength(1);
    expect(of<{ from: number; to: number }>(events, 'boss:phaseChanged')).toEqual([
      { bossId: 'caelith', from: 1, to: 2 },
      { bossId: 'caelith', from: 2, to: 3 },
    ]);
    expect(of(events, 'boss:defeated')).toEqual([{ bossId: 'caelith' }]);
    // Task 21.2: the story cinematics in order, each once; the companions' joins, the Challenge_Areas' first entries
    // and both Phase transitions played too (Landmarks depend on the route taken).
    const ended = of<{ cinematicId: string }>(events, 'cinematic:ended').map((p) => p.cinematicId);
    expect(ended.filter((id) => /^cin_(skyshard_|altar|boss_intro|ending)/.test(id))).toEqual([
      'cin_skyshard_1', 'cin_skyshard_2', 'cin_skyshard_3', 'cin_altar', 'cin_boss_intro', 'cin_ending',
    ]);
    expect(ended.filter((id) => id.startsWith('cin_join_'))).toEqual(['cin_join_isla', 'cin_join_wren', 'cin_join_talus']);
    expect(ended.filter((id) => id.startsWith('cin_area_'))).toEqual(['cin_area_hollowroot', 'cin_area_cinderspire', 'cin_area_observatory']);
    expect(ended.filter((id) => id.startsWith('cin_boss_phase'))).toEqual(['cin_boss_phase2', 'cin_boss_phase3']);
    expect(new Set(ended).size).toBe(ended.length);
    expect(log.victory).toBe(1);
    expect(gameState.bossDefeated).toBe(true);
    expect(gameState.debugUsed).toBe(false);
    // No wipe before the boss fight (a wipe inside it retries the Phase and is allowed), except inside the Starfall
    // Observatory: its shielded waves and Sentinel Prime meet a party worn down since Cinderspire (nothing heals on the
    // route yet), and a wipe there is the Challenge_Area restart at its latest checkpoint (Req 12.8), after which the
    // party finished the area (the Objectives above all completed once, in order).
    const early = wipes.filter((w) => w.phase === null);
    expect(early.filter((w) => !w.objective.startsWith('ms7_'))).toEqual([]);
    for (const w of early) expect(w.checkpoint?.area).toBe('observatory');
    expect(early.length).toBeLessThanOrEqual(2);
    const stages = events.filter((e) => e.type === 'quest:stageCompleted').map((e) => `${(e.payload as { stageId: string }).stageId}@${e.t.toFixed(0)}s`);
    const bossStart = events.find((e) => e.type === 'cinematic:ended' && (e.payload as { cinematicId: string }).cinematicId === 'cin_boss_intro')?.t ?? 0;
    const bossEnd = events.find((e) => e.type === 'boss:defeated')?.t ?? 0;
    console.info(
      `route: Victory at ${victoryAt.toFixed(0)} s of sim time; stages ${stages.join(' ')}; Caelith ${(bossEnd - bossStart).toFixed(0)} s, ` +
        `${bot.wipes.length} retries; ${gameState.stats.enemiesDefeated} defeated; Kairen HP ${gameState.party.hp.kairen}`,
    );
  }, 240_000);
});

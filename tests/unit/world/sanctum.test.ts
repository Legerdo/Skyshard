import { beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedHit } from '../../../src/combat/attackRuntime';
import { cinematicDef } from '../../../src/data/cinematics';
import { seeContextCinematics } from '../helpers/seenCinematics';
import type { GameEventName } from '../../../src/core/gameEvents';
import { yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CAELITH } from '../../../src/data/boss';
import { MAIN_QUEST } from '../../../src/data/quests';
import { SANCTUM } from '../../../src/data/sanctum';
import { InputState } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { BOSS_INTRO_CINEMATIC_ID, PlaySim } from '../../../src/playSim';
import { CAPSULE_RADIUS } from '../../../src/player/core/constants';
import { isClimbMode } from '../../../src/player/core/types';
import { bossBarModel } from '../../../src/ui/bossBarModel';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';
import { BOT_DT, RouteBot } from '../helpers/routeBot';

// The Astral Sanctum in the play session (task 10.2; design "Boss Caelith" Arena, 재도전과 처치; Req 5.7, 6.11, 32.6),
// on the real terrain: the connecting hall's mural, Caelith's intro on the first arena entry only, the entrance seal
// through the fight (open on a Party_Wipe and the victory), and the rim nobody climbs, jumps or glides over.

const SEED = 20240601;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

const { arena } = SANCTUM;
const fromCenter = (p: Readonly<Vec3>): number => Math.hypot(p.x - arena.center.x, p.z - arena.center.z);
/** Inner face of the rim (and of the closed seal) at a segment's middle, from the arena centre. */
const RIM_INNER = arena.radius - arena.rim.thickness;
/**
 * The rim's middle line: a capsule pressed into a joint between two tangent segments gets a little past RIM_INNER,
 * but its centre never reaches the wall's middle, let alone the disc's edge.
 */
const RIM_MID = arena.radius - arena.rim.thickness / 2;

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

function setup(objectiveId: string, prep?: (gs: GameState) => void) {
  const gameState = createNewGameState(SEED);
  gameState.party.joined = [...PARTY_SLOTS];
  gameState.skyshards = 3;
  gameState.altarActivated = true;
  gameState.party.level = 7;
  at(gameState, objectiveId);
  seeContextCinematics(gameState); // task 21.2: the Landmark cinematics of the way here were seen
  prep?.(gameState);
  const input = new InputState();
  const commands = new UiCommandQueue();
  const wipes: (1 | 2 | 3 | null)[] = [];
  const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: (p) => wipes.push(p), ending: () => {} } });
  const bot = new RouteBot(sim, input, commands, 600);
  const events: { t: number; type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ t: bot.t, type, payload }));
  sim.quests.resume();
  const place = (pos: Readonly<Vec3>, yaw = 0): void => {
    sim.player.teleport({ ...pos }, yaw);
    bot.cameraYaw = yaw;
    bot.step();
  };
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  const introStarts = (): number => of('cinematic:started').filter((p) => (p as { cinematicId: string }).cinematicId === BOSS_INTRO_CINEMATIC_ID).length;
  /** The whole party at 0 HP: the Active_Character goes Downed and 0.8 s later the Party_Wipe follows. */
  const wipe = (): void => {
    const party = gameState.party;
    for (const id of party.joined) {
      party.hp[id] = 0;
      if (id !== party.active && !party.downed.includes(id)) party.downed.push(id);
    }
    const before = wipes.length;
    bot.waitUntil('party wipe', () => wipes.length > before, 3);
  };
  /** A lethal-sized hit on Caelith through its receiver (clamped at each Phase floor). */
  const hitBoss = (amount: number): void => {
    const r = sim.boss.receiver();
    if (r.immune()) return;
    const hit: ResolvedHit = {
      attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount, crit: false, element: null,
      stagger: 0, knockback: 0, direction: { x: 0, y: 0, z: 1 },
    };
    r.receive(hit);
  };
  /** Holds W toward compass bearing `deg` (from the arena centre), jumping and gliding, for `seconds`. */
  const pushOut = (deg: number, seconds: number): { maxFromCenter: number; climbed: boolean; minY: number } => {
    const a = (deg * Math.PI) / 180;
    bot.cameraYaw = yawFromDir(Math.sin(a), -Math.cos(a));
    bot.hold(['KeyW']);
    let maxFromCenter = 0;
    let climbed = false;
    let minY = Infinity;
    for (let i = 0; i < Math.round(seconds / BOT_DT); i++) {
      if (i % 20 === 0 || i % 20 === 8) bot.tap('Space'); // jump, then open the glider in the air
      bot.step();
      const { pos, mode } = sim.player.state;
      maxFromCenter = Math.max(maxFromCenter, fromCenter(pos));
      climbed ||= isClimbMode(mode);
      minY = Math.min(minY, pos.y);
    }
    bot.hold([]);
    return { maxFromCenter, climbed, minY };
  };
  return { sim, gameState, bot, events, commands, wipes, place, of, introStarts, wipe, hitBoss, pushOut };
}

describe('the connecting hall (Req 5.7)', () => {
  it('holds ws_sanctum and the mural; interacting with the mural completes its Objective, no fight starts', () => {
    const s = setup('ms9_mural');
    s.place({ x: 0, y: 180, z: -20 }, yawFromDir(0, 1));
    expect(s.sim.player.state.pos.y).toBeCloseTo(180, 1);
    s.bot.interact('mural', 'mural', 'sanctum_mural', s.sim.sanctum.mural, 2.2);
    s.bot.idle(0.1);
    expect(s.of('interact')).toContainEqual({ targetKind: 'mural', targetId: 'sanctum_mural' });
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms9_arena');
    // The Waystone stone stands in the hall's middle: walking into it stops at its surface.
    s.place(SANCTUM.waystone.spot.pos, yawFromDir(0, -1));
    s.pushOut(0, 1); // toward the stone (north of the spot); the arena lies the other way
    const ws = SANCTUM.waystone;
    expect(Math.hypot(s.sim.player.state.pos.x - ws.pos.x, s.sim.player.state.pos.z - ws.pos.z)).toBeGreaterThanOrEqual(ws.radius + CAPSULE_RADIUS - 0.05);
    expect(s.sim.boss.state).toBe('dormant');
    expect(s.sim.sanctum.sealed).toBe(false);
  });
});

describe('the first arena entry and Caelith intro (Req 6.11, 32.6)', () => {
  it('plays cin_boss_intro (≤ 5 s) once with the entrance sealed, then the fight starts and the boss bar shows', () => {
    const s = setup('ms9_caelith');
    const { sim, bot } = s;
    s.place(SANCTUM.waystone.spot.pos, SANCTUM.waystone.spot.yaw);
    expect([sim.boss.state, sim.sanctum.sealed]).toEqual(['dormant', false]);
    expect(bossBarModel(sim.boss.snapshot())).toBeNull();
    // Walk south over the bridge through the open entrance until the fight zone is reached.
    bot.cameraYaw = yawFromDir(0, 1);
    bot.hold(['KeyW']);
    while (sim.boss.state === 'dormant') {
      if (bot.t > 20) throw new Error(`no fight start at ${bot.where()}`);
      bot.step();
    }
    bot.hold([]);
    expect(sim.sanctum.inFightZone(sim.player.state.pos)).toBe(true);
    expect(sim.boss.state).toBe('intro');
    expect(sim.cinematics.playing).toBe(BOSS_INTRO_CINEMATIC_ID);
    expect(sim.sanctum.sealed).toBe(true);
    expect(sim.boss.active).toBe(false); // no attacks, no HUD bar while it plays
    expect(bossBarModel(sim.boss.snapshot())).toBeNull();
    expect(sim.gameState.cinematicsSeen.filter((id) => id === BOSS_INTRO_CINEMATIC_ID)).toHaveLength(1);
    const introSeconds = cinematicDef(BOSS_INTRO_CINEMATIC_ID)?.duration ?? Infinity;
    expect(introSeconds).toBeLessThanOrEqual(5);

    const start = bot.t;
    while (sim.cinematics.playing !== null) {
      expect(sim.boss.state).toBe('intro');
      bot.step();
    }
    expect(bot.t - start).toBeLessThanOrEqual(5);
    expect(sim.boss.state).toBe('idle'); // begun from the intro's end
    expect(sim.boss.active).toBe(true);
    expect(sim.sanctum.sealed).toBe(true);
    const bar = bossBarModel(sim.boss.snapshot());
    expect(bar).toMatchObject({ title: 'CAELITH', subtitle: CAELITH.epithet, phaseLabel: 'Phase 1', hpFraction: 1, notches: [0.65, 0.3], starshell: null });
    expect(s.introStarts()).toBe(1);
  });
});

describe('the entrance seal and the retry flow (Req 6.11, 6.13)', () => {
  it('stays sealed through the fight, opens on a Party_Wipe, and neither a retry nor a re-entry replays the intro', () => {
    const s = setup('ms9_caelith');
    const { sim, bot, commands } = s;
    s.place(SANCTUM.arenaEntry.pos, SANCTUM.arenaEntry.yaw);
    expect(sim.boss.state).toBe('intro');
    bot.settle();
    expect([sim.boss.active, sim.sanctum.sealed]).toEqual([true, true]);

    // The sealed entrance holds: running and jumping at it from inside leaves the party in the arena.
    s.place({ x: 0, y: 182, z: 1.5 });
    const out = s.pushOut(0, 2.5);
    expect(out.maxFromCenter).toBeLessThan(RIM_INNER - CAPSULE_RADIUS + 0.05);
    expect(sim.player.state.pos.y).toBeGreaterThan(181.9);

    s.wipe();
    expect(s.wipes).toEqual([1]);
    expect(sim.sanctum.sealed).toBe(false); // opened by the wipe, before any Defeat choice

    // "현재 Phase부터 재도전": just inside the entrance, sealed, fighting at once.
    commands.push({ kind: 'defeatChoice', choice: 'retryPhase' });
    bot.step();
    expect(fromCenter(sim.player.state.pos)).toBeCloseTo(fromCenter(SANCTUM.arenaEntry.pos), 1);
    expect([sim.boss.state, sim.boss.active, sim.sanctum.sealed]).toEqual(['idle', true, true]);
    expect(sim.cinematics.playing).toBeNull();

    // "Waystone으로 돌아가기": in the hall in front of ws_sanctum, the entrance open, Caelith dormant.
    s.wipe();
    expect(sim.sanctum.sealed).toBe(false);
    commands.push({ kind: 'defeatChoice', choice: 'returnToWaystone' });
    bot.step();
    const spot = SANCTUM.waystone.spot.pos;
    expect(Math.hypot(sim.player.state.pos.x - spot.x, sim.player.state.pos.z - spot.z)).toBeLessThan(0.2);
    expect([sim.boss.state, sim.sanctum.sealed]).toEqual(['dormant', false]);

    // Back in: the fight starts at once, sealed, without the intro.
    bot.walk('back into the arena', [{ x: 0, z: -4 }, { x: 0, z: 4 }]);
    expect(sim.boss.active).toBe(true);
    expect(sim.sanctum.sealed).toBe(true);
    expect(s.introStarts()).toBe(1);
    expect(sim.gameState.cinematicsSeen.filter((id) => id === BOSS_INTRO_CINEMATIC_ID)).toHaveLength(1);
  });

  it('opens the entrance on the victory, and the party walks out over the bridge', () => {
    const s = setup('ms9_caelith', (gs) => gs.cinematicsSeen.push(BOSS_INTRO_CINEMATIC_ID));
    const { sim, bot } = s;
    s.place(SANCTUM.arenaEntry.pos, SANCTUM.arenaEntry.yaw);
    expect([sim.boss.state, sim.sanctum.sealed, s.introStarts()]).toEqual(['idle', true, 0]);
    while (sim.boss.state !== 'dead') {
      if (bot.t > 30) throw new Error(`Caelith still at ${sim.boss.hp} HP`);
      s.hitBoss(CAELITH.maxHp);
      bot.step(); // the Phase transitions (3 s each) pass
    }
    expect(s.of('boss:defeated')).toEqual([{ bossId: 'caelith' }]);
    expect(sim.sanctum.sealed).toBe(false);
    expect(bossBarModel(sim.boss.snapshot())).toBeNull();
    bot.walk('out over the bridge', [{ x: 0, z: -1 }, { x: 0, z: -4 }], 0.8);
    expect(sim.player.state.pos.z).toBeLessThan(arena.center.z - arena.radius);
  });
});

describe('the rim (design Arena)', () => {
  it('keeps the party in: running, jumping and gliding at the rim never climbs it or gets past it', () => {
    // Before the fight's Objective: Caelith stays dormant and the entrance open, the rim stands anyway.
    const s = setup('ms9_mural');
    for (const deg of [30, 90, 160, 225, 300]) {
      const a = (deg * Math.PI) / 180;
      const r = RIM_INNER - 3;
      s.place({ x: arena.center.x + r * Math.sin(a), y: 182, z: arena.center.z - r * Math.cos(a) });
      const out = s.pushOut(deg, 3);
      expect(out.climbed, `climbed at ${deg}°`).toBe(false);
      expect(out.maxFromCenter, `past the rim at ${deg}°`).toBeLessThan(RIM_MID);
      expect(fromCenter(s.sim.player.state.pos), `rim at ${deg}°`).toBeGreaterThan(RIM_INNER - CAPSULE_RADIUS - 0.5); // it reached the wall
      expect(out.minY, `fell at ${deg}°`).toBeGreaterThan(181.9);
    }
    expect(s.sim.boss.state).toBe('dormant');
    // The open entrance is the way out.
    s.place(SANCTUM.arenaEntry.pos, yawFromDir(0, -1));
    s.bot.walk('out through the entrance', [{ x: 0, z: -4 }], 0.8);
    expect(s.sim.player.state.pos.y).toBeLessThan(182);
  });
});

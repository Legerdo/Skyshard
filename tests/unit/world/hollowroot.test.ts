import { beforeAll, describe, expect, it } from 'vitest';
import { seeContextCinematics } from '../helpers/seenCinematics';
import type { GameEventName } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { HOLLOWROOT, HOLLOWROOT_DEVICES, SHRINE_ORIGIN } from '../../../src/data/challengeAreas';
import { getEnemyDef } from '../../../src/data/enemies';
import { MAIN_QUEST } from '../../../src/data/quests';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import { RECOVERY_FADE_IN, RECOVERY_FADE_OUT } from '../../../src/player/recovery';
import { roomClearedFlag } from '../../../src/world/challengeArea';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Hollowroot Shrine in the play session (task 9.6; design "Hollowroot Shrine", "체크포인트와 실패 처리"; Req 12.1,
// 12.7–12.9): the checkpoint override, falls and boundary checks back to the latest checkpoint, the Party_Wipe
// restart, the locked combat room, Talus's pillar on the R3 plate and the exit after Skyshard 1, on the real terrain.

const SEED = 20240601;
const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

const [CP1, CP2] = HOLLOWROOT.checkpoints;
if (CP1 === undefined || CP2 === undefined) throw new Error('Hollowroot checkpoints missing');
const room = (id: string): Vec3 => {
  const r = HOLLOWROOT.rooms.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no room ${id}`);
  return r.center;
};
const lift = (id: string) => {
  const l = HOLLOWROOT.lifts.find((x) => x.id === id);
  if (l === undefined) throw new Error(`no lift ${id}`);
  return l;
};
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Puts the Main_Quest at Objective `id` (as if every earlier one were done). */
function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

interface SetupOptions {
  objective: string;
  prep?: (gs: GameState) => void;
}

function setup({ objective, prep }: SetupOptions) {
  const gameState = createNewGameState(SEED);
  gameState.party.joined = [...PARTY_SLOTS];
  at(gameState, objective);
  seeContextCinematics(gameState); // task 21.2: the Landmark / area cinematics of the way here were seen
  prep?.(gameState);
  const input = new InputState();
  const commands = new UiCommandQueue();
  const wipes: (1 | 2 | 3 | null)[] = [];
  const sim = new PlaySim({ gameState, terrain, input, commands, sinks: { partyWipe: (p) => wipes.push(p), ending: () => {} } });
  const events: { type: GameEventName; payload: unknown }[] = [];
  sim.bus.onAny((type, payload) => events.push({ type, payload }));
  sim.quests.resume(); // the current Objective: its encounter group is placed
  const step = (raw: RawInput[] = []): void => {
    input.beginTick(raw, DT);
    sim.tick(DT, 0);
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) step();
  };
  /** Stands the Active_Character at `pos` facing `yaw` and ticks once. */
  const place = (pos: Vec3, yaw = 0): void => {
    sim.player.teleport({ ...pos }, yaw);
    step();
  };
  const tap = (code: string): RawInput[] => [{ kind: 'down', code, time: 0 }, { kind: 'up', code, time: 0 }];
  const of = (type: GameEventName): unknown[] => events.filter((e) => e.type === type).map((e) => e.payload);
  const members = (groupId: string) => [...sim.runtime.enemies.values()].filter((e) => e.campId === groupId && e.state !== 'dead');
  /** A lethal (or `amount`) hit on an enemy through its receiver. */
  const hit = (id: string, amount: number, element: 'ember' | null = null, direction: Vec3 = { x: 0, y: 0, z: 1 }): void => {
    for (const r of sim.enemies.receivers()) {
      if (r.id !== id) continue;
      r.receive({
        attackerId: 'player', attackId: 'atk_kairen_n4', hitIndex: 0, kind: 'normal', amount, crit: false,
        element, stagger: 0, knockback: 0, direction,
      });
    }
  };
  return { sim, gameState, input, commands, wipes, events, step, run, place, tap, of, members, hit };
}

describe('Hollowroot checkpoints and recovery (Req 12.7, 12.8)', () => {
  it('registers the entrance, then each rune it steps on, with setCheckpointOverride; leaving the area clears it', () => {
    const s = setup({ objective: 'ms3_bramble' });
    s.place(HOLLOWROOT.route[8]?.pos ?? room('R1')); // on the spiral ramp, below the arch
    expect(s.sim.challenge.current?.id).toBe('hollowroot');
    expect(s.sim.recovery.checkpointOverride).toEqual({ areaId: 'hollowroot', spot: { pos: HOLLOWROOT.entrance.pos, yaw: HOLLOWROOT.entrance.yaw } });
    s.place(CP1.spot.pos, CP1.spot.yaw);
    expect(s.gameState.checkpoint).toEqual({ area: 'hollowroot', id: 'cp_hollowroot_1' });
    expect(s.sim.recovery.checkpointOverride?.spot.pos).toEqual(CP1.spot.pos);
    expect(s.of('checkpoint:reached')).toEqual([{ areaId: 'hollowroot', checkpointId: 'cp_hollowroot_1', first: true }]);
    // cp_hollowroot_2 only lights once the combat room is cleared.
    s.place(CP2.spot.pos, CP2.spot.yaw);
    expect(s.gameState.checkpoint?.id).toBe('cp_hollowroot_1');
    s.gameState.world.flags[roomClearedFlag('hollowroot_room')] = true;
    s.step();
    expect(s.gameState.checkpoint).toEqual({ area: 'hollowroot', id: 'cp_hollowroot_2' });
    // Outside the shrine (on the arch above it) the normal Safe_Position rules apply again.
    s.place({ x: -232, y: 14, z: 131 });
    expect(s.sim.challenge.current).toBeNull();
    expect(s.sim.recovery.checkpointOverride).toBeNull();
  });

  it('a fall into the well fades back to the latest checkpoint within 1 s while the fall judgement is on', () => {
    const s = setup({ objective: 'ms3_wind_wheel', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1');
      gs.checkpoint = { area: 'hollowroot', id: 'cp_hollowroot_1' };
    } });
    const pit = { x: SHRINE_ORIGIN.x, y: terrain.heightAt(SHRINE_ORIGIN.x, SHRINE_ORIGIN.z), z: SHRINE_ORIGIN.z };
    expect(pit.y).toBe(-14);
    s.place(pit);
    expect(s.sim.recovery.reason).toBe('hazard');
    const start = s.sim.recovery.active;
    let ticks = 0;
    while (s.sim.recovery.active) {
      s.step();
      ticks++;
    }
    expect(start).toBe(true);
    expect(ticks * DT).toBeLessThanOrEqual(RECOVERY_FADE_OUT + RECOVERY_FADE_IN + DT);
    expect(ticks * DT).toBeLessThanOrEqual(1);
    expect(flat(s.sim.player.state.pos, CP1.spot.pos)).toBeLessThan(0.05);
    expect(s.sim.player.state.pos.y).toBeCloseTo(CP1.spot.pos.y, 1);
    // The well floor never became a Safe_Position.
    expect(s.sim.recovery.safePositions.some((p) => flat(p.pos, pit) < 8)).toBe(false);
  });

  it('every other recovery inside the area (here the Pause "끼임 해제") also returns to the latest checkpoint', () => {
    // Below-terrain, out-of-bounds and stuck share this path (RecoverySystem unit tests cover each trigger).
    const s = setup({ objective: 'ms3_wind_wheel', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1');
      gs.checkpoint = { area: 'hollowroot', id: 'cp_hollowroot_1' };
    } });
    s.place(room('R2'));
    s.run(1.2); // a Safe_Position in R2
    expect(s.sim.recovery.safePositions.some((p) => flat(p.pos, room('R2')) < 1)).toBe(true);
    expect(s.sim.recovery.requestUnstuck()).toBe(true);
    s.step();
    expect(s.sim.recovery.reason).toBe('manual');
    s.run(RECOVERY_FADE_OUT + RECOVERY_FADE_IN + 0.05);
    expect(s.sim.recovery.active).toBe(false);
    expect(flat(s.sim.player.state.pos, CP1.spot.pos)).toBeLessThan(0.05);
  });

  it('after Skyshard 1 the well no longer judges falls, and the R6 root lift is the exit to the Elderbough foot (Req 12.9)', () => {
    const s = setup({ objective: 'ms4_ashgate', prep: (gs) => {
      gs.skyshards = 1;
      gs.world.puzzles.push('pz_hollowroot_1', 'pz_hollowroot_2', 'pz_hollowroot_3');
      gs.world.flags[roomClearedFlag('hollowroot_room')] = true;
      gs.world.elites.push('rootboundWarden');
      gs.checkpoint = { area: 'hollowroot', id: 'cp_hollowroot_2' };
    } });
    expect(s.sim.challenge.fallJudgement('hollowroot')).toBe(false);
    s.place({ x: SHRINE_ORIGIN.x, y: -14, z: SHRINE_ORIGIN.z });
    s.run(1);
    expect(s.sim.recovery.active).toBe(false);
    expect(s.sim.player.state.pos.y).toBeLessThan(-12); // still down in the well
    const exit = lift(HOLLOWROOT.exitLift);
    expect(s.sim.challenge.doorOpen('hr_door_skyshard')).toBe(true);
    s.place({ x: exit.pad.x + 0.5, y: exit.pad.y, z: exit.pad.z });
    expect(s.sim.interaction.prompt).toMatchObject({ kind: 'lift', id: HOLLOWROOT.exitLift });
    s.step(s.tap('KeyF'));
    s.step();
    expect(s.sim.recovery.reason).toBe('lift');
    s.run(RECOVERY_FADE_OUT + RECOVERY_FADE_IN + 0.05);
    expect(flat(s.sim.player.state.pos, exit.to.pos)).toBeLessThan(0.05);
    expect(s.sim.challenge.current).toBeNull();
    expect(s.sim.recovery.checkpointOverride).toBeNull();
  });

  it('keeps the exit lift closed before Skyshard 1', () => {
    const s = setup({ objective: 'ms3_skyshard', prep: (gs) => {
      gs.world.elites.push('rootboundWarden');
    } });
    const exit = lift(HOLLOWROOT.exitLift);
    s.place({ x: exit.pad.x + 0.5, y: exit.pad.y, z: exit.pad.z });
    expect(s.sim.interaction.prompt?.id).not.toBe(HOLLOWROOT.exitLift);
    expect(s.sim.challenge.fallJudgement('hollowroot')).toBe(true);
  });
});

describe('Hollowroot rooms and puzzles in play (Req 12.1)', () => {
  it('R4 locks both doors while the party fights inside and opens them, lighting cp_hollowroot_2, once cleared', () => {
    const s = setup({ objective: 'ms3_root_room', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1', 'pz_hollowroot_2', 'pz_hollowroot_3');
    } });
    const group = s.members('hollowroot_room');
    expect(group.map((e) => e.def).sort()).toEqual(['bramblekin', 'bramblekin', 'bramblekin', 'bramblekin', 'thornspitter', 'thornspitter']);
    expect([s.sim.challenge.doorOpen('hr_door_room_in'), s.sim.challenge.doorOpen('hr_door_room_out')]).toEqual([true, false]);
    s.place(room('R4'));
    expect(s.sim.challenge.roomLocked('hollowroot_room')).toBe(true);
    expect([s.sim.challenge.doorOpen('hr_door_room_in'), s.sim.challenge.doorOpen('hr_door_room_out')]).toEqual([false, false]);
    for (const e of s.members('hollowroot_room')) s.hit(e.id, 1e6);
    s.step();
    expect(s.of('camp:cleared')).toEqual([{ campId: 'hollowroot_room', regionId: 'verdant' }]);
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms3_warden');
    s.step();
    expect(s.sim.challenge.roomLocked('hollowroot_room')).toBe(false);
    expect(s.gameState.world.flags[roomClearedFlag('hollowroot_room')]).toBe(true);
    expect([s.sim.challenge.doorOpen('hr_door_room_in'), s.sim.challenge.doorOpen('hr_door_room_out')]).toEqual([true, true]);
    expect(s.sim.challenge.checkpointViews().find((c) => c.def.id === 'cp_hollowroot_2')?.lit).toBe(true);
  });

  it('Talus’s pillar holds the R3 plate: the root door opens 12 m away until the pillar sinks, unless the boulder broke', () => {
    const s = setup({ objective: 'ms3_pressure_plate', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1', 'pz_hollowroot_2');
      gs.party.active = 'talus';
    } });
    const arrival = lift('lift_hollowroot_up').to;
    s.place(arrival.pos, arrival.yaw); // facing the plate, 2.5 m short of it
    expect(s.sim.challenge.doorOpen('hr_door_root')).toBe(false);
    s.step(s.tap('KeyE'));
    s.run(0.5);
    const [pillar] = s.sim.pillars.views();
    expect(pillar).toBeDefined();
    expect(flat(pillar?.pos ?? { x: 0, z: 0 }, HOLLOWROOT_DEVICES.plate)).toBeLessThan(0.3);
    expect(s.sim.challenge.doorOpen('hr_door_root')).toBe(true);
    s.place({ x: arrival.pos.x, y: arrival.pos.y, z: arrival.pos.z }); // stepping off changes nothing: the pillar holds it
    s.run(6);
    expect(s.sim.challenge.doorOpen('hr_door_root')).toBe(true);
    s.run(2.5); // the 8 s pillar is gone and the plate comes up
    expect(s.sim.pillars.views()).toEqual([]);
    expect(s.sim.challenge.doorOpen('hr_door_root')).toBe(false);
    // Breaking the boulder behind the door solves the puzzle and fixes the door open.
    const boulder = s.sim.puzzles.device('pz_hollowroot_3_boulder');
    boulder?.onElement('terra', 0);
    s.sim.puzzles.deviceSignal({ part: 'pz_hollowroot_3_boulder', kind: 'crackedBoulder', element: 'terra', accepted: true, state: 'broken', changed: true });
    s.step();
    expect(s.gameState.world.puzzles).toContain('pz_hollowroot_3');
    s.run(0.2);
    expect([s.sim.challenge.doorOpen('hr_door_root'), s.sim.challenge.doorOpen('hr_door_boulder')]).toEqual([true, true]);
  });

  it('a puzzle solved before its Objective is current still completes it (the bramble burnt before Talus joined)', () => {
    const s = setup({ objective: 'ms3_talus', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1');
    } });
    s.sim.bus.emit('dialogue:ended', { npcId: 'talus', dialogueId: 'dlg_stub_talus' });
    s.step();
    s.step();
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms3_wind_wheel');
  });
});

describe('Hollowroot Party_Wipe restart (Req 12.8, 27.3, 27.4)', () => {
  it('starts again at the latest checkpoint with full HP; solved puzzles stay, the uncleared fight and running timers reset', () => {
    const s = setup({ objective: 'ms3_root_room', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1', 'pz_hollowroot_2', 'pz_hollowroot_3');
      gs.checkpoint = { area: 'hollowroot', id: 'cp_hollowroot_1' };
    } });
    s.place(room('R4'));
    expect(s.sim.challenge.roomLocked('hollowroot_room')).toBe(true);
    const [first, second] = s.members('hollowroot_room');
    if (first === undefined || second === undefined) throw new Error('room group missing');
    s.hit(first.id, 1e6); // one down, one hurt
    s.hit(second.id, 30);
    // A sequence attempt in progress elsewhere (its 15 s timer running).
    s.sim.puzzles.deviceSignal({ part: 'pz_azure_1_chime_1', kind: 'windWheel', element: 'gale', accepted: true, state: 'spinning', changed: true });
    expect(s.sim.puzzles.runtime('pz_azure_1')?.startedAt).not.toBeNull();
    for (const id of PARTY_SLOTS) s.gameState.party.hp[id] = 1;
    s.step();

    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.step();
    expect(flat(s.sim.player.state.pos, CP1.spot.pos)).toBeLessThan(0.05);
    for (const id of PARTY_SLOTS) expect(s.gameState.party.hp[id], id).toBe(s.sim.party.maxHp(id));
    expect(s.gameState.world.puzzles).toEqual(['pz_hollowroot_1', 'pz_hollowroot_2', 'pz_hollowroot_3']);
    expect(s.sim.challenge.doorOpen('hr_door_bramble')).toBe(true);
    expect(s.sim.puzzles.runtime('pz_azure_1')).toMatchObject({ step: 0, active: [], startedAt: null });
    // The whole room group is back at its spawns with full HP and the room is open again.
    const back = s.members('hollowroot_room');
    expect(back).toHaveLength(6);
    for (const e of back) {
      expect(e.hp, e.id).toBe(e.maxHp);
      expect(flat(e.pos, e.spawnPos), e.id).toBeLessThan(1e-6);
    }
    expect(s.sim.challenge.roomLocked('hollowroot_room')).toBe(false);
    expect(s.sim.challenge.doorOpen('hr_door_room_in')).toBe(true);
  });

  it('in the Warden’s arena: back to cp_hollowroot_2, the Warden at full HP, the cleared room kept; once defeated it stays gone', () => {
    const s = setup({ objective: 'ms3_warden', prep: (gs) => {
      gs.world.puzzles.push('pz_hollowroot_1', 'pz_hollowroot_2', 'pz_hollowroot_3');
      gs.world.flags[roomClearedFlag('hollowroot_room')] = true;
      gs.checkpoint = { area: 'hollowroot', id: 'cp_hollowroot_2' };
    } });
    const [warden] = s.members('rootboundWarden');
    if (warden === undefined) throw new Error('no Warden');
    expect(flat(warden.pos, HOLLOWROOT.arena.center)).toBeLessThan(HOLLOWROOT.arena.radius);
    s.place(room('R5'));
    s.hit(warden.id, 500);
    expect(s.members('rootboundWarden')[0]?.hp).toBe(warden.maxHp - 500);
    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.step();
    expect(flat(s.sim.player.state.pos, CP2.spot.pos)).toBeLessThan(0.05);
    expect(s.members('rootboundWarden')[0]?.hp).toBe(getEnemyDef('rootboundWarden').hp);
    expect(s.sim.challenge.doorOpen('hr_door_room_out')).toBe(true); // the cleared room stays open
    expect(s.sim.challenge.doorOpen('hr_door_skyshard')).toBe(false);

    s.hit(s.members('rootboundWarden')[0]?.id ?? '', 1e6);
    s.step();
    expect(s.gameState.world.elites).toEqual(['rootboundWarden']);
    expect(s.sim.quests.objectiveView('main')?.objective.id).toBe('ms3_skyshard');
    s.step();
    expect(s.sim.challenge.doorOpen('hr_door_skyshard')).toBe(true);
    s.commands.push({ kind: 'defeatChoice', choice: 'respawn' });
    s.step();
    expect(s.members('rootboundWarden')).toEqual([]); // a defeated Elite is not placed again
    expect(s.sim.challenge.doorOpen('hr_door_skyshard')).toBe(true);
  });
});

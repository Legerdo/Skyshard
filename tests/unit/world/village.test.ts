import { beforeAll, describe, expect, it } from 'vitest';
import { angleDelta, yawFromDir } from '../../../src/core/math';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import type { Vec3 } from '../../../src/core/types';
import { MAIN_QUEST } from '../../../src/data/quests';
import {
  HEARTH_POS, HEARTH_TARGET_ID, HOBB_FIELD, NPC_PHASE_SECONDS, NPC_PLACEMENTS, NPC_STOP_RADIUS, PLAZA_RADIUS, SANCTUM_SIGHT_AXIS,
  SANCTUM_SIGHT_TARGET, VILLAGE_BUILDINGS, VILLAGE_CENTER, VILLAGE_GROUND_Y, bearingDeg, blocksSanctumSight, npcPlacement,
} from '../../../src/data/village';
import { WAYSTONES } from '../../../src/data/waystones';
import { LOCATIONS, THISTLEWICK_HEARTH } from '../../../src/data/worldLayout';
import { InputState } from '../../../src/input/inputState';
import { PARTY_SLOTS } from '../../../src/logic/party';
import { serializeSave } from '../../../src/logic/save/envelope';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { readSaveDocument } from '../../../src/logic/save/load';
import { villageLook, villageStage } from '../../../src/logic/village';
import { PlaySim } from '../../../src/playSim';
import { NpcSystem } from '../../../src/world/npcSystem';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Thistlewick and its NPCs (task 13.2; Req 14.1, 14.2, 14.8, 14.9, 14.10, 5.1).

const DT = 1 / 60;
let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(20240601);
});

const off = (p: { x: number; z: number }): [number, number] => [p.x - VILLAGE_CENTER.x, p.z - VILLAGE_CENTER.z];
const building = (id: string) => {
  const b = VILLAGE_BUILDINGS.find((d) => d.id === id);
  if (b === undefined) throw new Error(`no ${id}`);
  return b;
};
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

describe('Thistlewick layout (design offsets from (−250, 300), ground y 18)', () => {
  it('places the plaza, Hearth, houses, stall, altar, well, field, watchtower and ws_thistlewick', () => {
    expect([VILLAGE_CENTER.x, VILLAGE_CENTER.z, VILLAGE_GROUND_Y]).toEqual([-250, 300, 18]);
    expect(PLAZA_RADIUS).toBe(12);
    expect(off(HEARTH_POS)).toEqual([4, -4]);
    expect([HEARTH_POS.x, HEARTH_POS.z]).toEqual([THISTLEWICK_HEARTH.x, THISTLEWICK_HEARTH.z]);
    expect(off(building('house_maren').center)).toEqual([0, -24]);
    expect(building('house_maren').height).toBeGreaterThanOrEqual(6); // two storeys
    expect(off(building('stall_pip').center)).toEqual([14, 0]);
    expect(off(building('altar_bram').center)).toEqual([-18, 0]);
    expect(off(building('well').center)).toEqual([-9, 11]);
    expect(off(HOBB_FIELD.center)).toEqual([50, 20]);
    expect([HOBB_FIELD.halfX * 2, HOBB_FIELD.halfZ * 2]).toEqual([30, 20]);
    expect(off(building('watchtower').center)).toEqual([30, 32]);
    expect(building('watchtower').height).toBe(10);
    expect(off(WAYSTONES.ws_thistlewick)).toEqual([18, 18]);
  });

  it('keeps the plaza\'s 30°–50° sight axis toward the Astral Sanctum free of buildings (Req 5.1)', () => {
    const toSanctum = bearingDeg(VILLAGE_CENTER, SANCTUM_SIGHT_TARGET);
    expect(toSanctum).toBeGreaterThan(SANCTUM_SIGHT_AXIS.minBearingDeg);
    expect(toSanctum).toBeLessThan(SANCTUM_SIGHT_AXIS.maxBearingDeg);
    expect(toSanctum).toBeCloseTo(39.8, 0);
    // Anything taller than knee height (the 0.7 m plaza step of task 21.4 is lower) stays off the axis.
    for (const b of VILLAGE_BUILDINGS.filter((d) => d.height > 0.8)) {
      expect(blocksSanctumSight(b.center, Math.hypot(b.half.x, b.half.z)), b.id).toBe(false);
    }
    expect(VILLAGE_BUILDINGS.filter((d) => d.height <= 0.8).map((d) => d.id)).toEqual(['plaza_step']);
    // The check itself: something on the axis blocks, beside it does not.
    expect(blocksSanctumSight({ x: VILLAGE_CENTER.x + 20, z: VILLAGE_CENTER.z - 24 }, 3)).toBe(true);
    expect(blocksSanctumSight({ x: VILLAGE_CENTER.x - 20, z: VILLAGE_CENTER.z - 24 }, 3)).toBe(false);
  });

  it('puts Durga at camp_durga (235, 235) and Oriel at camp_oriel (40, −220)', () => {
    const durga = npcPlacement('durga');
    const oriel = npcPlacement('oriel');
    expect([LOCATIONS.camp_durga.x, LOCATIONS.camp_durga.z]).toEqual([235, 235]);
    expect([LOCATIONS.camp_oriel.x, LOCATIONS.camp_oriel.z]).toEqual([40, -220]);
    expect(flat(durga?.home ?? { x: 0, z: 0 }, LOCATIONS.camp_durga)).toBeLessThan(5);
    expect(flat(oriel?.home ?? { x: 0, z: 0 }, LOCATIONS.camp_oriel)).toBeLessThan(5);
    expect([durga?.ambient.anim, oriel?.ambient.anim]).toEqual(['hammer', 'telescope']);
  });
});

describe('NPC idle and ambient behaviour (Req 14.9, 14.3)', () => {
  const npcs = (gs = createNewGameState(1)) => ({ gs, npcs: new NpcSystem({ state: gs, heightAt: () => VILLAGE_GROUND_Y }) });
  const view = (s: NpcSystem, id: string) => s.views().find((v) => v.id === id);

  it('every NPC alternates idle and at least one ambient behaviour, phases of 8–15 s', () => {
    for (const p of NPC_PLACEMENTS) {
      expect(p.idle.length, p.id).toBeGreaterThan(0);
      for (const d of p.durations) {
        expect(d, p.id).toBeGreaterThanOrEqual(NPC_PHASE_SECONDS.min);
        expect(d, p.id).toBeLessThanOrEqual(NPC_PHASE_SECONDS.max);
      }
    }
    const { npcs: s } = npcs();
    const seen = new Map<string, Set<string>>();
    const switches = new Map<string, number[]>();
    let t = 0;
    let last = new Map(s.views().map((v) => [v.id, v.anim] as const));
    for (let i = 0; i < Math.round(90 / DT); i++) {
      s.tick(DT, null);
      t += DT;
      for (const v of s.views()) {
        (seen.get(v.id) ?? seen.set(v.id, new Set()).get(v.id))?.add(v.anim);
        if (last.get(v.id) !== v.anim) (switches.get(v.id) ?? switches.set(v.id, []).get(v.id))?.push(t);
      }
      last = new Map(s.views().map((v) => [v.id, v.anim] as const));
    }
    for (const p of NPC_PLACEMENTS) {
      const anims = seen.get(p.id) ?? new Set();
      expect(anims.has(p.ambient.anim), `${p.id} ambient`).toBe(true);
      expect(p.idle.some((a) => anims.has(a)), `${p.id} idle`).toBe(true);
      if (p.ambient.kind !== 'inPlace') continue;
      // In-place behaviours change on the phase timer: every gap is one of the 8–15 s phases.
      const at = switches.get(p.id) ?? [];
      expect(at.length, p.id).toBeGreaterThanOrEqual(5);
      for (let k = 1; k < at.length; k++) {
        const gap = (at[k] ?? 0) - (at[k - 1] ?? 0);
        expect(gap, p.id).toBeGreaterThanOrEqual(NPC_PHASE_SECONDS.min - 2 * DT);
        expect(gap, p.id).toBeLessThanOrEqual(NPC_PHASE_SECONDS.max + 2 * DT);
      }
    }
  });

  it('Elder Maren walks between the plaza and her door, and stops while the player is within 2.5 m', () => {
    const { npcs: s } = npcs();
    const maren = npcPlacement('maren');
    if (maren === undefined || maren.ambient.kind !== 'walk') throw new Error('maren walks');
    const door = maren.ambient.to;
    const pos = s.position('maren');
    if (pos === null) throw new Error('no maren');
    let farthest = 0;
    for (let i = 0; i < Math.round(80 / DT); i++) {
      s.tick(DT, null);
      farthest = Math.max(farthest, flat(pos, maren.home));
    }
    expect(farthest).toBeCloseTo(flat(door, maren.home), 1);
    // Wait for her next walk, then stand in her way.
    let guard = 0;
    while (view(s, 'maren')?.anim !== 'walk') {
      if (guard++ > 2000) throw new Error('never walks');
      s.tick(DT, null);
    }
    for (let i = 0; i < 30; i++) s.tick(DT, null);
    const player: Vec3 = { x: pos.x + 2, y: pos.y, z: pos.z };
    const stopped = { ...pos };
    for (let i = 0; i < 60; i++) s.tick(DT, player);
    expect(flat(pos, stopped)).toBeLessThan(1e-9);
    expect(view(s, 'maren')?.anim).toBe('idle');
    expect(NPC_STOP_RADIUS).toBe(2.5);
    const far: Vec3 = { x: pos.x + 8, y: pos.y, z: pos.z };
    for (let i = 0; i < 30; i++) s.tick(DT, far);
    expect(flat(pos, stopped)).toBeGreaterThan(0.3);
  });

  it('a talk holds the behaviour; after it the NPC goes on where it stopped', () => {
    const { npcs: s } = npcs();
    let guard = 0;
    while (view(s, 'hobb')?.anim !== 'hoe') {
      if (guard++ > 3000) throw new Error('never hoes');
      s.tick(DT, null);
    }
    for (let i = 0; i < 30; i++) s.tick(DT, null);
    const pos = s.position('hobb');
    if (pos === null) throw new Error('no hobb');
    const held = { ...pos };
    s.beginTalk('hobb', { x: pos.x, y: pos.y, z: pos.z - 1.5 });
    for (let i = 0; i < 120; i++) s.tick(DT, null);
    expect(flat(pos, held)).toBe(0);
    expect(view(s, 'hobb')?.talking).toBe(true);
    s.endTalk('hobb');
    for (let i = 0; i < 30; i++) s.tick(DT, null);
    expect(view(s, 'hobb')?.anim).toBe('hoe');
    expect(flat(pos, held)).toBeGreaterThan(0.3);
  });

  it('from Skyshard 3 on the five villagers stand on the plaza rim facing the Sanctum; the camps stay put', () => {
    for (const setupState of [(gs: GameState) => { gs.skyshards = 3; }, (gs: GameState) => { gs.skyshards = 3; gs.gameCompleted = true; }]) {
      const gs = createNewGameState(1);
      setupState(gs);
      const { npcs: s } = npcs(gs);
      for (let i = 0; i < Math.round(30 / DT); i++) s.tick(DT, null);
      for (const id of ['maren', 'pip', 'bram', 'tamsin', 'hobb'] as const) {
        const v = view(s, id);
        if (v === undefined) throw new Error(id);
        expect(flat(v.pos, VILLAGE_CENTER), id).toBeLessThanOrEqual(PLAZA_RADIUS);
        expect(Math.abs(angleDelta(v.yaw, yawFromDir(SANCTUM_SIGHT_TARGET.x - v.pos.x, SANCTUM_SIGHT_TARGET.z - v.pos.z))), id).toBeLessThan(1e-6);
      }
      expect(flat(view(s, 'durga')?.pos ?? { x: 0, z: 0 }, npcPlacement('durga')?.home ?? { x: 1e9, z: 0 })).toBeLessThan(1e-9);
    }
  });

  it('companions stand at their talk spots until they join', () => {
    const { gs, npcs: s } = npcs();
    expect(['isla', 'wren', 'talus'].map((id) => s.present(id as 'isla'))).toEqual([true, true, true]);
    gs.party.joined.push('isla');
    s.tick(DT, null);
    expect(s.present('isla')).toBe(false);
    expect(s.interactTargets().find((t) => t.id === 'isla')?.available()).toBe(false);
    expect(s.interactTargets().find((t) => t.id === 'maren')?.available()).toBe(true);
  });
});

describe('village stages from GameState (Req 14.8, 7.5)', () => {
  const STAGES: { name: string; prep: (gs: GameState) => void }[] = [
    { name: '0', prep: () => {} },
    { name: '1', prep: (gs) => { at(gs, 'ms4_ashgate'); gs.skyshards = 1; } },
    { name: '2', prep: (gs) => { at(gs, 'ms6_pass'); gs.skyshards = 2; } },
    { name: '3', prep: (gs) => { at(gs, 'ms8_light_pillar'); gs.skyshards = 3; } },
    {
      name: 'post',
      prep: (gs) => {
        gs.quests.main = { stage: MAIN_QUEST.stages.length - 1, objective: 2, done: true };
        Object.assign(gs, { skyshards: 3, altarActivated: true, bossDefeated: true, gameCompleted: true });
      },
    },
  ];

  it('accumulates each stage\'s changes: lanterns → bunting → stall and garlands → star lanterns and the gathering → festival', () => {
    const looks = STAGES.map(({ prep }) => {
      const gs = createNewGameState(1);
      prep(gs);
      return villageLook(gs);
    });
    expect(looks.map((l) => l.stage)).toEqual([0, 1, 2, 3, 'post']);
    expect(looks.map((l) => l.streetLanternsLit)).toEqual([false, true, true, true, true]);
    expect(looks.map((l) => l.bunting)).toEqual([false, true, true, true, true]);
    expect(looks.map((l) => l.stall)).toEqual(['makeshift', 'makeshift', 'restored', 'restored', 'restored']);
    expect(looks.map((l) => l.garlands)).toEqual([false, false, true, true, true]);
    expect(looks.map((l) => l.flowerBedsBloom)).toEqual([false, false, true, true, true]);
    expect(looks.map((l) => l.starLanterns)).toEqual([false, false, false, true, true]);
    expect(looks.map((l) => l.villagersGathered)).toEqual([false, false, false, true, true]);
    expect(looks.map((l) => l.festival)).toEqual([false, false, false, false, true]);
    expect(looks.map((l) => l.blightTraces)).toEqual([true, true, true, true, false]);
    expect(villageStage({ skyshards: 1, gameCompleted: true })).toBe('post');
  });

  it('a session built from each stage\'s save looks the same right after loading (look and NPC spots)', () => {
    for (const { name, prep } of STAGES) {
      const gs = createNewGameState(20240601);
      gs.party.joined = [...PARTY_SLOTS];
      prep(gs);
      const read = readSaveDocument(serializeSave(gs, 0, '2026-01-01T00:00:00.000Z'));
      if (!read.ok) throw new Error(`stage ${name}: ${read.error}`);
      const sims = [gs, read.state].map(
        (state) => new PlaySim({ gameState: state, terrain, input: new InputState(), commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} } }),
      );
      const [before, after] = sims.map((sim) => ({ look: sim.village.look(), npcs: sim.npcs.views().map((v) => [v.id, v.pos.x, v.pos.z, v.present]) }));
      expect(after, `stage ${name}`).toEqual(before);
      expect(after?.look.stage, `stage ${name}`).toBe(name === 'post' ? 'post' : Number(name));
      for (const sim of sims) sim.dispose();
    }
  });
});

describe('the Hearth (Req 14.10)', () => {
  it('heals every Player_Character to full HP and clears Downed', () => {
    const gs = createNewGameState(20240601);
    gs.party.joined = [...PARTY_SLOTS];
    const input = new InputState();
    let rested = 0;
    const sim = new PlaySim({
      gameState: gs, terrain, input, commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {}, hearthRested: () => rested++ },
    });
    const hearth = sim.village.interactTargets()[0];
    expect(hearth?.kind).toBe('hearth');
    expect(hearth?.id).toBe(HEARTH_TARGET_ID);
    for (const id of PARTY_SLOTS) gs.party.hp[id] = 1;
    gs.party.hp.isla = 0;
    gs.party.downed = ['isla'];
    // Walk-up and press as the player would: stand beside the Hearth and press F.
    const y = terrain.heightAt(HEARTH_POS.x + 1.2, HEARTH_POS.z);
    sim.player.teleport({ x: HEARTH_POS.x + 1.2, y, z: HEARTH_POS.z }, 0);
    input.beginTick([], DT);
    sim.tick(DT, 0);
    expect(sim.interaction.prompt?.kind).toBe('hearth');
    input.beginTick([{ kind: 'down', code: 'KeyF', time: 0 }, { kind: 'up', code: 'KeyF', time: 0 }], DT);
    sim.tick(DT, 0);
    input.beginTick([], DT);
    sim.tick(DT, 0);
    for (const id of PARTY_SLOTS) expect(gs.party.hp[id], id).toBe(sim.party.maxHp(id));
    expect(gs.party.downed).toEqual([]);
    expect(rested).toBe(1);
    sim.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import { angleDelta, yawFromDir } from '../../../src/core/math';
import { createGameEventBus, type GameEventName, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { DIALOGUE_RULES, DIALOGUES, SIDE_QUEST_FLAGS, seenFlag, type Speaker } from '../../../src/data/dialogue';
import { MAIN_QUEST, QUESTS } from '../../../src/data/quests';
import { npcPlacement } from '../../../src/data/village';
import { DialogueSystem, type DialogueView } from '../../../src/dialogue/dialogueSystem';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { QuestSystem } from '../../../src/quest/questSystem';
import { NpcSystem, NPC_TURN_RATE } from '../../../src/world/npcSystem';

// Dialogue_System over the Quest_System and the NPCs (task 13.1; Req 3.8, 14.4, 14.6, 37.7), headless on flat ground.

const DT = 1 / 60;
type Advance = 'interact' | 'jump' | 'attack';

function at(gs: GameState, id: string): void {
  MAIN_QUEST.stages.forEach((stage, s) => stage.objectives.forEach((o, i) => {
    if (o.id === id) gs.quests.main = { stage: s, objective: i, done: false };
  }));
}

function setup(objective = 'ms1_maren') {
  const gs = createNewGameState(1);
  at(gs, objective);
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: unknown }[] = [];
  bus.onAny((type, payload) => events.push({ type, payload }));
  const quests = new QuestSystem({
    bus, state: gs, defs: QUESTS,
    sinks: {
      joinParty: (c) => {
        gs.party.joined.push(c);
        bus.emit('party:joined', { characterId: c });
      },
    },
  });
  const npcs = new NpcSystem({ state: gs, heightAt: () => 0 });
  const player: Vec3 = { x: 0, y: 0, z: 0 };
  const changes: (DialogueView | null)[] = [];
  const env = { ready: true };
  const dialogue = new DialogueSystem({
    bus, state: gs, quests, npcs, player: () => player, ready: () => env.ready, onChange: (v) => changes.push(v),
  });
  /** One tick: the dialogue reads `press` (this tick's advance presses), the NPCs move, EventDispatch. */
  const tick = (press: readonly Advance[] = []): void => {
    dialogue.tick(DT, { pressed: (a) => press.includes(a) });
    npcs.tick(DT, player);
    bus.dispatch();
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) tick();
  };
  /** Stands 1.5 m from `npc` (on `side`, rad) and presses interact on it. */
  const talk = (npc: Speaker, side = 0): void => {
    const p = npcs.position(npc);
    if (p === null) throw new Error(`no ${npc}`);
    player.x = p.x + 1.5 * Math.sin(side);
    player.z = p.z + 1.5 * Math.cos(side);
    bus.emit('interact', { targetKind: 'npc', targetId: npc });
    bus.dispatch();
  };
  /** Presses interact until the dialogue closes (two presses per window: complete, then next). */
  const readThrough = (): number => {
    let presses = 0;
    while (dialogue.open) {
      if (presses++ > 40) throw new Error('dialogue does not end');
      tick(['interact']);
    }
    return presses;
  };
  const of = <K extends GameEventName>(type: K): GameEvents[K][] => events.filter((e) => e.type === type).map((e) => e.payload as GameEvents[K]);
  const current = (): string | undefined => quests.objectiveView('main')?.objective.id;
  return { gs, bus, events, quests, npcs, dialogue, player, changes, env, tick, run, talk, readThrough, of, current };
}

describe('a talk with an NPC', () => {
  it('opens the window with the speaker name, types at 45 characters per second and publishes dialogue:line per window', () => {
    const s = setup('ms1_maren');
    s.talk('maren');
    expect(s.dialogue.open).toBe(true);
    const first = s.dialogue.view();
    const def = DIALOGUES.find((d) => d.id === 'dlg_maren_ms1_maren');
    if (first === null || def === undefined) throw new Error('no window');
    expect(first).toMatchObject({ dialogueId: def.id, npc: 'maren', speaker: 'maren', speakerName: 'Elder Maren', line: 0, count: def.lines.length, visible: 0 });
    expect(s.changes).toEqual([first]);
    s.run(1);
    expect(s.dialogue.view()?.visible).toBe(Math.min(DIALOGUE_RULES.charsPerSecond, first.text.length));
    expect(s.of('dialogue:line')).toEqual([{ speaker: 'maren', dialogueId: def.id, line: 0 }]);
  });

  it('an advance press completes a typing window at once, the next moves on (F, Space and left click alike)', () => {
    const s = setup('ms1_maren');
    s.talk('maren');
    s.tick();
    s.tick(['jump']);
    const view = s.dialogue.view();
    expect(view?.complete).toBe(true);
    expect(view?.visible).toBe(view?.text.length);
    expect(view?.line).toBe(0);
    s.tick(['attack']);
    expect(s.dialogue.view()).toMatchObject({ line: 1, speaker: 'kairen', speakerName: 'Kairen', visible: 0 });
    expect(s.of('dialogue:line').map((l) => [l.line, l.speaker])).toEqual([[0, 'maren'], [1, 'kairen']]);
    s.tick(['interact']);
    expect(s.dialogue.view()?.complete).toBe(true);
  });

  it('after the last window: dialogue:ended (the talk Objective), the context back, one voice line per window', () => {
    const s = setup('ms1_maren');
    s.talk('maren');
    const presses = s.readThrough();
    s.tick();
    const def = DIALOGUES.find((d) => d.id === 'dlg_maren_ms1_maren');
    expect(presses).toBe(2 * (def?.lines.length ?? 0));
    expect(s.dialogue.open).toBe(false);
    expect(s.changes.at(-1)).toBeNull();
    expect(s.of('dialogue:ended')).toEqual([{ npcId: 'maren', dialogueId: 'dlg_maren_ms1_maren' }]);
    expect(s.of('dialogue:line')).toHaveLength(def?.lines.length ?? -1);
    expect(s.current()).toBe('ms1_isla');
  });

  it('ignores another interact while a window is open', () => {
    const s = setup('ms1_maren');
    s.talk('maren');
    s.talk('pip');
    expect(s.dialogue.view()?.npc).toBe('maren');
  });

  it('turns the NPC to face the player within 0.5 s and back to its own facing after the talk', () => {
    const s = setup('ms4_ashgate');
    const home = npcPlacement('pip')?.yaw ?? 0;
    // Stand behind Pip: the widest turn.
    s.talk('pip', home + Math.PI);
    const p = s.npcs.position('pip');
    if (p === null) throw new Error('no pip');
    const want = yawFromDir(s.player.x - p.x, s.player.z - p.z);
    const yawOf = (): number => s.npcs.views().find((v) => v.id === 'pip')?.yaw ?? NaN;
    for (let i = 0; i < Math.round(0.5 / DT) + 1; i++) s.npcs.tick(DT, s.player);
    expect(Math.abs(angleDelta(yawOf(), want))).toBeLessThan(1e-6);
    expect(NPC_TURN_RATE * 0.5).toBeGreaterThanOrEqual(Math.PI);
    expect(s.npcs.views().find((v) => v.id === 'pip')?.talking).toBe(true);
    s.readThrough();
    s.run(0.6);
    const pip = s.npcs.views().find((v) => v.id === 'pip');
    expect(pip?.talking).toBe(false);
    expect(Math.abs(angleDelta(pip?.yaw ?? NaN, want))).toBeGreaterThan(1); // turned away from the player again
  });
});

describe('onEnd, one-shot reactions and the talks that open screens', () => {
  it('a companion joins through onEnd before dialogue:ended; once joined it is no longer there to talk to', () => {
    const s = setup('ms1_isla');
    s.talk('isla');
    s.readThrough();
    s.tick();
    expect(s.gs.party.joined).toEqual(['kairen', 'isla']);
    const order = s.events.map((e) => e.type).filter((t) => t === 'party:joined' || t === 'dialogue:ended');
    expect(order).toEqual(['party:joined', 'dialogue:ended']);
    expect(s.of('dialogue:ended')).toEqual([{ npcId: 'isla', dialogueId: 'dlg_isla_ms1_isla' }]);
    expect(s.current()).toBe('ms1_raid');
    expect(s.npcs.present('isla')).toBe(false);
    s.talk('isla');
    expect(s.dialogue.open).toBe(false);
  });

  it('talking to a companion before its Objective plays its default and does not join', () => {
    const s = setup('ms1_maren');
    s.talk('wren');
    expect(s.dialogue.view()?.dialogueId).toBe('dlg_wren_default');
    s.readThrough();
    s.tick();
    expect(s.gs.party.joined).toEqual(['kairen']);
    expect(s.current()).toBe('ms1_maren');
  });

  it('a one-shot reaction turns on its seen_ flag, so the next talk is the bucket dialogue again', () => {
    const s = setup('ms4_ashgate');
    s.gs.skyshards = 1;
    s.gs.world.flags[SIDE_QUEST_FLAGS.sq_tamsin] = true;
    s.talk('maren');
    expect(s.dialogue.playing).toBe('dlg_maren_react_village_kite');
    s.readThrough();
    s.tick();
    expect(s.gs.world.flags[seenFlag('dlg_maren_react_village_kite')]).toBe(true);
    s.talk('maren');
    expect(s.dialogue.playing).toBe('dlg_maren_b1');
  });

  it("Pip's talk ends in 'interact' shop and Old Bram's in 'interact' echoAltar (their screens' hooks)", () => {
    const s = setup('ms4_ashgate');
    s.talk('pip');
    s.readThrough();
    s.tick();
    s.talk('bram');
    s.readThrough();
    s.tick();
    const opens = s.of('interact').filter((p) => p.targetKind !== 'npc');
    expect(opens).toEqual([{ targetKind: 'shop', targetId: 'pip' }, { targetKind: 'echoAltar', targetId: 'bram' }]);
  });

  it('a quest giver\'s offer accepts its Side_Quest', () => {
    const s = setup('ms4_ashgate');
    s.talk('tamsin');
    expect(s.dialogue.playing).toBe('dlg_tamsin_sq_tamsin_offer');
    s.readThrough();
    s.tick();
    expect(s.gs.quests.side.sq_tamsin.status).toBe('active');
    expect(s.quests.objectiveView('sq_tamsin')?.objective.id).toBe('sq_tamsin_kite');
  });
});

describe('Main_Quest stage briefings (Req 3.8)', () => {
  it("plays ms1's briefing by itself 0.8 s into a New Game once the party can listen", () => {
    const s = setup('ms1_maren');
    s.env.ready = false;
    s.dialogue.beginNewGame();
    s.run(2);
    expect(s.dialogue.open).toBe(false);
    s.env.ready = true;
    s.run(DIALOGUE_RULES.stageDelaySeconds - 0.1);
    expect(s.dialogue.open).toBe(false);
    s.run(0.15);
    expect(s.dialogue.playing).toBe('dlg_stage_ms1');
    expect(s.dialogue.view()).toMatchObject({ npc: null, speaker: 'kairen' });
    s.readThrough();
    s.tick();
    expect(s.of('dialogue:ended').at(-1)).toEqual({ npcId: 'kairen', dialogueId: 'dlg_stage_ms1' });
    expect(s.current()).toBe('ms1_maren'); // a briefing is no talk
  });

  it("queues the next stage's briefing when a stage completes, and drops it if the stage moved on first", () => {
    const s = setup('ms3_skyshard');
    s.quests.handle({ kind: 'skyshard', id: '1' });
    s.tick();
    expect(s.current()).toBe('ms4_ashgate');
    s.run(1);
    expect(s.dialogue.playing).toBe('dlg_stage_ms4');
    s.readThrough();

    const t = setup('ms4_cinderspire');
    t.env.ready = false;
    t.quests.handle({ kind: 'reach', id: 'cinderspire_base' });
    t.tick();
    expect(t.current()).toBe('ms5_ledge_1');
    at(t.gs, 'ms6_pass'); // moved on before the party could listen
    t.env.ready = true;
    t.run(2);
    expect(t.dialogue.open).toBe(false);
  });
});

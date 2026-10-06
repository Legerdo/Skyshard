import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEventBus, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import { NPC_PLACEMENTS } from '../../../src/data/village';
import { FIRST_TEN_MINUTE_HINTS, TUTORIAL_ANCHORS } from '../../../src/data/tutorials';
import { NEW_GAME_START } from '../../../src/data/worldLayout';
import type { InputAction } from '../../../src/input/actions';
import { DEFAULT_BINDINGS, type Bindings } from '../../../src/input/bindings';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { HINT_SHOW_SECONDS } from '../../../src/logic/tutorial';
import type { MoveMode } from '../../../src/player/core/types';
import { hintKeyLabels, tapLook } from '../../../src/tutorial/hintKeys';
import { TutorialSystem } from '../../../src/tutorial/tutorialSystem';

// Tutorial_System adapter (design "Tutorial_System", "첫 10분 온보딩 흐름"; Req 34.1–34.6): the ms1–ms2 event sequence
// replayed against the real bus, InputState and GameState.

const DT = 1 / 60;
const MAREN = NPC_PLACEMENTS.find((n) => n.id === 'maren')?.home;
const MAREN_POS: Vec3 = { x: MAREN?.x ?? 0, y: 18, z: MAREN?.z ?? 0 };

interface Shown {
  readonly id: string;
  readonly t: number;
}

function harness(gs: GameState = createNewGameState(1)) {
  const bus: GameEventBus = createGameEventBus();
  const input = new InputState();
  const world = { pos: { x: NEW_GAME_START.x, y: 18, z: NEW_GAME_START.z } as Vec3, mode: 'grounded' as MoveMode, cinematic: false, emberMarked: false };
  const system = new TutorialSystem({
    bus,
    state: gs,
    input,
    world: {
      playerPos: () => world.pos,
      playerMode: () => world.mode,
      cinematicPlaying: () => world.cinematic,
      locate: (id) => (id === 'maren' ? MAREN_POS : null),
    },
    // Stand-in for the session's judge: an Ember mark on an enemy while Isla stands by.
    probes: { tut_reaction: () => world.emberMarked && gs.party.joined.includes('isla') && gs.party.active !== 'isla' },
  });
  const shown: Shown[] = [];
  /** Completed ids, in completion order, with the time. */
  const closed: Shown[] = [];
  let t = 0;
  bus.on('hint:shown', (p) => shown.push({ id: p.hintId, t }));
  let pendingRaw: RawInput[] = [];
  const tick = (): void => {
    input.beginTick(pendingRaw, DT);
    pendingRaw = [];
    const before = gs.tutorials.length;
    system.tick(DT);
    for (const id of gs.tutorials.slice(before)) closed.push({ id, t });
    bus.dispatch();
    t += DT;
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) tick();
  };
  /** Ticks until `pred` holds (at most `limit` s). */
  const until = (what: string, pred: () => boolean, limit = 20): void => {
    for (let i = 0; i < Math.round(limit / DT); i++) {
      if (pred()) return;
      tick();
    }
    throw new Error(`${what}: not reached within ${limit} s (current ${system.current}, pending ${system.pending.join(',')})`);
  };
  const code = (a: InputAction): string => DEFAULT_BINDINGS[a as keyof Bindings];
  /** A key press held for one tick. */
  const press = (a: InputAction): void => {
    pendingRaw.push({ kind: 'down', code: code(a), time: 0 });
    tick();
    pendingRaw.push({ kind: 'up', code: code(a), time: 0 });
    tick();
  };
  const emit = <K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void => bus.emit(type, payload);
  const showing = (id: string): boolean => system.visibleHint()?.id === id;
  return { bus, input, world, system, gs, shown, closed, tick, run, until, press, emit, showing, get t() { return t; } };
}

type Harness = ReturnType<typeof harness>;

const telegraph: GameEvents['enemy:telegraph'] = {
  entityId: 'bramblekin_1', kind: 'bramblekin', attackId: 'atk_bramblekin_claw', telegraph: 'glow', strong: false, seconds: 0.4,
  position: { x: -200, y: 18, z: 320 }, yaw: 0,
};

/** A dialogue with an NPC: the context leaves gameplay while it runs; `during` happens inside it (a join). */
function talk(h: Harness, during?: () => void): void {
  h.input.setContext('dialogue');
  h.run(0.5);
  during?.();
  h.run(1);
  h.emit('dialogue:ended', { npcId: 'maren', dialogueId: 'dlg' });
  h.input.setContext('gameplay');
  h.tick();
}

function join(h: Harness, id: 'isla' | 'wren'): void {
  h.gs.party.joined.push(id);
  h.emit('party:joined', { characterId: id });
}

describe('Tutorial_System: first 10 minutes (ms1–ms2 replay)', () => {
  it('shows the ten required control hints one at a time through the glide, each closed by its action', () => {
    const h = harness();
    // 0:00 village entrance: move, then the camera 3 s in (mouse look through the camera's tapped input).
    h.tick();
    expect(h.showing('tut_move')).toBe(true);
    h.press('moveForward');
    h.until('camera', () => h.showing('tut_camera'));
    expect(h.t).toBeGreaterThan(3 - 1e-6);
    const camera = tapLook({ lookDelta: () => ({ x: 0.2, y: 0.05 }), wheelDelta: () => 0 }, (d) => h.system.look(d));
    camera.lookDelta();
    camera.lookDelta();
    h.tick();
    // 0:20 the plaza step.
    h.world.pos = { ...TUTORIAL_ANCHORS.plaza_step };
    h.until('jump', () => h.showing('tut_jump'));
    h.press('jump');
    // 0:40 Elder Maren: F opens the dialogue in the same tick; the hint is already recorded.
    h.world.pos = { x: MAREN_POS.x + 1.5, y: 18, z: MAREN_POS.z };
    h.until('interact', () => h.showing('tut_interact'));
    h.press('interact');
    expect(h.gs.tutorials).toContain('tut_interact');
    talk(h);
    // Isla under the watchtower: she joins inside her dialogue; the switch hint waits for the dialogue to end.
    h.world.pos = { x: -220, y: 18, z: 331 };
    talk(h, () => join(h, 'isla'));
    h.until('switch', () => h.showing('tut_switch'));
    h.press('switch2');
    h.gs.party.active = 'isla';
    h.emit('party:switched', { from: 'kairen', to: 'isla' });
    h.tick();
    h.press('switch1');
    h.gs.party.active = 'kairen';
    h.emit('party:switched', { from: 'isla', to: 'kairen' });
    // 1:30 village_raid: attack, then the first Telegraph's Dodge before the queued Skill hint.
    h.world.pos = { x: -205, y: 18, z: 318 };
    h.emit('enemy:alerted', { entityId: 'bramblekin_1', kind: 'bramblekin', campId: 'village_raid' });
    h.until('attack', () => h.showing('tut_attack'));
    h.emit('enemy:telegraph', telegraph);
    h.run(0.3);
    h.press('attack');
    h.until('dodge', () => h.showing('tut_dodge'));
    h.press('dodge');
    // 1:50 Kairen's Skill leaves an Ember mark; switch key 2 brings Isla in for the steam burst (Req 34.6).
    h.until('skill', () => h.showing('tut_skill'));
    h.emit('skill:cast', { characterId: 'kairen', hitEnemy: true });
    h.world.emberMarked = true;
    h.until('reaction', () => h.showing('tut_reaction'));
    expect(h.system.visibleHint()?.actions).toContain('switch2');
    h.press('switch2');
    h.gs.party.active = 'isla';
    h.emit('party:switched', { from: 'kairen', to: 'isla' });
    h.emit('reaction', { reaction: 'steamBurst', targetId: 'bramblekin_1', position: telegraph.position, chainDepth: 0 });
    h.run(0.1);
    h.world.emberMarked = false;
    // 2:40 the open field on the Breezewatch road.
    h.world.pos = { x: TUTORIAL_ANCHORS.breezewatch_field.x, y: 24, z: TUTORIAL_ANCHORS.breezewatch_field.z };
    h.until('sprint', () => h.showing('tut_sprint'));
    h.press('sprint');
    // 3:20 the cliff foot; the climb starts.
    h.emit('area:entered', { regionId: 'verdant', areaId: 'breezewatch_base', first: true });
    h.until('climb', () => h.showing('tut_climb'));
    h.world.mode = 'climbAttach';
    h.tick();
    h.world.mode = 'climb';
    h.run(2);
    h.world.mode = 'grounded';
    // 4:20 the windmill-top Vista_Point: the map hint; opening the map screen completes it.
    h.emit('area:entered', { regionId: 'verdant', areaId: 'vista_verdant', first: true });
    h.until('map', () => h.showing('tut_map'));
    h.emit('ui:screen', { screen: 'map', open: true });
    h.emit('ui:screen', { screen: 'map', open: false });
    h.run(0.1);
    // 5:00 Wren joins on the windmill top; the glide hint follows her dialogue, and the glide starts.
    talk(h, () => join(h, 'wren'));
    h.until('glide', () => h.showing('tut_glide'));
    h.world.mode = 'glideDeploy';
    h.run(1);

    const order = h.shown.map((s) => s.id);
    expect(order).toEqual([
      'tut_move', 'tut_camera', 'tut_jump', 'tut_interact', 'tut_switch', 'tut_attack', 'tut_dodge', 'tut_skill', 'tut_reaction',
      'tut_sprint', 'tut_climb', 'tut_map', 'tut_glide',
    ]);
    for (const id of FIRST_TEN_MINUTE_HINTS) expect(order).toContain(id);
    // One at a time: each hint closed (and was recorded) before the next showed; every one by its action.
    expect(h.closed.map((c) => c.id)).toEqual(order);
    for (let i = 0; i < h.shown.length; i++) {
      const done = h.closed[i];
      expect(done.t, done.id).toBeLessThan(h.shown[i].t + HINT_SHOW_SECONDS - 0.5);
      if (i + 1 < h.shown.length) expect(done.t, done.id).toBeLessThan(h.shown[i + 1].t);
    }
    expect(h.system.current).toBeNull();
    expect(h.gs.tutorials).toEqual(order);
  });

  it('still shows them all one at a time for a player who ignores them (each closes after 8 s)', () => {
    const h = harness();
    // The design timeline's moments; nothing is ever pressed.
    const timeline: [number, () => void][] = [
      [20, () => (h.world.pos = { ...TUTORIAL_ANCHORS.plaza_step })],
      [40, () => (h.world.pos = { ...MAREN_POS })],
      [70, () => join(h, 'isla')],
      [90, () => {
        h.world.pos = { x: -205, y: 18, z: 318 };
        h.emit('enemy:alerted', { entityId: 'b1', kind: 'bramblekin', campId: 'village_raid' });
        h.emit('enemy:telegraph', telegraph);
      }],
      [110, () => (h.world.emberMarked = true)],
      [160, () => (h.world.pos = { x: TUTORIAL_ANCHORS.breezewatch_field.x, y: 24, z: TUTORIAL_ANCHORS.breezewatch_field.z })],
      [200, () => h.emit('area:entered', { regionId: 'verdant', areaId: 'breezewatch_base', first: true })],
      [260, () => h.emit('area:entered', { regionId: 'verdant', areaId: 'vista_verdant', first: true })],
      [290, () => join(h, 'wren')],
    ];
    for (const [at, act] of timeline) {
      h.run(at - h.t);
      act();
    }
    h.run(60);
    const order = h.shown.map((s) => s.id);
    for (const id of FIRST_TEN_MINUTE_HINTS) expect(order).toContain(id);
    expect(order.indexOf('tut_glide')).toBe(order.length - 1);
    expect(h.closed.map((c) => c.id)).toEqual(order);
    for (let i = 0; i < h.shown.length; i++) {
      const lasted = h.closed[i].t - h.shown[i].t;
      expect(lasted, h.shown[i].id).toBeGreaterThan(HINT_SHOW_SECONDS - 0.05);
      expect(lasted, h.shown[i].id).toBeLessThan(HINT_SHOW_SECONDS + 0.05);
      if (i + 1 < h.shown.length) expect(h.closed[i].t).toBeLessThan(h.shown[i + 1].t);
    }
    // The glide hint shows within the first 10 minutes of play.
    expect(h.shown[h.shown.length - 1].t).toBeLessThan(600);
  });
});

describe('Tutorial_System rules', () => {
  it('hides the hint and stops its timer during a cinematic, a menu or a dialogue', () => {
    const h = harness();
    h.tick();
    h.run(2);
    expect(h.showing('tut_move')).toBe(true);
    const left = h.system.remaining;
    h.world.cinematic = true;
    h.run(10);
    expect(h.system.visibleHint()).toBeNull();
    expect(h.system.current).toBe('tut_move');
    expect(h.system.remaining).toBeCloseTo(left, 6);
    // A movement key pressed while the hint is hidden does not complete it.
    h.press('moveForward');
    expect(h.gs.tutorials).toEqual([]);
    h.world.cinematic = false;
    h.input.setContext('menu');
    h.run(5);
    expect(h.system.visibleHint()).toBeNull();
    expect(h.system.remaining).toBeCloseTo(left, 6);
    h.input.setContext('gameplay');
    h.tick();
    expect(h.showing('tut_move')).toBe(true);
    h.run(left + 0.1);
    expect(h.gs.tutorials).toEqual(['tut_move']);
  });

  it('never shows a completed hint again, also after a load; only Settings lists it', () => {
    const gs = createNewGameState(1);
    gs.tutorials.push('tut_move', 'tut_camera', 'tut_jump');
    const h = harness(gs);
    h.world.pos = { ...TUTORIAL_ANCHORS.plaza_step };
    h.run(12);
    h.emit('tutorial:trigger', { hintId: 'tut_jump' });
    h.run(1);
    expect(h.shown).toEqual([]);
    // An explicit request for an open hint queues it (the join-cinematic hook of task 21.4 can use this).
    h.emit('tutorial:trigger', { hintId: 'tut_switch' });
    h.run(0.1);
    expect(h.showing('tut_switch')).toBe(true);
    h.emit('tutorial:trigger', { hintId: 'tut_unknown' });
    h.run(0.1);
    expect(h.system.pending).toEqual([]);
  });

  it('completes an action hint by holding its key, and an event hint only by an event while it is current', () => {
    const h = harness();
    h.gs.tutorials.push('tut_move', 'tut_camera');
    h.emit('party:switched', { from: 'kairen', to: 'isla' }); // before the hint: does not count
    join(h, 'isla');
    h.run(1);
    expect(h.showing('tut_switch')).toBe(true);
    h.run(1);
    expect(h.system.current).toBe('tut_switch');
    h.emit('party:switched', { from: 'kairen', to: 'isla' });
    h.run(0.1);
    expect(h.gs.tutorials).toContain('tut_switch');
  });

  it('draws the key icons from the current bindings', () => {
    const labels = hintKeyLabels(['moveForward', 'moveLeft', 'moveBack', 'moveRight'], DEFAULT_BINDINGS);
    expect(labels).toEqual(['W', 'A', 'S', 'D']);
    expect(hintKeyLabels(['attack', 'dodge', 'switch2'], DEFAULT_BINDINGS)).toEqual(['좌클릭', '우클릭', '2']);
    const remapped: Bindings = { ...DEFAULT_BINDINGS, jump: 'KeyF', interact: 'Space' };
    expect(hintKeyLabels(['jump'], remapped)).toEqual(['F']);
    expect(hintKeyLabels(['interact'], remapped)).toEqual(['Space']);
    expect(hintKeyLabels(['pause', 'perfOverlay'], DEFAULT_BINDINGS)).toEqual(['Esc', 'F3']);
  });
});

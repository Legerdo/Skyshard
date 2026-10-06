import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { CinematicPlayer, type CinematicCue } from '../../../src/cinematics/cinematicPlayer';
import { createGameEventBus, type GameEventName } from '../../../src/core/gameEvents';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CINEMATIC_IDS, CINEMATICS, type CinematicDef } from '../../../src/data/cinematics';
import type { CinematicId } from '../../../src/data/ids';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import type { RuntimeState } from '../../../src/save/runtimeState';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Cinematic_System playback (task 21.1; design "재생 규칙"; Req 7.2, 21.9–21.11).

const DT = 1 / 60;

function setup(options: { seen?: string[]; defs?: Record<string, CinematicDef> } = {}) {
  const bus = createGameEventBus();
  const events: { type: GameEventName; payload: Record<string, unknown> }[] = [];
  bus.onAny((type, payload) => {
    if (type.startsWith('cinematic:')) events.push({ type, payload: payload as Record<string, unknown> });
  });
  const runtime: Pick<RuntimeState, 'cinematic'> = { cinematic: null };
  const seen = options.seen ?? [];
  const held = new Set<'pause' | 'jump'>();
  const changes: (CinematicId | null)[] = [];
  const cues: CinematicCue[] = [];
  const player = new CinematicPlayer({
    bus, runtime, seen, defs: options.defs, input: { down: (a) => held.has(a) },
    onChange: (id) => changes.push(id), onCue: (cue) => cues.push(cue),
  });
  const tick = (): void => {
    player.tick(DT);
    bus.dispatch();
  };
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / DT); i++) tick();
  };
  const worldEvents = () => events.filter((e) => e.type === 'cinematic:event').map((e) => `${String(e.payload.kind)}:${String(e.payload.key)}`);
  return { bus, events, runtime, seen, held, changes, cues, player, tick, run, worldEvents };
}

describe('CinematicPlayer', () => {
  it('plays from its triggers, reports skippableAfter, records perSave ids and never replays them', () => {
    const s = setup();
    s.bus.emit('landmark:discovered', { landmarkId: 'lm_elderbough', regionId: 'verdant' });
    s.bus.dispatch();
    expect(s.player.playing).toBe('cin_landmark_elderbough');
    expect(s.events[0]).toEqual({ type: 'cinematic:started', payload: { cinematicId: 'cin_landmark_elderbough', skippableAfter: Infinity } });
    expect(s.seen).toEqual(['cin_landmark_elderbough']);
    s.run(3.05);
    expect(s.player.playing).toBeNull();
    expect(s.events.at(-1)).toEqual({ type: 'cinematic:ended', payload: { cinematicId: 'cin_landmark_elderbough', skipped: false } });
    s.player.play('cin_landmark_elderbough');
    expect(s.player.playing).toBeNull(); // once per save
    s.bus.emit('party:joined', { characterId: 'isla' });
    s.bus.dispatch();
    expect(s.events.at(-1)).toEqual({ type: 'cinematic:started', payload: { cinematicId: 'cin_join_isla', skippableAfter: 1 } });
    // Already in the save's cinematicsSeen: not played.
    const loaded = setup({ seen: ['cin_skyshard_1'] });
    loaded.bus.emit('skyshard:acquired', { index: 1, regionId: 'verdant' });
    loaded.bus.dispatch();
    expect(loaded.player.playing).toBeNull();
  });

  it('queues requests made while one plays and starts them as soon as it ends', () => {
    const s = setup();
    s.bus.emit('area:entered', { regionId: 'verdant', areaId: 'hollowroot', first: true });
    s.bus.emit('area:entered', { regionId: 'verdant', areaId: 'hollowroot', first: false });
    s.bus.emit('landmark:discovered', { landmarkId: 'lm_waterfall', regionId: 'verdant' });
    s.bus.dispatch();
    expect([s.player.playing, s.player.queued]).toEqual(['cin_area_hollowroot', ['cin_landmark_waterfall']]);
    s.run(3.02);
    expect(s.player.playing).toBe('cin_landmark_waterfall');
    s.run(3.02);
    expect(s.changes).toEqual(['cin_area_hollowroot', 'cin_landmark_waterfall', null]);
  });

  it('skips a long cinematic only by a 1 s hold that starts counting 1 s in, applying every remaining world event', () => {
    const s = setup();
    s.bus.emit('skyshard:acquired', { index: 1, regionId: 'verdant' });
    s.bus.dispatch();
    s.held.add('jump'); // pressed at once: counts from 1 s
    s.run(1.9);
    expect(s.player.playing).toBe('cin_skyshard_1');
    expect(s.player.view()?.skipProgress ?? 0).toBeGreaterThan(0.8);
    s.run(0.15);
    expect(s.player.playing).toBeNull();
    expect(s.runtime.cinematic).toBeNull();
    expect(s.events.at(-1)).toEqual({ type: 'cinematic:ended', payload: { cinematicId: 'cin_skyshard_1', skipped: true } });
    // The whole timeline's world events, in order, although it was cut at 2 s.
    expect(s.worldEvents()).toEqual(['timeOfDay:noon', 'worldChange:gate_ember']);
    // Titles / VFX after the cut were dropped.
    expect(s.cues.every((c) => c.kind !== 'title' || c.data === 'skyshard_1')).toBe(true);
  });

  it('empties the gauge when let go early, and ignores a key held since before the start until it is released', () => {
    const s = setup();
    s.held.add('pause'); // down when the cinematic starts
    s.bus.emit('altar:activated', {});
    s.bus.dispatch();
    s.run(3);
    expect(s.player.playing).toBe('cin_altar'); // never counted
    expect(s.player.view()?.skipProgress).toBe(0);
    s.held.delete('pause');
    s.tick();
    s.held.add('pause');
    s.run(0.5);
    expect(s.player.view()?.skipProgress ?? 0).toBeGreaterThan(0.4);
    s.held.delete('pause');
    s.tick();
    expect(s.player.view()?.skipProgress).toBe(0);
    s.held.add('pause');
    s.run(1.05);
    expect(s.player.playing).toBeNull();
  });

  it('never skips a cinematic of 3 s or less', () => {
    const s = setup();
    s.bus.emit('boss:phaseChanged', { bossId: 'caelith', from: 1, to: 2 });
    s.bus.dispatch();
    s.held.add('pause');
    s.run(2.9);
    expect(s.player.playing).toBe('cin_boss_phase2');
    expect(s.player.view()?.skipAvailable).toBe(false);
  });

  it('plays a Phase transition once per fight: a Party_Wipe (the retry) or resetFight allows it again', () => {
    const s = setup();
    const phase = (): void => {
      s.bus.emit('boss:phaseChanged', { bossId: 'caelith', from: 2, to: 3 });
      s.bus.dispatch();
    };
    phase();
    s.run(3.05);
    phase();
    expect(s.player.playing).toBeNull();
    s.bus.emit('party:wipe', { bossPhase: 3 });
    s.bus.dispatch();
    phase();
    expect(s.player.playing).toBe('cin_boss_phase3');
    expect(s.seen).not.toContain('cin_boss_phase3'); // not saved
  });

  it('ends skipped and watched playbacks with the same world events (any cinematic, any skip time)', () => {
    const skippable = CINEMATIC_IDS.filter((id) => CINEMATICS[id]?.skippable === true);
    fc.assert(
      fc.property(fc.constantFrom(...skippable), fc.double({ min: 0, max: 1, noNaN: true }), (id, at) => {
        const watched = setup();
        watched.player.play(id);
        watched.run((CINEMATICS[id]?.duration ?? 0) + 0.1);
        const skipped = setup();
        skipped.player.play(id);
        const duration = CINEMATICS[id]?.duration ?? 0;
        skipped.run(1 + at * Math.max(0, duration - 2.2)); // then hold 1 s
        skipped.held.add('pause');
        skipped.run(1.1);
        skipped.held.delete('pause');
        skipped.run(duration);
        expect(skipped.player.playing).toBeNull();
        expect(skipped.worldEvents()).toEqual(watched.worldEvents());
        const lastMusic = (cues: CinematicCue[]) => cues.filter((c) => c.kind === 'music').at(-1)?.data ?? null;
        expect(lastMusic(skipped.cues)).toBe(lastMusic(watched.cues));
      }),
      { numRuns: 60 },
    );
  });

  it('evaluates shots relative to their anchor, following an entity with its axes latched at the shot start', () => {
    const def: CinematicDef = {
      id: 'cin_join_test', duration: 4, letterbox: true, skippable: true, once: 'perSave', events: [],
      shots: [
        { t0: 0, t1: 2, ease: 'linear', anchor: 'player', from: { pos: { x: 0, y: 2, z: 4 }, look: { x: 0, y: 1, z: 0 }, fov: 40 }, to: { pos: { x: 0, y: 2, z: 8 }, look: { x: 0, y: 1, z: 0 }, fov: 60 } },
        { t0: 2, t1: 4, ease: 'inOut', anchor: 'gate_ember', from: { pos: { x: -10, y: 5, z: 0 }, look: { x: 0, y: 5, z: 0 }, fov: 50 }, to: { pos: { x: -10, y: 5, z: 0 }, look: { x: 0, y: 5, z: 0 }, fov: 50 } },
      ],
    };
    const s = setup({ defs: { cin_join_test: def } });
    let frame = { pos: { x: 10, y: 0, z: 20 }, yaw: Math.PI / 2 }; // facing +x
    const resolve = () => frame;
    s.player.play('cin_join_test');
    const first = s.player.cameraPose(resolve);
    expect(first?.position.x).toBeCloseTo(14, 9); // local +z (4 m ahead) turned to +x
    expect(first?.position.z).toBeCloseTo(20, 9);
    expect(first?.fov).toBe(40);
    s.run(1);
    frame = { pos: { x: 12, y: 0, z: 20 }, yaw: 0 }; // moved and turned: followed, axes kept
    const mid = s.player.cameraPose(resolve);
    expect(mid?.position.x).toBeCloseTo(12 + 6, 6);
    expect(mid?.lookAt).toEqual({ x: 12, y: 1, z: 20 });
    expect(mid?.fov).toBeCloseTo(50, 6);
    s.run(1.5);
    expect(s.player.cameraPose(resolve)).toEqual({ position: { x: 50, y: 25, z: 300 }, lookAt: { x: 60, y: 25, z: 300 }, fov: 50 });
  });
});

describe('Cinematic_System in the play session', () => {
  let terrain: TerrainField;
  beforeAll(() => {
    terrain = buildTerrain(20240601);
  });

  it('holds control and freezes the world while it plays, and gives control back on the next tick', () => {
    const gameState = createNewGameState(20240601);
    const input = new InputState();
    const sim = new PlaySim({ gameState, terrain, input, commands: new UiCommandQueue(), sinks: { partyWipe: () => {}, ending: () => {} } });
    const step = (raw: RawInput[] = []): void => {
      input.beginTick(raw, DT);
      sim.tick(DT, 0);
    };
    for (let i = 0; i < 10; i++) step();
    sim.cinematics.play('cin_landmark_waterfall');
    step([{ kind: 'down', code: 'KeyW', time: 0 }]);
    const start = { ...sim.player.state.pos };
    let ticks = 0;
    while (sim.cinematics.playing !== null) {
      step();
      ticks++;
      expect(sim.player.state.pos).toEqual(start); // no movement while it plays, W held all along
    }
    expect(ticks).toBeLessThanOrEqual(Math.ceil(3 / DT) + 1);
    // The tick it ended in still held input; the very next one moves the character (≤ 0.3 s, Req 21.10).
    expect(sim.player.state.pos).toEqual(start);
    step();
    expect(Math.hypot(sim.player.state.pos.x - start.x, sim.player.state.pos.z - start.z)).toBeGreaterThan(0);
    expect(gameState.cinematicsSeen).toContain('cin_landmark_waterfall');
    sim.dispose();
  });
});

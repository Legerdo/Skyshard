import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioEngine } from '../../../src/audio/audioEngine';
import { SessionAudio, type SessionAudioSim } from '../../../src/audio/sessionAudio';
import { voicePitchHz } from '../../../src/audio/voicePitch';
import { createGameEventBus } from '../../../src/core/gameEvents';
import type { BossState } from '../../../src/boss/bossSnapshot';
import type { MoveMode } from '../../../src/player/core/types';
import type { PlayingKind } from '../../../src/combat/playerCombat';
import { VolumeIndex } from '../../../src/world/volumeIndex';

type Call = [string, ...unknown[]];

/** An AudioEngine stand-in recording what the session asks for. */
function recorder(): { engine: AudioEngine; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return true;
  };
  const engine = {
    sfx: rec('sfx'), voiceBlip: rec('voiceBlip'), playMusic: rec('playMusic'), setAmbient: rec('setAmbient'),
    setGlideWind: rec('setGlideWind'), setLoops: rec('setLoops'), setListener: () => undefined,
  } as unknown as AudioEngine;
  return { engine, calls };
}

function fakeSim() {
  const bus = createGameEventBus();
  const state = {
    inCombat: false,
    mode: 'grounded' as MoveMode,
    attackKind: null as PlayingKind | null,
    comboStep: -1,
    boss: 'dormant' as BossState,
    energy: { kairen: 0, isla: 0, wren: 0, talus: 0 },
  };
  const sim: SessionAudioSim = {
    bus,
    gameState: { altarActivated: false, party: { active: 'kairen' } },
    runtime: {
      get inCombat() { return state.inCombat; },
      enemies: new Map([['e1', { def: 'bramblekin' as const, pos: { x: 1, y: 0, z: -3 } }]]),
      energy: state.energy,
    },
    player: { state: { pos: { x: 0, y: 0, z: 0 }, get mode() { return state.mode; } } },
    combat: { get attackKind() { return state.attackKind; }, get comboStep() { return state.comboStep; } },
    boss: {
      get state() { return state.boss; },
      snapshot: () => ({ music: 'mus_boss_p2' as const, pos: { x: 0, y: 0, z: -10 }, telegraphs: [], starshellBreaks: 0 }),
    },
    challenge: { current: null },
    volumes: new VolumeIndex(),
  };
  return { bus, sim, state };
}

describe('SessionAudio (tasks 16.2, 16.3)', () => {
  it('turns bus events and controller sinks into sounds', () => {
    const { engine, calls } = recorder();
    const { bus, sim } = fakeSim();
    const audio = new SessionAudio({ engine, sim, camera: new THREE.PerspectiveCamera() });
    bus.emit('reaction', { reaction: 'steamBurst', targetId: 'e1', position: { x: 0, y: 0, z: -2 }, chainDepth: 0 });
    bus.emit('enemy:telegraph', {
      entityId: 'e1', kind: 'bramblekin', attackId: 'atk_bramblekin_swipe', telegraph: 'glow', strong: false, seconds: 0.6, position: { x: 1, y: 0, z: -3 }, yaw: 0,
    });
    bus.emit('dialogue:line', { speaker: 'maren', dialogueId: 'dlg_x', line: 2 });
    bus.emit('chest:opened', { chestId: 'c', tier: 'glowing' });
    bus.dispatch();
    audio.footstep('rock', { x: 0, y: 0, z: 0 });
    audio.footstep('water', { x: 0, y: 0, z: 0 });
    audio.glideWind(0.4);
    const ids = calls.filter((c) => c[0] === 'sfx').map((c) => c[1]);
    expect(ids).toEqual(['sfx_reaction_steam_burst', 'sfx_enemy_plant_windup', 'sfx_chest_glowing', 'sfx_step_stone', 'sfx_step_water']);
    const blip = calls.find((c) => c[0] === 'voiceBlip');
    expect(blip?.[1]).toBeCloseTo(voicePitchHz('maren'));
    expect(calls).toContainEqual(['setGlideWind', 0.4]);
    audio.dispose();
    bus.emit('chest:opened', { chestId: 'c', tier: 'common' });
    bus.dispatch();
    expect(calls.filter((c) => c[0] === 'sfx')).toHaveLength(5);
  });

  it('asks for the Title track, then the Region, combat on an alert, the boss Phase and Victory', () => {
    const { engine, calls } = recorder();
    const { bus, sim, state } = fakeSim();
    const audio = new SessionAudio({ engine, sim, camera: new THREE.PerspectiveCamera() });
    const music = (): unknown[] => calls.filter((c) => c[0] === 'playMusic').map((c) => c[1]);
    audio.update(0.016, true);
    expect(music()).toEqual(['mus_title_village']);
    expect(calls).toContainEqual(['setAmbient', 'verdant']);
    bus.emit('area:entered', { regionId: 'ember', areaId: 'ember', first: true });
    bus.dispatch();
    audio.update(0.016, false);
    expect(music().at(-1)).toBe('mus_ember');
    expect(calls).toContainEqual(['setAmbient', 'ember']);
    bus.emit('enemy:alerted', { entityId: 'e1', kind: 'bramblekin', campId: null });
    bus.dispatch();
    audio.update(0.016, false);
    expect(calls.filter((c) => c[0] === 'playMusic').at(-1)).toEqual(['playMusic', 'mus_combat', 1.5]);
    state.boss = 'idle';
    audio.update(0.016, false);
    expect(calls.filter((c) => c[0] === 'playMusic').at(-1)).toEqual(['playMusic', 'mus_boss_p2', 2]);
    bus.emit('boss:defeated', { bossId: 'caelith' });
    bus.dispatch();
    state.boss = 'dead';
    audio.update(0.016, false);
    expect(music().at(-1)).toBe('mus_victory');
  });

  it('plays the attack / mode sounds as they start and the Burst-ready chime once', () => {
    const { engine, calls } = recorder();
    const { sim, state } = fakeSim();
    const audio = new SessionAudio({ engine, sim, camera: new THREE.PerspectiveCamera() });
    audio.update(0.016, false);
    state.attackKind = 'normal';
    state.comboStep = 0;
    audio.update(0.016, false);
    audio.update(0.016, false);
    state.comboStep = 1;
    audio.update(0.016, false);
    state.mode = 'dodge';
    audio.update(0.016, false);
    state.energy.kairen = 1000;
    audio.update(0.016, false);
    audio.update(0.016, false);
    const ids = calls.filter((c) => c[0] === 'sfx').map((c) => c[1]);
    expect(ids).toEqual(['sfx_kairen_attack', 'sfx_kairen_attack', 'sfx_dodge', 'sfx_burst_ready']);
  });
});

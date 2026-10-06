import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AMBIENT_DEFS } from '../../../src/audio/ambient';
import { closestPointInVolume, landingGain } from '../../../src/audio/sessionAudio';
import {
  characterSfx, ENEMY_ARCHETYPES, enemySfx, FOOTSTEP_MATERIALS, footstepSfx, recipeLength, SFX_RECIPES, sfxRecipe,
  VOICE_BLIP_MAX_SECONDS, voiceBlipRecipe,
} from '../../../src/audio/sfxRecipes';
import { spatialize, SPATIAL_MAX_DISTANCE } from '../../../src/audio/spatial';
import { uiScreenSfx } from '../../../src/audio/uiSounds';
import { hzToMidi, VOICE_PITCH, voicePitchHz } from '../../../src/audio/voicePitch';
import { MAX_VOICES, pickVictim, type VoiceLike } from '../../../src/audio/voicePool';
import { createRng } from '../../../src/core/rng';
import { SPEAKER_VOICE_HZ } from '../../../src/data/dialogue';
import { CHARACTER_IDS, ELITE_IDS, ENEMY_IDS, NPC_IDS, REACTION_IDS } from '../../../src/data/ids';
import { REACTION_PRESENTATION } from '../../../src/data/reactions';
import type { UiScreenId } from '../../../src/core/gameEvents';

/** Every id the session audio, the menu sounds and the engine play directly. */
const PLAYED_IDS = [
  'sfx_jump', 'sfx_land', 'sfx_climb_grab', 'sfx_mantle', 'sfx_dodge', 'sfx_glide_open', 'sfx_glide_wind', 'sfx_water_enter',
  'sfx_player_hit', 'sfx_downed', 'sfx_perfect_dodge', 'sfx_hit_generic', 'sfx_hit_crit', 'sfx_weak_spot',
  'sfx_boss_roar', 'sfx_boss_windup', 'sfx_boss_hit', 'sfx_boss_shell_break',
  'sfx_ui_move', 'sfx_ui_confirm', 'sfx_ui_cancel', 'sfx_ui_refuse', 'sfx_ui_open', 'sfx_ui_close', 'sfx_burst_ready',
  'sfx_chest_open', 'sfx_chest_glowing', 'sfx_discovery', 'sfx_level_up', 'sfx_skyshard', 'sfx_barrier_break',
  'sfx_puzzle_step', 'sfx_puzzle_solved', 'sfx_puzzle_fail', 'sfx_waystone', 'sfx_checkpoint', 'sfx_pickup', 'sfx_altar',
  'sfx_quest_complete', 'sfx_defeat', 'sfx_updraft_loop', 'sfx_wind_zone_loop', 'sfx_voice_blip',
] as const;

describe('sound effect catalog (task 16.3, Req 37.2, 26.5)', () => {
  it('has a recipe for every sound the game plays', () => {
    const ids: string[] = [...PLAYED_IDS];
    ids.push(...FOOTSTEP_MATERIALS.map(footstepSfx));
    for (const c of CHARACTER_IDS) for (const s of ['attack', 'skill', 'burst', 'switch'] as const) ids.push(characterSfx(c, s));
    for (const e of [...ENEMY_IDS, ...ELITE_IDS]) {
      expect(ENEMY_ARCHETYPES[e], e).toBeDefined();
      for (const s of ['alert', 'windup', 'hit', 'death'] as const) ids.push(enemySfx(e, s));
    }
    for (const r of REACTION_IDS) ids.push(REACTION_PRESENTATION[r].sfx);
    for (const def of Object.values(AMBIENT_DEFS)) ids.push(def.bed, ...def.intermittent);
    const screens: UiScreenId[] = ['pause', 'settings', 'map', 'inventory', 'defeat', 'title', 'gameplay'];
    for (const s of screens) for (const open of [true, false]) {
      const id = uiScreenSfx(s, open);
      if (id !== null) ids.push(id);
    }
    for (const id of ids) expect(sfxRecipe(id), id).not.toBeNull();
  });

  it('gives the six Reactions six distinct sounds', () => {
    const sounds = REACTION_IDS.map((r) => JSON.stringify(sfxRecipe(REACTION_PRESENTATION[r].sfx)));
    expect(new Set(sounds).size).toBe(REACTION_IDS.length);
  });

  it('keeps one-shots short and finite, loops looping, and the footsteps varied ±5 % / ±2 dB', () => {
    for (const [id, r] of Object.entries(SFX_RECIPES)) {
      expect(r.layers.length, id).toBeGreaterThan(0);
      for (const l of r.layers) {
        expect(l.gain, id).toBeGreaterThan(0);
        expect(l.gain, id).toBeLessThanOrEqual(1);
        expect(l.freq, id).toBeGreaterThan(0);
      }
      const isLoop = id.endsWith('_loop') || id === 'sfx_glide_wind' || Object.values(AMBIENT_DEFS).some((d) => d.bed === id);
      expect(r.loop === true, id).toBe(isLoop);
      if (!isLoop) {
        expect(recipeLength(r), id).toBeGreaterThan(0);
        expect(recipeLength(r), id).toBeLessThan(4);
      }
    }
    for (const m of FOOTSTEP_MATERIALS) {
      const r = sfxRecipe(footstepSfx(m));
      expect(r?.vary).toEqual({ pitch: 0.05, gainDb: 2 });
      expect(r?.group).toBe('world');
    }
    expect(sfxRecipe('sfx_ui_confirm')?.group).toBe('ui');
    expect(sfxRecipe('sfx_amb_verdant')?.group).toBe('ambient');
  });

  it('voice blips: 3–4 syllables within 0.3 s in the voice group', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 31 }), fc.double({ min: 100, max: 800, noNaN: true }), (seed, hz) => {
      const r = voiceBlipRecipe(hz, createRng(seed));
      return r.group === 'voice' && r.layers.length >= 3 && r.layers.length <= 4 && recipeLength(r) <= VOICE_BLIP_MAX_SECONDS + 1e-9;
    }));
  });
});

describe('voicePitch (Req 37.7)', () => {
  it('gives the 7 NPCs and 4 companions 11 different semitones, each the nearest to its SPEAKER_VOICE_HZ', () => {
    const speakers = [...NPC_IDS, ...CHARACTER_IDS];
    expect(Object.keys(VOICE_PITCH).sort()).toEqual([...speakers].sort());
    const semis = speakers.map((s) => VOICE_PITCH[s]);
    expect(new Set(semis).size).toBe(11);
    for (const s of speakers) {
      expect(Number.isInteger(VOICE_PITCH[s])).toBe(true);
      expect(VOICE_PITCH[s]).toBe(hzToMidi(SPEAKER_VOICE_HZ[s]));
      expect(Math.abs(12 * Math.log2(voicePitchHz(s) / SPEAKER_VOICE_HZ[s]))).toBeLessThan(0.5);
    }
  });
});

describe('spatialization and the voice cap (task 16.3, Req 19.8)', () => {
  const listener = { pos: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };

  it('gain = min(1, 3 m / d), pan = sin(azimuth) × 0.8, nothing beyond 60 m', () => {
    fc.assert(fc.property(fc.double({ min: 0.1, max: 80, noNaN: true }), fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), (d, az) => {
      const s = spatialize(listener, { x: Math.sin(az) * d, y: 0, z: -Math.cos(az) * d });
      if (d > SPATIAL_MAX_DISTANCE) return s === null;
      return s !== null && Math.abs(s.gain - Math.min(1, 3 / d)) < 1e-9 && Math.abs(s.pan - Math.sin(az) * 0.8) < 1e-6;
    }));
  });

  it('makes room by stopping the quietest world voice; drops a quieter world newcomer', () => {
    const voices: VoiceLike[] = Array.from({ length: MAX_VOICES }, (_, i) => ({ group: i % 4 === 0 ? 'ui' : 'world', loudness: 1 - i / 64 }));
    const quietestWorld = voices.filter((v) => v.group === 'world').reduce((a, b) => (b.loudness < a.loudness ? b : a));
    expect(pickVictim(voices, { group: 'ui', loudness: 0.1 })).toBe(quietestWorld);
    expect(pickVictim(voices, { group: 'world', loudness: 0.9 })).toBe(quietestWorld);
    expect(pickVictim(voices, { group: 'world', loudness: 0.01 })).toBe('incoming');
    expect(pickVictim(voices.map((v) => ({ ...v, group: 'ambient' as const })), { group: 'ui', loudness: 1 })).toBe('incoming');
  });

  it('hears an air volume from its closest point and scales landings with the fall', () => {
    const cyl = { kind: 'cylinder', x: 10, z: 0, radius: 2, minY: 0, maxY: 20 } as const;
    expect(closestPointInVolume(cyl, { x: 0, y: 30, z: 0 })).toEqual({ x: 8, y: 20, z: 0 });
    expect(closestPointInVolume(cyl, { x: 10.5, y: 5, z: 0 })).toEqual({ x: 10.5, y: 5, z: 0 });
    const box = { kind: 'box', x: 0, z: 0, halfX: 5, halfZ: 1, yaw: Math.PI / 2, minY: 0, maxY: 4 } as const;
    const p = closestPointInVolume(box, { x: 0, y: 2, z: 20 });
    expect(p.z).toBeCloseTo(5);
    expect(p.x).toBeCloseTo(0);
    expect(landingGain(0)).toBeLessThan(landingGain(5));
    expect(landingGain(100)).toBeLessThanOrEqual(1.3);
    expect(landingGain(Number.NaN)).toBe(landingGain(0));
  });
});

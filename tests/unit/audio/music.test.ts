import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COMBAT_HOLD_SECONDS, crossfadeSeconds, MusicDirector, placeTrack, selectMusic, type MusicSituation,
} from '../../../src/audio/musicDirector';
import { equalPowerLevel } from '../../../src/audio/sequencer';
import { CHALLENGE_AREA_IDS, REGION_IDS } from '../../../src/data/ids';
import {
  chordDegree, isValidPattern, MUSIC_TRACK_IDS, parsePattern, scaleMidi, TRACKS, type Instrument,
} from '../../../src/data/music';

/** The design table (bpm · key · mode · instruments). */
const TABLE = {
  mus_title_village: [88, 'D', 'major', ['pluck', 'lead']],
  mus_verdant: [96, 'G', 'major', ['pluck', 'lead', 'pad']],
  mus_ember: [84, 'D', 'minor', ['perc', 'pad', 'bass']],
  mus_azure: [72, 'E', 'lydian', ['bell', 'pad']],
  mus_combat: [132, 'inherit', 'inherit', ['perc', 'bass', 'pluck']],
  mus_boss_p1: [140, 'C', 'minor', ['pad', 'bass', 'perc']],
  mus_boss_p2: [148, 'C', 'minor', ['pad', 'bass', 'perc', 'bell']],
  mus_boss_p3: [156, 'C', 'minor', ['pad', 'bass', 'perc', 'bell', 'lead']],
  mus_sanctum: [66, 'C', 'dorian', ['pad', 'bell', 'lead', 'perc']],
  mus_crater: [66, 'C', 'dorian', ['pad', 'bell']],
  mus_victory: [100, 'D', 'major', ['bell', 'lead', 'pad']],
  mus_area_hollowroot: [76, 'A', 'minor', ['lead', 'pluck']],
  mus_area_cinderspire: [104, 'G', 'minor', ['perc', 'pad']],
  mus_area_observatory: [80, 'F', 'major', ['pad', 'bell']],
} as const satisfies Record<(typeof MUSIC_TRACK_IDS)[number], readonly [number, string, string, readonly Instrument[]]>;

describe('track data (task 16.2, Req 37.1, 12.4)', () => {
  it('has one TrackDef per music id with the design bpm, key, mode and instruments', () => {
    expect(Object.keys(TRACKS).sort()).toEqual([...MUSIC_TRACK_IDS].sort());
    for (const id of MUSIC_TRACK_IDS) {
      const def = TRACKS[id];
      const [bpm, key, mode, instruments] = TABLE[id];
      expect(def.id, id).toBe(id);
      expect(def.bpm, id).toBe(bpm);
      expect(def.key, id).toBe(key);
      expect(def.mode, id).toBe(mode);
      const used = new Set(def.layers.map((l) => l.instrument));
      for (const inst of instruments) expect(used.has(inst), `${id} ${inst}`).toBe(true);
    }
  });

  it('only Victory stops at its end; every pattern and chord parses; drums name their drum', () => {
    for (const id of MUSIC_TRACK_IDS) {
      const def = TRACKS[id];
      expect(def.loop, id).toBe(id !== 'mus_victory');
      expect(def.bars, id).toBeGreaterThan(0);
      expect(def.chords.length, id).toBeGreaterThan(0);
      for (const c of def.chords) expect(chordDegree(c), `${id} ${c}`).not.toBeNull();
      for (const l of def.layers) {
        const perc = l.instrument === 'perc';
        expect(isValidPattern(l.pattern, perc), `${id} ${l.pattern}`).toBe(true);
        expect(parsePattern(l.pattern, perc).some((n) => n !== null), `${id} ${l.pattern}`).toBe(true);
        if (perc) expect(l.drum, id).toBeDefined();
        expect(l.gain).toBeGreaterThan(0);
        expect(l.gain).toBeLessThanOrEqual(1);
        expect(l.send).toBeGreaterThanOrEqual(0);
        expect(l.send).toBeLessThanOrEqual(1);
      }
    }
  });

  it('boss Phases add layers, the crater keeps only the Sanctum pad and bell, the Observatory pad sings', () => {
    const p1 = TRACKS.mus_boss_p1.layers;
    const p2 = TRACKS.mus_boss_p2.layers;
    const p3 = TRACKS.mus_boss_p3.layers;
    expect(p2.slice(0, p1.length)).toEqual(p1);
    expect(p3.slice(0, p2.length)).toEqual(p2);
    expect(p3.length).toBeGreaterThan(p2.length);
    expect(p2.length).toBeGreaterThan(p1.length);
    for (const layer of TRACKS.mus_crater.layers) expect(TRACKS.mus_sanctum.layers).toContain(layer);
    expect(TRACKS.mus_crater.layers.map((l) => l.instrument).sort()).toEqual(['bell', 'pad']);
    expect(TRACKS.mus_area_observatory.layers.some((l) => l.instrument === 'pad' && l.formant === true)).toBe(true);
  });

  it('keeps every note in a sane range', () => {
    for (const id of MUSIC_TRACK_IDS) {
      const def = TRACKS[id];
      const key = def.key === 'inherit' ? 'C' : def.key;
      const mode = def.mode === 'inherit' ? 'major' : def.mode;
      for (const l of def.layers) {
        if (l.instrument === 'perc') continue;
        for (const cell of parsePattern(l.pattern, false)) {
          if (cell === null) continue;
          for (const c of def.chords) {
            for (const v of l.voicing ?? [0]) {
              const midi = scaleMidi(key, mode, l.octave, (chordDegree(c) ?? 0) + cell.step + v);
              expect(midi, id).toBeGreaterThanOrEqual(24);
              expect(midi, id).toBeLessThanOrEqual(108);
            }
          }
        }
      }
    }
  });
});

const situation = fc.record<MusicSituation>({
  title: fc.boolean(),
  victory: fc.boolean(),
  bossTrack: fc.constantFrom(null, 'mus_boss_p1', 'mus_boss_p2', 'mus_boss_p3'),
  inCombat: fc.boolean(),
  region: fc.constantFrom(null, ...REGION_IDS),
  challengeArea: fc.constantFrom(null, ...CHALLENGE_AREA_IDS),
  village: fc.boolean(),
  altarActivated: fc.boolean(),
});

describe('music selection (task 16.2, Req 37.3)', () => {
  it('Victory > the boss Phase > In_Combat > the place', () => {
    fc.assert(fc.property(situation, fc.boolean(), (s, combat) => {
      const choice = selectMusic(s, combat);
      if (s.victory) return choice.track === 'mus_victory';
      if (s.bossTrack !== null) return choice.track === s.bossTrack;
      if (combat && !s.title) return choice.track === 'mus_combat';
      return choice.track === placeTrack(s) && choice.category === 'place';
    }));
  });

  it('picks the place track: Title / Thistlewick, Challenge_Areas, Regions, the crater before and after the altar', () => {
    const base = { title: false, region: 'verdant', challengeArea: null, village: false, altarActivated: false } as const;
    expect(placeTrack({ ...base, title: true })).toBe('mus_title_village');
    expect(placeTrack({ ...base, village: true })).toBe('mus_title_village');
    expect(placeTrack(base)).toBe('mus_verdant');
    expect(placeTrack({ ...base, region: 'ember' })).toBe('mus_ember');
    expect(placeTrack({ ...base, region: 'azure' })).toBe('mus_azure');
    expect(placeTrack({ ...base, region: 'crater' })).toBe('mus_crater');
    expect(placeTrack({ ...base, region: 'crater', altarActivated: true })).toBe('mus_sanctum');
    expect(placeTrack({ ...base, region: 'sanctum' })).toBe('mus_sanctum');
    for (const area of CHALLENGE_AREA_IDS) expect(placeTrack({ ...base, challengeArea: area })).toBe(`mus_area_${area}`);
  });

  it('crossfades 1.5 s into combat, 2 s into the boss / a Phase / Victory, 3 s for places and leaving combat', () => {
    expect(crossfadeSeconds('place', 'combat')).toBe(1.5);
    expect(crossfadeSeconds('combat', 'boss')).toBe(2);
    expect(crossfadeSeconds('boss', 'boss')).toBe(2);
    expect(crossfadeSeconds('boss', 'victory')).toBe(2);
    expect(crossfadeSeconds('place', 'place')).toBe(3);
    expect(crossfadeSeconds('combat', 'place')).toBe(3);
    fc.assert(fc.property(fc.constantFrom(null, 'victory', 'boss', 'combat', 'place' as const), fc.constantFrom('victory', 'boss', 'combat', 'place' as const), (a, b) => {
      const s = crossfadeSeconds(a, b);
      return s >= 1.5 && s <= 3;
    }));
  });

  it('holds mus_combat 3 s after In_Combat ends; combat resuming inside the hold changes nothing', () => {
    const d = new MusicDirector();
    const s: MusicSituation = {
      title: false, victory: false, bossTrack: null, inCombat: false, region: 'verdant', challengeArea: null, village: false, altarActivated: false,
    };
    expect(d.update(0.016, s)).toEqual({ track: 'mus_verdant', fadeSec: 2 });
    expect(d.update(0.016, { ...s, inCombat: true })).toEqual({ track: 'mus_combat', fadeSec: 1.5 });
    expect(d.update(COMBAT_HOLD_SECONDS - 0.5, s)).toBeNull();
    expect(d.update(0.1, { ...s, inCombat: true })).toBeNull();
    expect(d.update(COMBAT_HOLD_SECONDS - 0.1, s)).toBeNull();
    expect(d.update(0.2, s)).toEqual({ track: 'mus_verdant', fadeSec: 3 });
    expect(d.update(0.016, { ...s, bossTrack: 'mus_boss_p1' })).toEqual({ track: 'mus_boss_p1', fadeSec: 2 });
    expect(d.update(0.016, { ...s, bossTrack: 'mus_boss_p2', inCombat: true })).toEqual({ track: 'mus_boss_p2', fadeSec: 2 });
    expect(d.update(0.016, { ...s, victory: true })).toEqual({ track: 'mus_victory', fadeSec: 2 });
  });

  it('equal-power fades keep the summed power at 1 and continue from any level', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (x) => {
      const up = equalPowerLevel(0, 1, x);
      const down = equalPowerLevel(1, 0, x);
      return Math.abs(up * up + down * down - 1) < 1e-9;
    }));
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (from) =>
      Math.abs(equalPowerLevel(from, 1, 0) - from) < 1e-9 && Math.abs(equalPowerLevel(from, 1, 1) - 1) < 1e-9
      && Math.abs(equalPowerLevel(from, 0, 1)) < 1e-9));
  });
});

/*
 * Procedural music tracks (design "절차적 음악 시퀀서", task 16.2, Req 37.1, 12.4): read-only `TrackDef`s the
 * Audio_System's lookahead sequencer (src/audio/sequencer.ts) plays, one per music id, plus the small theory helpers
 * that turn a bar's roman-numeral chord and a pattern cell into a note.
 *
 * - `chords`: one roman numeral per bar (`'I'`, `'vi'`, `'IV'`, ...), cycled over `bars`. The numeral is the chord's
 *   root as a degree of the track's own mode scale (case is only a reading aid), so the same numerals fit every mode.
 * - `LayerDef.pattern`: 16 cells per bar (16th notes), a multiple of 16 long, cycled. A cell is a note — its scale
 *   step above the current chord's root, `'0'`–`'9'` then `'a'`–`'e'` for 10–14 (0 root, 2 third, 4 fifth, 7 octave) —
 *   `'-'` holding the previous note one more step, or `'.'` a rest. Percussion layers (`instrument: 'perc'`) read
 *   `'x'` as a hit and `'X'` as an accented hit.
 * - `voicing`: extra scale steps stacked on each note (pads play `[0, 2, 4]`, a triad).
 * - `bars`: the track's length. A `loop` track starts over after it; any other stops scheduling there (Victory).
 *
 * Pure data and pure functions: no Web Audio, DOM or randomness (src/data layering rule).
 */

import type { MusicId } from './ids';

export const MUSIC_TRACK_IDS = [
  'mus_title_village',
  'mus_verdant',
  'mus_ember',
  'mus_azure',
  'mus_crater',
  'mus_sanctum',
  'mus_combat',
  'mus_victory',
  'mus_boss_p1',
  'mus_boss_p2',
  'mus_boss_p3',
  'mus_area_hollowroot',
  'mus_area_cinderspire',
  'mus_area_observatory',
] as const satisfies readonly MusicId[];
export type MusicTrackId = (typeof MUSIC_TRACK_IDS)[number];

export const PITCH_CLASSES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
export type PitchClass = (typeof PITCH_CLASSES)[number];

export type MusicMode = 'major' | 'minor' | 'dorian' | 'lydian';

/** Semitones of each mode's seven degrees above its tonic. */
export const MODE_SCALES: Readonly<Record<MusicMode, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};

/** The six synthesized instruments (design "합성 악기"); `perc` plays one of the four drums. */
export type Instrument = 'pad' | 'pluck' | 'lead' | 'bell' | 'bass' | 'perc';
export type Drum = 'kick' | 'snare' | 'hat' | 'tom';

export interface LayerDef {
  readonly instrument: Instrument;
  /** Which drum a `perc` layer plays. */
  readonly drum?: Drum;
  /** 16 cells per bar (see the file header). */
  readonly pattern: string;
  /** Octave of the key's tonic the steps count from (scientific pitch: 4 holds A 440). */
  readonly octave: number;
  /** Layer gain (0–1) before the track gain. */
  readonly gain: number;
  /** Send to the shared music reverb (0–1). */
  readonly send: number;
  /** Scale steps stacked on each note (default `[0]`). */
  readonly voicing?: readonly number[];
  /** Pad only: vowel formant filters (the Observatory's choir). */
  readonly formant?: boolean;
}

export interface TrackDef {
  readonly id: MusicTrackId;
  readonly bpm: number;
  /** Tonic, or `'inherit'`: the key of the Region / area track that played before (combat music). */
  readonly key: PitchClass | 'inherit';
  readonly mode: MusicMode | 'inherit';
  readonly bars: number;
  readonly chords: readonly string[];
  readonly layers: readonly LayerDef[];
  readonly loop: boolean;
}

// ── Theory helpers ──────────────────────────────────────────────────────────

const ROMAN_DEGREES: Readonly<Record<string, number>> = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };

/** Scale degree (0–6) of a roman-numeral chord, or null when it is not one (`'I'`–`'VII'`, any case). */
export function chordDegree(roman: string): number | null {
  const degree = ROMAN_DEGREES[roman.toLowerCase()];
  return degree === undefined ? null : degree;
}

/** A parsed pattern cell: a note of `step` lasting `length` 16th steps, or null (rest or hold). */
export interface PatternNote {
  readonly step: number;
  readonly length: number;
  /** Percussion accent (`'X'`). */
  readonly accent: boolean;
}

/** Step value of a note cell, or null for `'.'` / `'-'` / anything else. */
function cellStep(cell: string, perc: boolean): number | null {
  if (perc) return cell === 'x' || cell === 'X' ? 0 : null;
  if (cell >= '0' && cell <= '9') return cell.charCodeAt(0) - 48;
  if (cell >= 'a' && cell <= 'e') return cell.charCodeAt(0) - 87;
  return null;
}

/** Whether every cell of `pattern` is a note, `'-'` or `'.'` for its kind of layer. */
export function isValidPattern(pattern: string, perc: boolean): boolean {
  if (pattern.length === 0 || pattern.length % 16 !== 0) return false;
  for (const cell of pattern) {
    if (cell !== '.' && cell !== '-' && cellStep(cell, perc) === null) return false;
  }
  return true;
}

/**
 * The pattern as one entry per cell: the note starting there (its length counts the `'-'` cells after it, wrapping
 * is not followed) or null.
 */
export function parsePattern(pattern: string, perc: boolean): (PatternNote | null)[] {
  const out: (PatternNote | null)[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const step = cellStep(pattern[i] ?? '.', perc);
    if (step === null) {
      out.push(null);
      continue;
    }
    let length = 1;
    while (i + length < pattern.length && pattern[i + length] === '-') length++;
    out.push({ step, length, accent: pattern[i] === 'X' });
  }
  return out;
}

/** MIDI note of scale `degree` (may exceed 6 or be negative) of `key` / `mode` counted from the tonic in `octave`. */
export function scaleMidi(key: PitchClass, mode: MusicMode, octave: number, degree: number): number {
  const scale = MODE_SCALES[mode];
  const oct = Math.floor(degree / 7);
  const idx = degree - oct * 7;
  return 12 * (octave + 1) + PITCH_CLASSES.indexOf(key) + 12 * oct + (scale[idx] ?? 0);
}

/** Frequency (Hz) of a MIDI note, A4 = 69 = 440 Hz. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Seconds per 16th step at `bpm`. */
export function stepSeconds(bpm: number): number {
  return 60 / bpm / 4;
}

// ── Shared layers ───────────────────────────────────────────────────────────

const HOLD_BAR = '0---------------';
const TRIAD = [0, 2, 4] as const;

const padBar = (octave: number, gain: number, send = 0.35): LayerDef => ({
  instrument: 'pad', pattern: HOLD_BAR, octave, gain, send, voicing: TRIAD,
});
const drum = (d: Drum, pattern: string, gain: number, send = 0.1): LayerDef => ({
  instrument: 'perc', drum: d, pattern, octave: 0, gain, send,
});

/** Astral Sanctum's pad and bell: `mus_crater` keeps only these two (Req 5.4). */
const SANCTUM_PAD = padBar(3, 0.1, 0.45);
const SANCTUM_BELL: LayerDef = {
  instrument: 'bell', pattern: '4.......2.......7.......4.......', octave: 5, gain: 0.09, send: 0.55,
};

/** Caelith Phase 1 layers; Phase 2 adds the bell, the Final Phase the airy lead and tom rolls (design table). */
const BOSS_BASE: readonly LayerDef[] = [
  padBar(3, 0.09, 0.3),
  { instrument: 'bass', pattern: '0.0.0...0.0.4.2.', octave: 2, gain: 0.2, send: 0.05 },
  drum('kick', 'x.....x...x.....', 0.5),
  drum('snare', '....x.......X...', 0.24),
  drum('hat', '.x.x.x.x.x.x.x.x', 0.06),
];
const BOSS_BELL: LayerDef = { instrument: 'bell', pattern: '4...2...0...2...7...4...2...1...', octave: 5, gain: 0.08, send: 0.4 };
const BOSS_LEAD: LayerDef = {
  instrument: 'lead', pattern: '4---5---7---5-4-2---4---2-1-0---', octave: 5, gain: 0.11, send: 0.35,
};
const BOSS_TOMS = drum('tom', '........x.x.xxXx', 0.3);
const BOSS_CHORDS = ['i', 'VI', 'III', 'VII'] as const;

// ── Tracks ──────────────────────────────────────────────────────────────────

/** Every track by id, as in the design table (bpm, key, instruments). */
export const TRACKS: Readonly<Record<MusicTrackId, TrackDef>> = {
  // Warm folk (Title, Thistlewick): pluck + airy lead, 88 · D major.
  mus_title_village: {
    id: 'mus_title_village', bpm: 88, key: 'D', mode: 'major', bars: 8, loop: true,
    chords: ['I', 'V', 'vi', 'IV'],
    layers: [
      { instrument: 'pluck', pattern: '0.2.4.7.4.2.4.2.', octave: 4, gain: 0.2, send: 0.25 },
      { instrument: 'lead', pattern: '4---2-0-1---2---4---5-4-2-------', octave: 5, gain: 0.12, send: 0.4 },
      padBar(3, 0.05, 0.3),
    ],
  },
  // Pastoral (Verdant Reach): pluck arpeggio + airy lead + pad, 96 · G major.
  mus_verdant: {
    id: 'mus_verdant', bpm: 96, key: 'G', mode: 'major', bars: 8, loop: true,
    chords: ['I', 'IV', 'vi', 'V'],
    layers: [
      { instrument: 'pluck', pattern: '0.2.4.2.7.4.2.4.', octave: 4, gain: 0.18, send: 0.25 },
      { instrument: 'lead', pattern: '2---4---5-4-2---0---1-2-4-------', octave: 5, gain: 0.11, send: 0.4 },
      padBar(3, 0.07),
    ],
  },
  // Tense and low (Ember Ravine): low tom + low pad + bass, 84 · D minor.
  mus_ember: {
    id: 'mus_ember', bpm: 84, key: 'D', mode: 'minor', bars: 8, loop: true,
    chords: ['i', 'i', 'VI', 'VII'],
    layers: [
      drum('tom', 'x.....x...x.....', 0.32, 0.2),
      padBar(2, 0.09, 0.4),
      { instrument: 'bass', pattern: '0-----0---4-0---', octave: 2, gain: 0.18, send: 0.05 },
    ],
  },
  // Airy (Azure Highlands): bell + pad, 72 · E lydian.
  mus_azure: {
    id: 'mus_azure', bpm: 72, key: 'E', mode: 'lydian', bars: 8, loop: true,
    chords: ['I', 'II', 'I', 'V'],
    layers: [
      { instrument: 'bell', pattern: '4.......2...7...5.......4.......', octave: 5, gain: 0.1, send: 0.55 },
      padBar(3, 0.08, 0.5),
    ],
  },
  // Shardfall Crater before the Resonance_Altar: mus_sanctum's pad and bell only (design "선곡").
  mus_crater: {
    id: 'mus_crater', bpm: 66, key: 'C', mode: 'dorian', bars: 8, loop: true,
    chords: ['i', 'IV', 'i', 'VII'],
    layers: [SANCTUM_PAD, SANCTUM_BELL],
  },
  // Mysterious (Astral Sanctum): slow pad + bell, airy lead melody, low tom, 66 · C dorian.
  mus_sanctum: {
    id: 'mus_sanctum', bpm: 66, key: 'C', mode: 'dorian', bars: 8, loop: true,
    chords: ['i', 'IV', 'i', 'VII'],
    layers: [
      SANCTUM_PAD,
      SANCTUM_BELL,
      { instrument: 'lead', pattern: '0---2---4-------5---4---2---1---', octave: 5, gain: 0.1, send: 0.5 },
      drum('tom', 'x...........x...', 0.18, 0.3),
    ],
  },
  // Driving (In_Combat): kick / noise percussion + bass + pluck ostinato, 132 · the Region track's key.
  mus_combat: {
    id: 'mus_combat', bpm: 132, key: 'inherit', mode: 'inherit', bars: 4, loop: true,
    chords: ['I', 'VI', 'IV', 'V'],
    layers: [
      drum('kick', 'x...x...x...x...', 0.5, 0.05),
      drum('snare', '....x.......x..x', 0.22),
      drum('hat', '.x.x.x.x.x.x.x.X', 0.06, 0.05),
      { instrument: 'bass', pattern: '0.0.0.0.0.0.4.0.', octave: 2, gain: 0.18, send: 0.05 },
      { instrument: 'pluck', pattern: '0.2.4.2.0.2.4.7.', octave: 4, gain: 0.12, send: 0.2 },
    ],
  },
  // Caelith, layered up per Phase: 140 / 148 / 156 · C minor.
  mus_boss_p1: {
    id: 'mus_boss_p1', bpm: 140, key: 'C', mode: 'minor', bars: 8, loop: true, chords: BOSS_CHORDS, layers: BOSS_BASE,
  },
  mus_boss_p2: {
    id: 'mus_boss_p2', bpm: 148, key: 'C', mode: 'minor', bars: 8, loop: true, chords: BOSS_CHORDS,
    layers: [...BOSS_BASE, BOSS_BELL],
  },
  mus_boss_p3: {
    id: 'mus_boss_p3', bpm: 156, key: 'C', mode: 'minor', bars: 8, loop: true, chords: BOSS_CHORDS,
    layers: [...BOSS_BASE, BOSS_BELL, BOSS_LEAD, BOSS_TOMS],
  },
  // Hollowroot Shrine: low airy lead (woodwind) + water-drop pluck, 76 · A minor.
  mus_area_hollowroot: {
    id: 'mus_area_hollowroot', bpm: 76, key: 'A', mode: 'minor', bars: 8, loop: true,
    chords: ['i', 'VI', 'iv', 'v'],
    layers: [
      { instrument: 'lead', pattern: '0---2---4---2---1---0-----------', octave: 3, gain: 0.13, send: 0.5 },
      { instrument: 'pluck', pattern: '..7.......4.....', octave: 5, gain: 0.06, send: 0.7 },
      padBar(2, 0.04, 0.5),
    ],
  },
  // Cinderspire: low tom (taiko) + pad (strings), 104 · G minor.
  mus_area_cinderspire: {
    id: 'mus_area_cinderspire', bpm: 104, key: 'G', mode: 'minor', bars: 8, loop: true,
    chords: ['i', 'VI', 'VII', 'i'],
    layers: [
      drum('tom', 'X..x..x.x...x.x.', 0.34, 0.2),
      { instrument: 'pad', pattern: '0-------0-------', octave: 3, gain: 0.09, send: 0.35, voicing: TRIAD },
      { instrument: 'bass', pattern: '0-------0---4---', octave: 2, gain: 0.12, send: 0.05 },
    ],
  },
  // Starfall Observatory: choir pad (vowel formants) + high glass bell, 80 · F major.
  mus_area_observatory: {
    id: 'mus_area_observatory', bpm: 80, key: 'F', mode: 'major', bars: 8, loop: true,
    chords: ['I', 'vi', 'IV', 'V'],
    layers: [
      { instrument: 'pad', pattern: HOLD_BAR, octave: 4, gain: 0.08, send: 0.55, voicing: TRIAD, formant: true },
      { instrument: 'bell', pattern: '4...7...2...4...', octave: 5, gain: 0.06, send: 0.6 },
    ],
  },
  // Bright fanfare (Victory): bell + airy lead + pad, 100 · D major; plays once.
  mus_victory: {
    id: 'mus_victory', bpm: 100, key: 'D', mode: 'major', bars: 8, loop: false,
    chords: ['I', 'IV', 'V', 'I', 'vi', 'IV', 'V', 'I'],
    layers: [
      { instrument: 'bell', pattern: '0...2...4...7---', octave: 5, gain: 0.1, send: 0.45 },
      { instrument: 'lead', pattern: '4---4-5-7-------5---4---2---4---', octave: 5, gain: 0.12, send: 0.4 },
      padBar(3, 0.08, 0.4),
      drum('kick', 'x.......x.......', 0.3),
    ],
  },
};

/** Whether `id` names a track of this table. */
export function isMusicTrackId(id: string): id is MusicTrackId {
  return (MUSIC_TRACK_IDS as readonly string[]).includes(id);
}

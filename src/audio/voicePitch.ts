/*
 * Speaker voice pitches (design "발화음", Req 37.7): `voicePitch` gives each of the 7 named NPCs and the 4
 * companions its own semitone (a MIDI note number), the equal-tempered note nearest to its SPEAKER_VOICE_HZ in
 * src/data/dialogue.ts. The voice blip of every dialogue window is built around that note.
 */

import { SPEAKER_VOICE_HZ, type Speaker } from '../data/dialogue';
import { midiToHz } from '../data/music';

/** MIDI note of `hz` (A4 = 69 = 440 Hz), rounded to the nearest semitone. */
export function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

/** Each speaker's voice pitch as a MIDI semitone; no two speakers share one. */
export const VOICE_PITCH: Readonly<Record<Speaker, number>> = Object.fromEntries(
  (Object.entries(SPEAKER_VOICE_HZ) as [Speaker, number][]).map(([speaker, hz]) => [speaker, hzToMidi(hz)]),
) as Record<Speaker, number>;

/** The voice blip pitch (Hz) of `speaker`. */
export function voicePitchHz(speaker: Speaker): number {
  return midiToHz(VOICE_PITCH[speaker]);
}

/*
 * The 32-voice cap of the sound effects (design "공간감"): when a new voice would exceed it, the `world` voice heard
 * the quietest stops first. Pure bookkeeping: no Web Audio.
 */

/** Sound effect sub-groups of the sfx bus (design "버스"). */
export type SfxGroup = 'ui' | 'world' | 'ambient' | 'voice';

/** Simultaneous sound-effect voices at most. */
export const MAX_VOICES = 32;

export interface VoiceLike {
  readonly group: SfxGroup;
  /** Heard loudness (recipe gain × spatial gain). */
  readonly loudness: number;
}

/**
 * Which voice makes room for `incoming` when `voices` is full: the quietest `world` voice, or `'incoming'` when the
 * new voice itself is a world voice no louder than every playing one, or when no world voice is playing (then the new
 * voice is dropped).
 */
export function pickVictim<V extends VoiceLike>(voices: readonly V[], incoming: VoiceLike): V | 'incoming' {
  let quietest: V | null = null;
  for (const v of voices) {
    if (v.group !== 'world') continue;
    if (quietest === null || v.loudness < quietest.loudness) quietest = v;
  }
  if (quietest === null) return 'incoming';
  if (incoming.group === 'world' && incoming.loudness <= quietest.loudness) return 'incoming';
  return quietest;
}

/*
 * Settings → Audio_System (design "음소거와 설정 적용", Req 37.4, 37.5): the current music and effects settings
 * are applied at once, and every later change of `musicOn` / `musicVolume` / `sfxOn` / `sfxVolume` (slider drags
 * included: each `set` notifies) moves only its own bus, within the engine's 0.05 s ramp.
 */

import type { Settings, SettingsListener } from '../settings/settings';
import type { AudioEngine } from './audioEngine';

export interface AudioSettingsSource {
  get(): Readonly<Settings>;
  subscribe(listener: SettingsListener): () => void;
}

/** Applies the audio settings now and on every change; returns the unsubscribe function. */
export function connectAudioSettings(settings: AudioSettingsSource, engine: Pick<AudioEngine, 'setMusic' | 'setSfx'>): () => void {
  const now = settings.get();
  engine.setMusic(now.musicOn, now.musicVolume);
  engine.setSfx(now.sfxOn, now.sfxVolume);
  return settings.subscribe((next, changed) => {
    if (changed.has('musicOn') || changed.has('musicVolume')) engine.setMusic(next.musicOn, next.musicVolume);
    if (changed.has('sfxOn') || changed.has('sfxVolume')) engine.setSfx(next.sfxOn, next.sfxVolume);
  });
}

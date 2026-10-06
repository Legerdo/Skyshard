/*
 * Music selection (design "선곡"·"전환", task 16.2, Req 37.3, 12.4, 5.4): which track should play now and how long
 * the crossfade to it takes. Priority: Victory (after 'boss:defeated') > the Caelith fight (its Phase's track) >
 * In_Combat (`mus_combat`, held 3 s after combat ends) > the current place: a Challenge_Area's own track, Thistlewick
 * (and the Title) `mus_title_village`, otherwise the Region's track, the crater before / after the Resonance_Altar.
 * Crossfades: entering combat 1.5 s; the boss, a Phase change and Victory 2 s; a place change and leaving combat 3 s.
 * Pure: no Web Audio.
 */

import type { ChallengeAreaId, RegionId } from '../data/ids';
import type { MusicTrackId } from '../data/music';

/** Seconds `mus_combat` keeps playing after In_Combat ends; combat resuming inside it changes nothing. */
export const COMBAT_HOLD_SECONDS = 3;

export const FADE_COMBAT_ENTER = 1.5;
export const FADE_BOSS = 2;
export const FADE_PLACE = 3;

export type MusicCategory = 'victory' | 'boss' | 'combat' | 'place';

export interface MusicSituation {
  /** The Title Screen is up (its world is Thistlewick). */
  readonly title: boolean;
  /** 'boss:defeated' was heard in this session: the ending and the Victory Screen. */
  readonly victory: boolean;
  /** The Caelith fight is on: its Phase's track; null otherwise. */
  readonly bossTrack: 'mus_boss_p1' | 'mus_boss_p2' | 'mus_boss_p3' | null;
  /** In_Combat (or an 'enemy:alerted' this frame), before the hold. */
  readonly inCombat: boolean;
  /** Region the Active_Character is in, null before the first entry. */
  readonly region: RegionId | null;
  /** The Challenge_Area the feet are inside, or null. */
  readonly challengeArea: ChallengeAreaId | null;
  /** Inside Thistlewick. */
  readonly village: boolean;
  /** GameState.altarActivated. */
  readonly altarActivated: boolean;
}

const REGION_TRACKS: Readonly<Record<RegionId, MusicTrackId>> = {
  verdant: 'mus_verdant',
  ember: 'mus_ember',
  azure: 'mus_azure',
  crater: 'mus_crater',
  sanctum: 'mus_sanctum',
};

/** The track of where the character is (no combat, boss or Victory). */
export function placeTrack(s: Pick<MusicSituation, 'title' | 'region' | 'challengeArea' | 'village' | 'altarActivated'>): MusicTrackId {
  if (s.title) return 'mus_title_village';
  if (s.challengeArea !== null) return `mus_area_${s.challengeArea}`;
  if (s.village) return 'mus_title_village';
  if (s.region === null) return 'mus_title_village';
  if (s.region === 'crater') return s.altarActivated ? 'mus_sanctum' : 'mus_crater';
  return REGION_TRACKS[s.region];
}

export interface MusicChoice {
  readonly track: MusicTrackId;
  readonly category: MusicCategory;
}

/** The track by priority; `combatActive` is In_Combat including its 3 s hold. */
export function selectMusic(s: MusicSituation, combatActive: boolean): MusicChoice {
  if (s.victory) return { track: 'mus_victory', category: 'victory' };
  if (s.bossTrack !== null) return { track: s.bossTrack, category: 'boss' };
  if (combatActive && !s.title) return { track: 'mus_combat', category: 'combat' };
  return { track: placeTrack(s), category: 'place' };
}

/** Crossfade length (s) from a track of category `from` (null: nothing playing) to one of `to`. */
export function crossfadeSeconds(from: MusicCategory | null, to: MusicCategory): number {
  if (to === 'victory' || to === 'boss') return FADE_BOSS;
  if (to === 'combat') return FADE_COMBAT_ENTER;
  return from === null ? FADE_BOSS : FADE_PLACE;
}

export interface MusicCue {
  readonly track: MusicTrackId;
  readonly fadeSec: number;
}

/** Follows the situation frame by frame and reports a cue whenever the target track changes. */
export class MusicDirector {
  private hold = 0;
  private current: MusicChoice | null = null;

  /** The track now asked for, or null before the first update. */
  get track(): MusicTrackId | null {
    return this.current?.track ?? null;
  }

  /** One frame of `dt` real seconds; returns the cue to play when the target changed, else null. */
  update(dt: number, s: MusicSituation): MusicCue | null {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (s.inCombat) this.hold = COMBAT_HOLD_SECONDS;
    else this.hold = Math.max(0, this.hold - step);
    const choice = selectMusic(s, s.inCombat || this.hold > 0);
    const previous = this.current;
    if (previous !== null && previous.track === choice.track) return null;
    this.current = choice;
    return { track: choice.track, fadeSec: crossfadeSeconds(previous?.category ?? null, choice.category) };
  }

  /** Forgets the target and the hold (a new session). */
  reset(): void {
    this.hold = 0;
    this.current = null;
  }
}

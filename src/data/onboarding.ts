/*
 * First 10 minutes (design "첫 10분 온보딩 흐름", task 21.4; Req 34.2, 34.6, 22.2, 22.3): the main path from the New
 * Game start through ms1 and ms2 up to the glide off the Breezewatch windmill, as a polyline of steps with the time
 * each one takes at Normal_Play pace, and the controls each step first needs. tests/unit/onboarding.test.ts adds the
 * steps up and checks that every control of Req 34.2 is first needed within 10 minutes and that its Tutorial_Hint
 * triggers there.
 *
 * Placement on this path: the village entrance (move, camera), the plaza step ledge (jump; src/data/village.ts
 * PLAZA_STEP), Isla's join at the watchtower (switch), the `village_raid` fight right after it (attack, the first
 * Telegraph → Dodge, Kairen's Ember Skill mark, then Isla's Tide for the steam burst), the Breezewatch cliff foot
 * (climb) and Wren's join on the windmill top (glide to the Elderbough).
 *
 * Pure data: no three.js, DOM or Math.random.
 */
import type { CharacterId, CinematicId, TutorialHintId } from './ids';
import { QUEST_SPOTS } from './quests';
import { TUTORIAL_ANCHORS } from './tutorials';
import { LOCATIONS, NEW_GAME_START } from './worldLayout';

/** The controls Req 34.2 needs within the first 10 minutes. */
export type OnboardingControl = 'move' | 'camera' | 'jump' | 'attack' | 'dodge' | 'switch' | 'skill' | 'reaction' | 'climb' | 'glide';

export const ONBOARDING_CONTROLS: readonly OnboardingControl[] = [
  'move', 'camera', 'jump', 'attack', 'dodge', 'switch', 'skill', 'reaction', 'climb', 'glide',
];

/** The Tutorial_Hint that teaches each control. */
export const ONBOARDING_HINTS: Readonly<Record<OnboardingControl, TutorialHintId>> = {
  move: 'tut_move', camera: 'tut_camera', jump: 'tut_jump', attack: 'tut_attack', dodge: 'tut_dodge', switch: 'tut_switch',
  skill: 'tut_skill', reaction: 'tut_reaction', climb: 'tut_climb', glide: 'tut_glide',
};

/** How a step is travelled from the previous step's point. */
export type OnboardingTravel = 'start' | 'run' | 'climb' | 'glide';

export interface OnboardingStep {
  readonly id: string;
  /** Where the step ends. */
  readonly at: { readonly x: number; readonly y: number; readonly z: number };
  readonly travel: OnboardingTravel;
  /** Seconds spent at the point: talk, fight, a jump over the ledge (the join cinematic is added from its data). */
  readonly dwell: number;
  /** Controls first needed on arriving at this point. */
  readonly needs: readonly OnboardingControl[];
  /** A companion joins here (its `cin_join_*` plays, then the switch hint). */
  readonly joins?: Exclude<CharacterId, 'kairen'>;
  /** The encounter group fought here. */
  readonly fight?: string;
  /** The Main_Quest objective this step completes, if any. */
  readonly objective?: string;
}

/** Normal_Play pace: a first-time player runs at the run speed but wanders; travel takes this much longer. */
export const NORMAL_PLAY_TRAVEL_FACTOR = 1.6;
/** Metres per second by travel mode (run 6 m/s, climb 2 m/s vertically, glide 9 m/s; Req 16.1, 18.2, 19.2). */
export const ONBOARDING_SPEEDS = { run: 6, climb: 2, glide: 9 } as const;
/** The Windmill's outer spiral stair from the top cliff tier (46 m) to the top (64 m): its walking length (m). */
export const WINDMILL_STAIR_LENGTH = 60;
/** The first ten minutes (s). */
export const ONBOARDING_LIMIT_SECONDS = 600;

const V = (p: { readonly x: number; readonly z: number }, y: number) => ({ x: p.x, y, z: p.z });
const VILLAGE_Y = LOCATIONS.thistlewick.groundY;

/** Centre of the `village_raid` Bramblekin in Hobb's east field (src/data/spawns.ts). */
export const VILLAGE_RAID_CENTER = { x: -212.25, y: VILLAGE_Y, z: 304 } as const;

/** The first-10-minute path, in play order. */
export const ONBOARDING_ROUTE: readonly OnboardingStep[] = [
  { id: 'start', at: V(NEW_GAME_START, NEW_GAME_START.groundY), travel: 'start', dwell: 3, needs: ['move', 'camera'] },
  { id: 'plaza_step', at: V(TUTORIAL_ANCHORS.plaza_step, VILLAGE_Y), travel: 'run', dwell: 4, needs: ['jump'] },
  { id: 'maren', at: QUEST_SPOTS.plaza, travel: 'run', dwell: 25, needs: [], objective: 'ms1_maren' },
  // Isla joins here (her switch hint shows after cin_join_isla); switching is first needed in the raid right after.
  { id: 'isla', at: QUEST_SPOTS.watchtower, travel: 'run', dwell: 20, needs: [], joins: 'isla', objective: 'ms1_isla' },
  {
    id: 'village_raid', at: VILLAGE_RAID_CENTER, travel: 'run', dwell: 45, needs: ['attack', 'dodge', 'switch', 'skill', 'reaction'],
    fight: 'village_raid', objective: 'ms1_raid',
  },
  { id: 'report', at: QUEST_SPOTS.plaza, travel: 'run', dwell: 15, needs: [], objective: 'ms1_report' },
  { id: 'breezewatch_field', at: V(TUTORIAL_ANCHORS.breezewatch_field, LOCATIONS.breezewatch.groundY), travel: 'run', dwell: 0, needs: [] },
  { id: 'cliff_foot', at: V(LOCATIONS.breezewatch, LOCATIONS.breezewatch.groundY), travel: 'run', dwell: 0, needs: ['climb'], objective: 'ms2_breezewatch' },
  {
    id: 'windmill_top', at: V(LOCATIONS.vista_verdant, LOCATIONS.vista_verdant.groundY), travel: 'climb', dwell: 20, needs: ['glide'],
    joins: 'wren', objective: 'ms2_wren',
  },
];

/** The join cinematic of a companion. */
export const joinCinematicId = (character: Exclude<CharacterId, 'kairen'>): CinematicId => `cin_join_${character}` as CinematicId;

/** The cliff tiers' top below the Windmill stair (m): climbed from the cliff foot, then the stair to the top. */
export const BREEZEWATCH_CLIFF_TOP_Y = 46;

/**
 * Seconds to travel to `step` from `prev` at Normal_Play pace: run the horizontal distance; for `climb`, climb the
 * cliff tiers to BREEZEWATCH_CLIFF_TOP_Y and walk the Windmill stair; for `glide`, glide the horizontal distance.
 */
export function travelSeconds(prev: OnboardingStep, step: OnboardingStep): number {
  const horizontal = Math.hypot(step.at.x - prev.at.x, step.at.z - prev.at.z);
  switch (step.travel) {
    case 'start':
      return 0;
    case 'run':
      return (horizontal / ONBOARDING_SPEEDS.run) * NORMAL_PLAY_TRAVEL_FACTOR;
    case 'climb': {
      const cliff = Math.max(0, BREEZEWATCH_CLIFF_TOP_Y - prev.at.y);
      return ((cliff / ONBOARDING_SPEEDS.climb) + (WINDMILL_STAIR_LENGTH + horizontal) / ONBOARDING_SPEEDS.run) * NORMAL_PLAY_TRAVEL_FACTOR;
    }
    case 'glide':
      return horizontal / ONBOARDING_SPEEDS.glide;
  }
}

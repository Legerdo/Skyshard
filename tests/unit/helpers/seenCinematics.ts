import { CINEMATIC_IDS } from '../../../src/data/cinematics';
import type { GameState } from '../../../src/logic/save/gameState';

/**
 * Task 21.2: a mid-game fixture has seen the contextual cinematics of the way there (Landmarks, Challenge_Area entries,
 * companion joins); marking them seen keeps their 3–6 s input holds out of tests about something else. Story
 * cinematics (Skyshards, altar, Caelith, ending) are left alone.
 */
export function seeContextCinematics(gs: GameState): void {
  for (const id of CINEMATIC_IDS) {
    if (/^cin_(landmark|area|join)_/.test(id) && !gs.cinematicsSeen.includes(id)) gs.cinematicsSeen.push(id);
  }
}

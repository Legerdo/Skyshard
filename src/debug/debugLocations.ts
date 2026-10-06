// Debug_Tools "지점 이동" destinations (design "Debug_Tools": Thistlewick, every Waystone and Landmark, the
// Challenge_Area entrances), as (x, z) on the ground; the teleport finds the walkable height there. Pure data.

import { CHALLENGE_AREA_IDS, CHALLENGE_AREA_NAMES, LANDMARK_IDS, LANDMARK_NAMES, WAYSTONE_IDS, type LandmarkId } from '../data/ids';
import { WAYSTONES } from '../data/waystones';
import { CHALLENGE_ENTRANCES, LOCATIONS, THISTLEWICK_HEARTH, type XZ } from '../data/worldLayout';

export interface DebugLocation {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
}

/** Standing ground beside each Landmark (not inside the tree, under the arch or in the dome). */
const LANDMARK_SPOTS: Readonly<Record<LandmarkId, XZ>> = {
  lm_elderbough: { x: -240, z: 176 },
  lm_breezewatch: LOCATIONS.breezewatch,
  lm_waterfall: { x: -380, z: 232 },
  lm_cinderspire: LOCATIONS.cinderspire_base,
  lm_observatory: LOCATIONS.observatory_entrance,
  lm_floating_isles: LOCATIONS.lm_floating_isles,
  lm_arch_azure: { x: -60, z: -238 },
  lm_astral_sanctum: LOCATIONS.sanctum_hall,
};

export const DEBUG_LOCATIONS: readonly DebugLocation[] = [
  { id: 'thistlewick', label: 'Thistlewick', x: THISTLEWICK_HEARTH.x, z: THISTLEWICK_HEARTH.z + 4 },
  ...WAYSTONE_IDS.map((id) => ({ id, label: `Waystone · ${WAYSTONES[id].name}`, x: WAYSTONES[id].spot.x, z: WAYSTONES[id].spot.z })),
  ...LANDMARK_IDS.map((id) => ({ id, label: `Landmark · ${LANDMARK_NAMES[id]}`, x: LANDMARK_SPOTS[id].x, z: LANDMARK_SPOTS[id].z })),
  ...CHALLENGE_AREA_IDS.map((id) => {
    const at = LOCATIONS[CHALLENGE_ENTRANCES[id]];
    return { id: `area_${id}`, label: `입구 · ${CHALLENGE_AREA_NAMES[id]}`, x: at.x, z: at.z };
  }),
];

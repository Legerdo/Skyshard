/*
 * Region identities (design "World Layout Master Table" 지형 성격, "Rendering·Art" 팔레트, task 20.4; Req 8.2): what makes
 * each main Region its own place, as nine comparable aspects. The data test (tests/unit/regions.test.ts) compares every
 * pair of main Regions aspect by aspect and needs six or more to differ.
 * - terrain: the ground's shape and its height band (the layout table's 지형 성격);
 * - palette: sky, ground and accent colours (0xRRGGBB) the art tasks tint the Region with;
 * - vegetation, architecture: what grows and what was built there;
 * - enemies: the enemy kinds placed there (from the spawner data, src/data/spawns.ts);
 * - movement: the traversal the Region asks for; hazards: what hurts or blocks there;
 * - music: the Region's exploration track (`mus_` key for the Audio_System);
 * - landmarks: its Landmarks (from the discovery radii, src/data/volumes.ts).
 * Pure data: no three.js, DOM or Math.random.
 */
import type { EnemyId, LandmarkId, MusicId, RegionId } from './ids';
import { isEnemyId } from './ids';
import { SPAWNERS } from './spawns';
import { DISCOVERY_VOLUMES } from './volumes';

export const REGION_ASPECTS = [
  'terrain', 'palette', 'vegetation', 'architecture', 'enemies', 'movement', 'hazards', 'music', 'landmarks',
] as const;
export type RegionAspect = (typeof REGION_ASPECTS)[number];

export interface RegionProfile {
  readonly terrain: { readonly shape: string; readonly minY: number; readonly maxY: number };
  readonly palette: { readonly sky: number; readonly ground: number; readonly accent: number };
  readonly vegetation: readonly string[];
  readonly architecture: readonly string[];
  readonly enemies: readonly EnemyId[];
  readonly movement: readonly string[];
  readonly hazards: readonly string[];
  readonly music: MusicId;
  readonly landmarks: readonly LandmarkId[];
}

/** Enemy kinds of a Region's spawners (camps, groups and lone ones), sorted. */
function enemiesOf(region: RegionId): EnemyId[] {
  const kinds = new Set<EnemyId>();
  for (const s of SPAWNERS) if (s.region === region && isEnemyId(s.kind)) kinds.add(s.kind);
  return [...kinds].sort();
}

/** Landmarks whose discovery radius belongs to the Region. */
function landmarksOf(region: RegionId): LandmarkId[] {
  return DISCOVERY_VOLUMES.filter((v) => v.region === region).map((v) => v.id);
}

export type MainRegionId = 'verdant' | 'ember' | 'azure';
export const MAIN_REGION_IDS: readonly MainRegionId[] = ['verdant', 'ember', 'azure'];

export const REGION_PROFILES: Readonly<Record<MainRegionId, RegionProfile>> = {
  verdant: {
    terrain: { shape: 'rollingHills', minY: 8, maxY: 40 },
    palette: { sky: 0xa8dcff, ground: 0x7cbf5a, accent: 0xf4d35e },
    vegetation: ['meadowGrass', 'broadleafTrees', 'wildflowers', 'giantOldTree'],
    architecture: ['timberCottages', 'windmill', 'stoneRuins'],
    enemies: enemiesOf('verdant'),
    movement: ['cliffClimb', 'hillGlide', 'pondSwim'],
    hazards: ['thornBrambles', 'sporeClouds'],
    music: 'mus_verdant',
    landmarks: landmarksOf('verdant'),
  },
  ember: {
    terrain: { shape: 'canyonAndMesa', minY: 0, maxY: 75 },
    palette: { sky: 0xffc59a, ground: 0x8a4a36, accent: 0xff5a1f },
    vegetation: ['ashScrub', 'emberBlooms', 'redCrystalClusters'],
    architecture: ['minersCamp', 'forgeRuins', 'brokenBridge'],
    enemies: enemiesOf('ember'),
    movement: ['canyonUpdraft', 'spireClimb', 'mesaClimb'],
    hazards: ['lava', 'heatCrystal', 'unstableCrystal'],
    music: 'mus_ember',
    landmarks: landmarksOf('ember'),
  },
  azure: {
    terrain: { shape: 'highPlateauAndPeaks', minY: 60, maxY: 180 },
    palette: { sky: 0x6fa8ff, ground: 0xb8d8e8, accent: 0xe8f4ff },
    vegetation: ['alpineGrass', 'snowPines', 'skyMoss'],
    architecture: ['starObservatory', 'beaconRuins', 'floatingRuins'],
    enemies: enemiesOf('azure'),
    movement: ['windZoneGlide', 'isleUpdraft', 'skyRings'],
    hazards: ['cliffFalls', 'strongWind'],
    music: 'mus_azure',
    landmarks: landmarksOf('azure'),
  },
};

/** Whether two values of one aspect are equal (arrays as sets, objects field by field). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = new Set(a.map(String));
    const sb = new Set(b.map(String));
    return sa.size === sb.size && [...sa].every((x) => sb.has(x));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.join() === kb.join() && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** The aspects in which two Region profiles differ. */
export function differingAspects(a: RegionProfile, b: RegionProfile): RegionAspect[] {
  return REGION_ASPECTS.filter((k) => !sameValue(a[k], b[k]));
}

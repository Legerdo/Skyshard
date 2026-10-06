/*
 * What the map screen draws (design "지도 (Map_System)", Req 33.1, 33.2, 33.5, 9.5, 3.6, 11.2, 15.4), from the
 * read-only GameState and the current Objectives only:
 * - the discovered Regions' names, and Thistlewick always;
 * - Landmarks: discovered ones with their name label, ones a Vista marked (`map_<id>` flag) as a plain icon;
 * - Waystones: active ones (fast-travel buttons) and inactive ones a Vista marked (not a destination, Req 11.2);
 * - POIs: discovered ones only, even over revealed cells (Req 33.2);
 * - the Main_Quest Objective as an `exact` marker or a search circle of radius ≥ 60 m (Req 3.6), and the tracked
 *   Side_Quest's the same way in its own colour (Req 15.4);
 * - per Region the Chest and Echo_Tablet counts found / total (Req 33.5).
 * Positions are map pixels (src/map/mapCoords). Pure: no DOM.
 */
import {
  LANDMARK_NAMES, REGION_IDS, REGION_NAMES, isLandmarkId, isRegionId, type LandmarkId, type RegionId, type WaystoneId,
} from '../data/ids';
import { mapMarkFlag } from '../data/vistas';
import { DISCOVERY_VOLUMES } from '../data/volumes';
import { WAYSTONE_LIST } from '../data/waystones';
import { LOCATIONS } from '../data/worldLayout';
import type { ObjectiveMarker } from '../logic/quest/types';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { MAP_CONTENT, type MapContent } from './mapContent';
import { metersToPx, worldToMap } from './mapCoords';

/** Smallest search circle drawn for a `zone` Objective (m, Req 3.6). */
export const MAP_ZONE_MIN_RADIUS = 60;
/** Village label on the map (always shown). */
export const THISTLEWICK_LABEL = 'Thistlewick';

/** Where each Region's name is written (world x, z): inside the Region, clear of the main places. */
export const REGION_LABEL_AT: Readonly<Record<RegionId, { readonly x: number; readonly z: number }>> = {
  verdant: { x: -300, z: 400 },
  ember: { x: 300, z: 330 },
  azure: { x: -180, z: -200 },
  crater: { x: 45, z: 75 },
  sanctum: { x: 0, z: -58 },
};

/** Landmark icon points: the centres of their discovery radii (src/data/volumes.ts). */
export const LANDMARK_POINTS: Readonly<Record<LandmarkId, { readonly x: number; readonly z: number }>> = Object.fromEntries(
  DISCOVERY_VOLUMES.map((v) => [v.id, { x: v.shape.x, z: v.shape.z }]),
) as Record<LandmarkId, { x: number; z: number }>;

export interface MapLabel {
  readonly id: string;
  readonly name: string;
  readonly px: number;
  readonly py: number;
}

export interface MapLandmarkMarker extends MapLabel {
  readonly id: LandmarkId;
  /** Discovered (name label shown); false: only marked by a Vista. */
  readonly discovered: boolean;
}

export interface MapWaystoneMarker extends MapLabel {
  readonly id: WaystoneId;
  /** Active: a fast-travel destination. Inactive markers come from a Vista and cannot be chosen (Req 11.2). */
  readonly active: boolean;
}

export interface MapPoiMarker extends MapLabel {
  readonly kind: string;
}

export interface MapObjectiveMarker {
  readonly quest: 'main' | 'side';
  readonly text: string;
  readonly kind: 'exact' | 'zone';
  readonly px: number;
  readonly py: number;
  /** Search circle radius (map px) for `zone`, 0 for `exact`. */
  readonly radiusPx: number;
}

export interface MapRegionCount {
  readonly region: RegionId;
  readonly name: string;
  readonly discovered: boolean;
  readonly chests: { readonly found: number; readonly total: number };
  readonly tablets: { readonly found: number; readonly total: number };
}

export interface MapModel {
  readonly regions: readonly MapLabel[];
  readonly village: MapLabel;
  readonly landmarks: readonly MapLandmarkMarker[];
  readonly waystones: readonly MapWaystoneMarker[];
  readonly pois: readonly MapPoiMarker[];
  readonly objectives: readonly MapObjectiveMarker[];
  readonly counts: readonly MapRegionCount[];
}

/** The Objective markers the map draws: the tracked quest's and the Main_Quest's (each at most once). */
export interface MapObjectives {
  readonly main: { readonly text: string; readonly marker: ObjectiveMarker } | null;
  readonly side: { readonly text: string; readonly marker: ObjectiveMarker } | null;
}

const at = (x: number, z: number): { px: number; py: number } => {
  const p = worldToMap(x, z);
  return { px: p.px, py: p.py };
};

function objectiveMarker(quest: 'main' | 'side', o: MapObjectives['main']): MapObjectiveMarker | null {
  if (o === null) return null;
  const m = o.marker;
  if (m.kind === 'exact') return { quest, text: o.text, kind: 'exact', ...at(m.pos.x, m.pos.z), radiusPx: 0 };
  if (m.kind === 'zone') {
    return { quest, text: o.text, kind: 'zone', ...at(m.center.x, m.center.z), radiusPx: metersToPx(Math.max(MAP_ZONE_MIN_RADIUS, m.radius)) };
  }
  return null;
}

/** Region of a `chest_<region>_<n>` / `tab_<region>_<n>` id, or null. */
export function regionOfPlacedId(id: string): RegionId | null {
  const region = id.split('_')[1];
  return isRegionId(region) ? region : null;
}

function counted(found: readonly string[], all: readonly { id: string; region: RegionId }[], region: RegionId): { found: number; total: number } {
  const ids = new Set(all.filter((d) => d.region === region).map((d) => d.id));
  // Without a placement table the id prefix still tells the Region of what was found.
  const mine = found.filter((id) => (ids.size > 0 ? ids.has(id) : regionOfPlacedId(id) === region));
  return { found: new Set(mine).size, total: ids.size };
}

/** The map for the current state. */
export function mapModel(state: DeepReadonly<GameState>, objectives: MapObjectives, content: MapContent = MAP_CONTENT): MapModel {
  const { discovery, world } = state;
  const flags = world.flags;
  const discoveredRegions = new Set<string>(discovery.regions);

  const regions: MapLabel[] = REGION_IDS.filter((id) => discoveredRegions.has(id)).map((id) => ({
    id, name: REGION_NAMES[id], ...at(REGION_LABEL_AT[id].x, REGION_LABEL_AT[id].z),
  }));
  const village: MapLabel = { id: 'thistlewick', name: THISTLEWICK_LABEL, ...at(LOCATIONS.thistlewick.x, LOCATIONS.thistlewick.z) };

  const found = new Set<string>(discovery.landmarks);
  const landmarks: MapLandmarkMarker[] = [];
  for (const [id, p] of Object.entries(LANDMARK_POINTS)) {
    if (!isLandmarkId(id)) continue;
    const discovered = found.has(id);
    if (!discovered && flags[mapMarkFlag(id)] !== true) continue;
    landmarks.push({ id, name: LANDMARK_NAMES[id], discovered, ...at(p.x, p.z) });
  }

  const active = new Set<string>(world.waystones);
  const waystones: MapWaystoneMarker[] = [];
  for (const w of WAYSTONE_LIST) {
    const isActive = active.has(w.id);
    if (!isActive && flags[mapMarkFlag(w.id)] !== true) continue;
    waystones.push({ id: w.id, name: w.name, active: isActive, ...at(w.x, w.z) });
  }

  // Hidden places are recorded apart from the other POIs (Req 9.6: on the map from their first entry).
  const seenPois = new Set<string>([...discovery.pois, ...discovery.hiddenPlaces]);
  const pois: MapPoiMarker[] = content.pois
    .filter((p) => seenPois.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, kind: p.kind, ...at(p.x, p.z) }));

  const objectiveMarkers = [objectiveMarker('side', objectives.side), objectiveMarker('main', objectives.main)]
    .filter((m): m is MapObjectiveMarker => m !== null);

  const counts: MapRegionCount[] = REGION_IDS.map((region) => ({
    region,
    name: REGION_NAMES[region],
    discovered: discoveredRegions.has(region),
    chests: counted(world.chests, content.chests, region),
    tablets: counted(world.echoTablets, content.tablets, region),
  }));

  return { regions, village, landmarks, waystones, pois, objectives: objectiveMarkers, counts };
}

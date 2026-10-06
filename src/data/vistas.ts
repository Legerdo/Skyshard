/*
 * Vista_Points (design "지도 (Map_System)" Vista 공개, Req 9.5): the three high look-outs whose arrival reveals the map
 * fog within 200 m and marks the Waystones and Landmarks inside that radius on the map (a marked Waystone is still no
 * fast-travel destination before its activation, Req 11.2). Positions are the key location table's
 * (src/data/worldLayout.ts): the Breezewatch windmill top, the Ember mesa top and the Azure peak shoulder.
 *
 * `arrival` is the trigger the World judges the Active_Character's feet against (src/world/fogSystem.ts): a vertical
 * cylinder around the stand point. The POI data (task 12.x) imports these as its Vista POIs.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */
import type { RegionId } from './ids';
import { LOCATIONS, type XZ } from './worldLayout';

export const VISTA_IDS = ['vista_verdant', 'vista_ember', 'vista_azure'] as const;
export type VistaId = (typeof VISTA_IDS)[number];

/** Map fog radius a Vista reveals around its stand point (m, Req 9.5). */
export const VISTA_REVEAL_RADIUS = 200;

export interface VistaDef {
  readonly id: VistaId;
  readonly region: RegionId;
  /** Stand point: (x, z) and the walkable surface height there. */
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  /** Arrival trigger: feet within `radius` m horizontally and between `minY` and `maxY`. */
  readonly arrival: { readonly radius: number; readonly minY: number; readonly maxY: number };
  /** Korean display name for the map and the POI list. */
  readonly name: string;
}

function vista(id: VistaId, radius: number, name: string): VistaDef {
  const loc = LOCATIONS[id];
  return {
    id, region: loc.region, x: loc.x, z: loc.z, groundY: loc.groundY, name,
    // A little below the surface (float slack, a stair step) up to a short jump above it.
    arrival: { radius, minY: loc.groundY - 2, maxY: loc.groundY + 8 },
  };
}

export const VISTAS: Readonly<Record<VistaId, VistaDef>> = {
  // Windmill top platform (6 × 6 m, the vista_verdant area r 5).
  vista_verdant: vista('vista_verdant', 5, 'Breezewatch 풍차 꼭대기'),
  // The mesa top is levelled to y 70 within 25 m.
  vista_ember: vista('vista_ember', 8, '메사 전망대'),
  // Shoulder pad of the Azure peak (flat radius 4).
  vista_azure: vista('vista_azure', 5, '고원 봉우리 전망대'),
};

export const VISTA_LIST: readonly VistaDef[] = VISTA_IDS.map((id) => VISTAS[id]);

/** Whether feet at (x, y, z) stand on the Vista's arrival spot. */
export function atVista(def: VistaDef, x: number, y: number, z: number): boolean {
  const { radius, minY, maxY } = def.arrival;
  return y >= minY && y <= maxY && Math.hypot(x - def.x, z - def.z) <= radius;
}

/** Whether a point lies within the Vista's reveal radius (horizontal). */
export function withinVista(def: VistaDef, p: XZ): boolean {
  return Math.hypot(p.x - def.x, p.z - def.z) <= VISTA_REVEAL_RADIUS;
}

/**
 * `GameState.world.flags` key recording that a Vista marked a Waystone or Landmark (by id) on the map. The World sets
 * it on the Vista's arrival; the map shows the place's position from then on (a marked Waystone stays unusable for
 * fast travel until activated).
 */
export function mapMarkFlag(id: string): string {
  return `map_${id}`;
}

/** `GameState.world.flags` key recording that the Active_Character stood on the Vista (its reveal ran). */
export function vistaReachedFlag(id: VistaId): string {
  return `reached_${id}`;
}

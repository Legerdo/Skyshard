/*
 * What the map lists besides the fixed layout (design "지도 (Map_System)", Req 33.1, 33.2, 33.5, 9.6): the placed POIs
 * (shown only once discovered: `GameState.discovery.pois`, hidden places `discovery.hiddenPlaces`) and the Chest /
 * Echo_Tablet placements the per-Region "found / total" counts are taken over. All of it comes from the POI tables of
 * src/data/pois.ts (tasks 12.7, 20.1): the map-registered kinds (MAP_POI_KINDS) and the hidden places, every Chest
 * and every Echo_Tablet with its Region.
 * Pure data: no DOM.
 */
import type { RegionId } from '../data/ids';
import { CHESTS, ECHO_TABLETS, HIDDEN_PLACES, MAP_POI_KINDS, POIS } from '../data/pois';

/** A point of interest the map can show (after its discovery). */
export interface MapPoiDef {
  readonly id: string;
  /** POI kind (e.g. 'vista', 'hidden', 'tablet', 'lore', 'camp', 'chest'); picks the icon. */
  readonly kind: string;
  readonly region: RegionId;
  readonly x: number;
  readonly z: number;
  /** Korean display name, or '' for none. */
  readonly name: string;
}

/** A placed collectible counted per Region. */
export interface MapCountedDef {
  readonly id: string;
  readonly region: RegionId;
}

export interface MapContent {
  readonly pois: readonly MapPoiDef[];
  readonly chests: readonly MapCountedDef[];
  readonly tablets: readonly MapCountedDef[];
}

/** The world's map content: map POIs and hidden places, and the per-Region Chest / Echo_Tablet placements. */
export const MAP_CONTENT: MapContent = {
  pois: [
    ...POIS.filter((p) => MAP_POI_KINDS.has(p.kind)).map((p): MapPoiDef => ({
      id: p.id, kind: p.kind, region: p.region, x: p.pos.x, z: p.pos.z, name: p.name,
    })),
    ...HIDDEN_PLACES.map((h): MapPoiDef => ({ id: h.id, kind: 'hidden', region: h.region, x: h.pos.x, z: h.pos.z, name: h.name })),
  ],
  chests: CHESTS.map((c) => ({ id: c.id, region: c.region })),
  tablets: ECHO_TABLETS.map((t) => ({ id: t.id, region: t.region })),
};

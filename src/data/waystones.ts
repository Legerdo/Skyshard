/*
 * Waystones (design "지도 (Map_System)" 빠른 이동, Data Models `WaystoneDef`; Req 11.1–11.5): the six fast-travel,
 * healing and respawn points. Positions are the key location table's (src/data/worldLayout.ts); each ground Waystone
 * sits on a flat pad of radius 4 (src/world/terrain/features.ts), so its `spot` 2 m in front of the stone is on the
 * pad's ground height. ws_sanctum stands in the Astral Sanctum's connecting hall: its stone is a Sanctum piece and
 * its spot is the Sanctum's "Waystone으로 돌아가기" spot (src/data/sanctum.ts).
 *
 * `front` is the way the stone faces (toward the village plaza, the old tree, the miners' camp, the plateau road,
 * the crater's altar, the Caelith arena); the spot faces the same way, so the camera looks out after fast travel.
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */
import { yawFromDir } from '../core/math';
import { WAYSTONE_IDS, WAYSTONE_NAMES, type RegionId, type WaystoneId } from './ids';
import { SANCTUM } from './sanctum';
import { LOCATIONS, type SpotDef, type XZ } from './worldLayout';

/** Distance of the arrival / respawn spot in front of the stone (m, Req 11.4). */
export const WAYSTONE_SPOT_DISTANCE = 2;
/** The stone: a standing cylinder (the same size as the Sanctum's). */
export const WAYSTONE_STONE = { radius: 0.55, height: 2.6 } as const;

export interface WaystoneDef {
  readonly id: WaystoneId;
  readonly region: RegionId;
  /** Display name (proper noun, Req 35.4). */
  readonly name: string;
  /** Foot of the stone: (x, z) and the walkable surface height. */
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  /** Horizontal unit direction the stone faces. */
  readonly front: XZ;
  /** Where fast travel and a respawn put the Active_Character: 2 m in front, facing `front`. */
  readonly spot: SpotDef;
  /** The stone's collider is a Sanctum piece (placed by src/world/sanctum.ts), not the Waystone system's. */
  readonly sanctumPiece: boolean;
}

function unit(x: number, z: number): XZ {
  const len = Math.hypot(x, z);
  return { x: x / len, z: z / len };
}

/** A ground Waystone at its layout location, facing toward `toward`. */
function ground(id: Exclude<WaystoneId, 'ws_sanctum'>, toward: XZ): WaystoneDef {
  const loc = LOCATIONS[id];
  const front = unit(toward.x - loc.x, toward.z - loc.z);
  return {
    id, region: loc.region, name: WAYSTONE_NAMES[id], x: loc.x, z: loc.z, groundY: loc.groundY, front,
    spot: {
      x: loc.x + front.x * WAYSTONE_SPOT_DISTANCE,
      z: loc.z + front.z * WAYSTONE_SPOT_DISTANCE,
      groundY: loc.groundY,
      yaw: yawFromDir(front.x, front.z),
    },
    sanctumPiece: false,
  };
}

function sanctum(): WaystoneDef {
  const w = SANCTUM.waystone;
  const s = w.spot;
  return {
    id: 'ws_sanctum', region: LOCATIONS.ws_sanctum.region, name: WAYSTONE_NAMES.ws_sanctum,
    x: w.pos.x, z: w.pos.z, groundY: w.pos.y,
    front: unit(s.pos.x - w.pos.x, s.pos.z - w.pos.z),
    spot: { x: s.pos.x, z: s.pos.z, groundY: s.pos.y, yaw: s.yaw },
    sanctumPiece: true,
  };
}

export const WAYSTONES: Readonly<Record<WaystoneId, WaystoneDef>> = {
  ws_thistlewick: ground('ws_thistlewick', LOCATIONS.thistlewick), // toward the plaza
  ws_elderbough: ground('ws_elderbough', LOCATIONS.lm_elderbough), // toward the old tree
  ws_ember: ground('ws_ember', LOCATIONS.camp_durga), // toward the miners' camp
  ws_azure: ground('ws_azure', LOCATIONS.gate_azure), // down the plateau road
  ws_crater: ground('ws_crater', LOCATIONS.resonance_altar), // toward the altar
  ws_sanctum: sanctum(), // toward the Caelith arena
};

/** The six Waystones in registry order. */
export const WAYSTONE_LIST: readonly WaystoneDef[] = WAYSTONE_IDS.map((id) => WAYSTONES[id]);

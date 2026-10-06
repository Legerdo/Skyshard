/*
 * Progress barriers (design.md "진행 게이트", "진행 게이트 요약"; Req 4.5, 4.6, 4.9, 5.2, 2.7).
 *
 * - gate_ember (60, 300) / gate_azure (40, −125): Blight crystal walls across Ashgate Pass and the pass
 *   north of the crater. While closed they show "Skyshard n/필요 수" to a character in front (Req 4.9).
 * - veil_ember / veil_azure: the Blight veil along the whole border of the locked Region. Each veil is
 *   polyline runs whose far ends lie beyond the 490 m recovery radius, with the gap left for its gate;
 *   a lintel closes the gap above the gate wall up to the veil top, so neither climbing nor gliding
 *   gets past (walls are not climbable). A veil opens together with its gate.
 * - seal_sanctum: the r 70 seal sphere around the Astral Sanctum, lifted once the Resonance_Altar is
 *   activated with all three Skyshards; the Starlit_Stair appears in its place (Req 5.5).
 *
 * Whether a barrier is open is derived from GameState (Skyshard count, altar flag) every time
 * (src/logic/gates.ts), so a load restores the same barriers (Req 2.7).
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import type { Vec3 } from '../core/types';
import type { BarrierId, RegionId } from './ids';
import type { XZ } from './worldLayout';

/** What opens a barrier: at least `skyshards` Skyshards and, when `altar` is set, the activated altar. */
export interface BarrierRequirement {
  readonly skyshards: 0 | 1 | 2 | 3;
  readonly altar: boolean;
}

interface BarrierBase {
  readonly id: BarrierId;
  /** The Region the barrier keeps locked; it counts as entered only once its barriers are open. */
  readonly region: RegionId;
  readonly requires: BarrierRequirement;
  /** Display name (prompt, map). */
  readonly name: string;
}

/** A straight wall across a pass, `span` from `a` to `b` along its length. */
export interface GateDef extends BarrierBase {
  readonly kind: 'gate';
  readonly span: { readonly a: XZ; readonly b: XZ };
  /** Wall thickness (m). */
  readonly thickness: number;
  /** Bottom (sunk into the ground) and top of the wall. */
  readonly bottomY: number;
  readonly topY: number;
  /** Ground height in front of the wall, where the prompt is offered. */
  readonly groundY: number;
}

/** A tall veil: one wall per polyline segment, plus lintels over the gate gaps. */
export interface VeilDef extends BarrierBase {
  readonly kind: 'veil';
  /** The gate that fills this veil's gap and opens with it. */
  readonly gate: BarrierId;
  readonly runs: readonly (readonly XZ[])[];
  /** Pieces over a gap: from `bottomY` (the gate top) to the veil top. */
  readonly lintels: readonly { readonly a: XZ; readonly b: XZ; readonly bottomY: number }[];
  readonly thickness: number;
  readonly bottomY: number;
  readonly topY: number;
}

/** A solid sphere around a floating Region. */
export interface SealDef extends BarrierBase {
  readonly kind: 'seal';
  readonly center: Vec3;
  readonly radius: number;
}

export type BarrierDef = GateDef | VeilDef | SealDef;
export type BarrierKind = BarrierDef['kind'];

/** Veils reach from below the lowest terrain to 260 m (design "진행 게이트 요약"). */
export const VEIL_BOTTOM_Y = -40;
export const VEIL_TOP_Y = 260;
const VEIL_THICKNESS = 2;
const GATE_THICKNESS = 2;

/** Point on the circle of `radius` around the origin at `deg` degrees from +x toward +z (south). */
const onCircle = (radius: number, deg: number): XZ => ({
  x: Math.round(radius * Math.cos((deg * Math.PI) / 180) * 100) / 100,
  z: Math.round(radius * Math.sin((deg * Math.PI) / 180) * 100) / 100,
});

/** Radius of the ember veil's arc around the crater's east side, just outside the crater (r 110). */
const EMBER_VEIL_ARC_RADIUS = 112;

const GATE_EMBER: GateDef = {
  id: 'gate_ember', kind: 'gate', region: 'ember', requires: { skyshards: 1, altar: false }, name: 'Blight Barrier',
  // North–south across Ashgate Pass at x 60 (the canyon runs east from here); ground y 20.
  span: { a: { x: 60, z: 288 }, b: { x: 60, z: 312 } },
  thickness: GATE_THICKNESS, bottomY: 14, topY: 34, groundY: 20,
};

const GATE_AZURE: GateDef = {
  id: 'gate_azure', kind: 'gate', region: 'azure', requires: { skyshards: 2, altar: false }, name: 'Blight Barrier',
  // West–east across the pass at z −125, north of the crater rim; ground y 26 on the plateau ramp.
  span: { a: { x: 28, z: -125 }, b: { x: 52, z: -125 } },
  thickness: GATE_THICKNESS, bottomY: 18, topY: 40, groundY: 26,
};

const VEIL_EMBER: VeilDef = {
  id: 'veil_ember', kind: 'veil', region: 'ember', requires: GATE_EMBER.requires, name: 'Blight Veil', gate: 'gate_ember',
  runs: [
    // South of the gate along x 60 to beyond the world edge.
    [{ x: 60, z: 505 }, GATE_EMBER.span.b],
    // North of the gate along x 60, around the crater's east side, then east along ember's north edge.
    [
      GATE_EMBER.span.a,
      { x: 60, z: 94.62 },
      onCircle(EMBER_VEIL_ARC_RADIUS, 40),
      onCircle(EMBER_VEIL_ARC_RADIUS, 20),
      onCircle(EMBER_VEIL_ARC_RADIUS, 0),
      onCircle(EMBER_VEIL_ARC_RADIUS, -20),
      onCircle(EMBER_VEIL_ARC_RADIUS, -33),
      onCircle(EMBER_VEIL_ARC_RADIUS, -45),
      { x: 505, z: -80 },
    ],
  ],
  lintels: [{ a: GATE_EMBER.span.a, b: GATE_EMBER.span.b, bottomY: GATE_EMBER.topY }],
  thickness: VEIL_THICKNESS, bottomY: VEIL_BOTTOM_Y, topY: VEIL_TOP_Y,
};

const VEIL_AZURE: VeilDef = {
  id: 'veil_azure', kind: 'veil', region: 'azure', requires: GATE_AZURE.requires, name: 'Blight Veil', gate: 'gate_azure',
  // Along z −125 from edge to edge; every Azure Highlands location lies north of it.
  runs: [
    [{ x: -505, z: -125 }, GATE_AZURE.span.a],
    [GATE_AZURE.span.b, { x: 505, z: -125 }],
  ],
  lintels: [{ a: GATE_AZURE.span.a, b: GATE_AZURE.span.b, bottomY: GATE_AZURE.topY }],
  thickness: VEIL_THICKNESS, bottomY: VEIL_BOTTOM_Y, topY: VEIL_TOP_Y,
};

const SEAL_SANCTUM: SealDef = {
  id: 'seal_sanctum', kind: 'seal', region: 'sanctum', requires: { skyshards: 3, altar: true }, name: 'Astral Seal',
  // Around the floating island (r 55, y 170–215): bottom y 122, top y 262.
  center: { x: 0, y: 192, z: 0 },
  radius: 70,
};

/** Every barrier, in registry order. */
export const BARRIERS: Readonly<Record<BarrierId, BarrierDef>> = {
  gate_ember: GATE_EMBER,
  gate_azure: GATE_AZURE,
  veil_ember: VEIL_EMBER,
  veil_azure: VEIL_AZURE,
  seal_sanctum: SEAL_SANCTUM,
};

/** One straight wall piece of a gate or veil: from `a` to `b`, `thickness` wide, bottomY..topY high. */
export interface WallPiece {
  readonly a: XZ;
  readonly b: XZ;
  readonly thickness: number;
  readonly bottomY: number;
  readonly topY: number;
}

/** The wall pieces a gate or veil is built from (a seal has none). */
export function wallPieces(def: BarrierDef): WallPiece[] {
  switch (def.kind) {
    case 'gate':
      return [{ a: def.span.a, b: def.span.b, thickness: def.thickness, bottomY: def.bottomY, topY: def.topY }];
    case 'veil': {
      const out: WallPiece[] = [];
      for (const run of def.runs) {
        for (let i = 1; i < run.length; i++) {
          out.push({ a: run[i - 1], b: run[i], thickness: def.thickness, bottomY: def.bottomY, topY: def.topY });
        }
      }
      for (const l of def.lintels) out.push({ a: l.a, b: l.b, thickness: def.thickness, bottomY: l.bottomY, topY: def.topY });
      return out;
    }
    case 'seal':
      return [];
  }
}

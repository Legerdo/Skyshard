// Static water surfaces: the Azure lake, the Verdant pond and the river that drains the pond.
// Levels are world y (m) on the XZ plane. Pure: no DOM, three.js or randomness.

/** A flat circular lake or pond, or a river whose surface slopes along its centreline polyline. */
export type WaterBody =
  | { id: string; kind: 'circle'; x: number; z: number; r: number; level: number }
  | { id: string; kind: 'river'; points: readonly { x: number; z: number; level: number }[]; halfWidth: number };

/** The river variant of WaterBody. */
export type RiverBody = Extract<WaterBody, { kind: 'river' }>;

export const WATER_BODIES: readonly WaterBody[] = [
  { id: 'lake_azure', kind: 'circle', x: -200, z: -300, r: 60, level: 70 },
  { id: 'pond_verdant', kind: 'circle', x: -380, z: 230, r: 30, level: 30 },
  {
    // Rises inside pond_verdant and runs south-west, dropping 9 m.
    id: 'river_verdant',
    kind: 'river',
    points: [
      { x: -385, z: 215, level: 29 },
      { x: -420, z: 280, level: 24 },
      { x: -450, z: 350, level: 20 },
    ],
    halfWidth: 4,
  },
];

/**
 * Horizontal distance from (x, z) to the river's centreline, and the surface level interpolated
 * at the closest centreline point. Terrain carving uses both to cut the riverbed.
 */
export function distanceToRiver(x: number, z: number, body: RiverBody): { dist: number; level: number } {
  const pts = body.points;
  let best = Infinity;
  let level = 0;
  // The last pass measures to the final vertex alone, which also covers single-point rivers.
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[Math.min(i + 1, pts.length - 1)];
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const len2 = sx * sx + sz * sz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * sx + (z - a.z) * sz) / len2)) : 0;
    const dx = x - (a.x + t * sx);
    const dz = z - (a.z + t * sz);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      level = a.level + t * (b.level - a.level);
    }
  }
  return { dist: Math.sqrt(best), level };
}

/** Surface level of one body at (x, z), or null when (x, z) is outside it. */
function surfaceOf(body: WaterBody, x: number, z: number): number | null {
  if (body.kind === 'circle') {
    const dx = x - body.x;
    const dz = z - body.z;
    return dx * dx + dz * dz <= body.r * body.r ? body.level : null;
  }
  const { dist, level } = distanceToRiver(x, z, body);
  return dist <= body.halfWidth ? level : null;
}

/**
 * Water surface level at (x, z): a circle's level inside it (edge included), a river's level at
 * the closest centreline point within halfWidth of it, else null. Where bodies overlap (the river
 * starts inside pond_verdant) the highest surface wins.
 */
export function waterLevelAt(x: number, z: number): number | null {
  let top: number | null = null;
  for (const body of WATER_BODIES) {
    const level = surfaceOf(body, x, z);
    if (level !== null && (top === null || level > top)) top = level;
  }
  return top;
}

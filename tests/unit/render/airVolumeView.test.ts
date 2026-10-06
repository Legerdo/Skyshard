import type { BufferGeometry, LineSegments, Points } from 'three';
import { describe, expect, it } from 'vitest';
import {
  AIR_VOLUME_PRESENTATION, volumeContains, type BoxShape, type UpdraftVolumeDef, type WindZoneVolumeDef,
} from '../../../src/data/volumes';
import { TempAirVolumeView, WIND_STREAK_LENGTH } from '../../../src/render/tempAirVolumeView';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// TEMPORARY Updraft motes and Wind_Zone streaks (task 9.3; Req 19.8), built in Node without a WebGL context.

const UPDRAFT: UpdraftVolumeDef = {
  kind: 'updraft', id: 'u', shape: { kind: 'cylinder', x: 10, z: -5, radius: 4, minY: 2, maxY: 40 },
};
const WIND_BOX: BoxShape = { kind: 'box', x: -30, z: 20, halfX: 12, halfZ: 30, yaw: 0.6, minY: 50, maxY: 80 };
const WIND: WindZoneVolumeDef = { kind: 'windZone', id: 'w', shape: WIND_BOX, direction: { x: Math.sin(0.6), z: Math.cos(0.6) } };

/** The shapes grown by 1 mm, for positions stored as float32. */
const E = 1e-3;
const UPDRAFT_GROWN = { ...UPDRAFT.shape, radius: UPDRAFT.shape.radius + E, minY: UPDRAFT.shape.minY - E, maxY: UPDRAFT.shape.maxY + E };
const WIND_GROWN: BoxShape = { ...WIND_BOX, halfX: WIND_BOX.halfX + E, halfZ: WIND_BOX.halfZ + E, minY: WIND_BOX.minY - E, maxY: WIND_BOX.maxY + E };

const points = (g: BufferGeometry): { x: number; y: number; z: number }[] => {
  const a = g.attributes.position.array;
  const out = [];
  for (let i = 0; i < a.length; i += 3) out.push({ x: a[i], y: a[i + 1], z: a[i + 2] });
  return out;
};

describe('TempAirVolumeView', () => {
  it('draws rising motes inside each Updraft and wind streaks along each Wind_Zone, rebuilding when the volumes change', () => {
    const index = new VolumeIndex();
    index.addAll([UPDRAFT, WIND]);
    const view = new TempAirVolumeView();
    view.update(index, 1);
    expect(view.count).toBe(2);
    const column = view.object.getObjectByName('updraft:u') as Points | undefined;
    const streaks = view.object.getObjectByName('windZone:w') as LineSegments | undefined;
    if (column === undefined || streaks === undefined) throw new Error('air effects');
    expect((column.material as unknown as { color: { getHex(): number } }).color.getHex()).toBe(AIR_VOLUME_PRESENTATION.updraft.color);

    // Motes: inside the column, and (bar the few wrapping from the top back to the base) higher a moment later.
    const motes0 = points(column.geometry);
    for (const p of motes0) expect(volumeContains(UPDRAFT_GROWN, p)).toBe(true);
    view.update(index, 1.05);
    const motes1 = points(column.geometry);
    expect(motes1.filter((p, i) => p.y > motes0[i].y).length).toBeGreaterThan(0.9 * motes0.length);

    // Streaks: each starts inside the zone and runs WIND_STREAK_LENGTH along the wind direction.
    const ends = points(streaks.geometry);
    for (let i = 0; i < ends.length; i += 2) {
      const [a, b] = [ends[i], ends[i + 1]];
      expect(volumeContains(WIND_GROWN, a)).toBe(true);
      expect(b.x - a.x).toBeCloseTo(WIND.direction.x * WIND_STREAK_LENGTH, 4);
      expect(b.z - a.z).toBeCloseTo(WIND.direction.z * WIND_STREAK_LENGTH, 4);
    }

    // Same set: the same objects; a removed volume disappears (the starlit Updrafts come and go).
    view.update(index, 2);
    expect(view.object.getObjectByName('updraft:u')).toBe(column);
    index.remove('windZone', 'w');
    view.update(index, 2);
    expect([view.count, view.object.getObjectByName('windZone:w')]).toEqual([1, undefined]);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });
});

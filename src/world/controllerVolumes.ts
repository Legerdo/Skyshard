// The player controller's view of the water, Updraft and Wind_Zone volumes (design "물·기류·트리거 볼륨"; the pure core
// takes a ControllerVolumes next to the collision queries). Water comes from the terrain's water bodies (depth =
// level − heightAt), the air volumes from the VolumeIndex, so the starlit Updrafts count exactly while the
// Starlit_Stair has them registered. Pure TypeScript: no three.js / DOM.

import type { Vec3 } from '../core/types';
import type { ControllerVolumes, WaterSample } from '../player/core/types';
import type { VolumeIndex } from './volumeIndex';

/** The terrain view water needs; a TerrainField satisfies it. */
export interface WaterTerrain {
  heightAt(x: number, z: number): number;
  /** Water surface level − heightAt where there is water, else 0. */
  waterDepthAt(x: number, z: number): number;
}

/** ControllerVolumes over `volumes` (Updrafts, Wind_Zones) and `terrain` (water; none when omitted). */
export function createControllerVolumes(volumes: VolumeIndex, terrain: WaterTerrain | null = null): ControllerVolumes {
  return {
    water(x: number, z: number): WaterSample | null {
      if (terrain === null) return null;
      const depth = terrain.waterDepthAt(x, z);
      if (!(Number.isFinite(depth) && depth > 0)) return null;
      const level = terrain.heightAt(x, z) + depth;
      return Number.isFinite(level) ? { level, depth } : null;
    },
    updraftTop(feet: Readonly<Vec3>): number | null {
      let top: number | null = null;
      for (const u of volumes.at(feet, 'updraft')) if (top === null || u.shape.maxY > top) top = u.shape.maxY;
      return top;
    },
    windDirection(feet: Readonly<Vec3>): { x: number; z: number } | null {
      const zone = volumes.at(feet, 'windZone')[0];
      if (zone === undefined) return null;
      const len = Math.hypot(zone.direction.x, zone.direction.z);
      return Number.isFinite(len) && len > 1e-9 ? { x: zone.direction.x / len, z: zone.direction.z / len } : null;
    },
  };
}

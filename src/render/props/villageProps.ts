/*
 * Thistlewick's small props painted with the prefab kit (layout: villagePropLayout.ts) into a ChunkBatcher, so they
 * merge per chunk with the rest of the village (≈ 1 draw call per chunk).
 */
import { REGION_PALETTES } from '../../data/palettes';
import { hash3, trs, type PartBuilder } from '../prefabs/kit';
import { tint } from '../prefabs/keyLocations';
import type { ChunkBatcher } from './propBatcher';
import { villagePropSpots, type VillagePropSpot } from './villagePropLayout';

const WOOD = REGION_PALETTES.verdant.swatches.wood;

function barrel(b: PartBuilder, x: number, y: number, z: number, yaw: number): void {
  const m = trs(x, y, z, 0, yaw, 0);
  b.cylinder(0.36, 0.33, 0.95, 10, m, tint(WOOD, 0.9), { bevel: 0.05, rings: 2, noise: 0.015 });
  for (const hy of [0.18, 0.72]) b.cylinder(0.375, 0.37, 0.07, 10, m.clone().multiply(trs(0, hy, 0)), 0x3a3634, { open: true });
}

function crate(b: PartBuilder, x: number, y: number, z: number, yaw: number, size: number, shade: number): void {
  b.boxAt(x, y, z, size, size, size, tint(0x9c7b4f, shade), yaw, 0.05);
  const m = trs(x, y + size / 2, z, 0, yaw, 0);
  for (const sx of [-1, 1]) b.box(0.08, size * 0.96, size + 0.02, m.clone().multiply(trs((sx * size) / 2, 0, 0, 0.62 * sx, 0, 0)), 0x7a5a3a, 0.02);
}

/** Paints every prop spot into `batcher` (ground height from `heightAt`); returns the props painted. */
export function addVillageProps(batcher: ChunkBatcher, heightAt: (x: number, z: number) => number, spots: readonly VillagePropSpot[] = villagePropSpots()): number {
  for (const s of spots) {
    const h = heightAt(s.x, s.z);
    const y = (Number.isFinite(h) ? h : 0) - 0.04;
    const b = batcher.at(s.x, s.z);
    switch (s.kind) {
      case 'barrel':
        barrel(b, s.x, y, s.z, s.yaw);
        break;
      case 'crate':
        crate(b, s.x, y, s.z, s.yaw, 0.85, 1);
        crate(b, s.x + 0.1 * Math.cos(s.yaw), y + 0.85, s.z - 0.1 * Math.sin(s.yaw), s.yaw + 0.5, 0.6, 0.9);
        break;
      case 'woodpile':
        for (let row = 0; row < 3; row++) {
          for (let k = 0; k < 4 - row; k++) {
            const off = (k - (3 - row) / 2) * 0.32;
            const m = trs(s.x + off * Math.cos(s.yaw), y + 0.15 + row * 0.27, s.z - off * Math.sin(s.yaw), 0, s.yaw, Math.PI / 2);
            b.cylinder(0.14, 0.14, 1.6, 7, m.multiply(trs(0, -0.8, 0)), tint(0x8a6a45, 0.9 + 0.2 * hash3(row, k, 1)), { bevel: 0.03 });
          }
        }
        break;
      case 'cart': {
        const m = trs(s.x, y, s.z, 0, s.yaw, 0);
        b.box(1.3, 0.14, 2.1, m.clone().multiply(trs(0, 0.72, 0)), tint(WOOD, 0.95), 0.03);
        for (const sx of [-1, 1]) b.box(0.08, 0.35, 2.1, m.clone().multiply(trs(sx * 0.62, 0.95, 0)), 0x7a5a3a, 0.02);
        b.box(1.3, 0.35, 0.08, m.clone().multiply(trs(0, 0.95, -1.02)), 0x7a5a3a, 0.02);
        for (const sx of [-1, 1]) {
          b.cylinder(0.55, 0.55, 0.1, 12, m.clone().multiply(trs(sx * 0.78, 0.55, 0.2, 0, 0, Math.PI / 2)).multiply(trs(0, -0.05, 0)), 0x5a3c26, { bevel: 0.02 });
          b.box(0.08, 0.08, 1.6, m.clone().multiply(trs(sx * 0.4, 0.62, 1.8, 0.35, 0, 0)), 0x7a5a3a, 0.02);
        }
        break;
      }
      case 'fencePost':
        b.boxAt(s.x, y, s.z, 0.14, 1.0, 0.14, tint(0x7a5a3a, 0.9 + 0.2 * hash3(s.x, s.z, 1)), 0, 0.03);
        break;
      case 'fenceRail': {
        const len = s.length ?? 2.5;
        for (const ry of [0.45, 0.8]) b.box(len, 0.08, 0.06, trs(s.x, y + ry, s.z), 0x8a6a45, 0.02);
        break;
      }
    }
  }
  return spots.length;
}

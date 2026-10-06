import { describe, expect, it } from 'vitest';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { MAP_SIZE, worldToMap } from '../../../src/map/mapCoords';
import { renderMapPixels, type MapTerrain, type RegionWeights } from '../../../src/map/mapImage';
import { buildTerrain, regionWeightsAt } from '../../../src/world/terrain';

// Map image ground layers (task 13.5): hillshade lit from the north-west over the Region palette, water on top.

const verdantOnly: RegionWeights = () => ({ verdant: 1, ember: 0, azure: 0, crater: 0 });
const SIZE = 64;
const pixel = (data: Uint8ClampedArray, i: number, j: number): number[] => {
  const o = (j * SIZE + i) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};
const brightness = (p: number[]): number => p[0] + p[1] + p[2];

describe('map image', () => {
  it('lights slopes facing the north-west and shades those facing the south-east', () => {
    // Ground rising toward the south-east (+x, +z) faces the north-west light; the opposite slope faces away.
    const facingNw: MapTerrain = { heightAt: (x, z) => 0.5 * (x + z), waterDepthAt: () => 0 };
    const facingSe: MapTerrain = { heightAt: (x, z) => -0.5 * (x + z), waterDepthAt: () => 0 };
    const flat: MapTerrain = { heightAt: () => 0, waterDepthAt: () => 0 };
    const at = (t: MapTerrain): number => brightness(pixel(renderMapPixels(t, verdantOnly, SIZE), SIZE / 2, SIZE / 2));
    expect(at(facingNw)).toBeGreaterThan(at(flat));
    expect(at(facingSe)).toBeLessThan(at(flat));
  });

  it('paints water over the ground and keeps every pixel opaque', () => {
    const lake = { heightAt: () => 0, waterDepthAt: (x: number, z: number) => (Math.hypot(x, z) < 100 ? 3 : 0) };
    const data = renderMapPixels(lake, verdantOnly, SIZE);
    const centre = pixel(data, SIZE / 2, SIZE / 2);
    const edge = pixel(data, SIZE / 2, SIZE / 2 - 20); // ≈ 350 m north, dry
    expect(centre[2]).toBeGreaterThan(centre[0]); // blue water
    expect(edge[1]).toBeGreaterThan(edge[2]); // green Verdant ground
    for (let k = 3; k < data.length; k += 4) expect(data[k]).toBe(255);
  });

  it('draws the seeded world: the Azure lake blue, the Verdant hills green, the Ember canyon warm', () => {
    const terrain = buildTerrain(20240601);
    const size = 128;
    const data = renderMapPixels(terrain, regionWeightsAt, size);
    const at = (x: number, z: number): number[] => {
      const { px, py } = worldToMap(x, z);
      const o = (Math.floor((py / MAP_SIZE) * size) * size + Math.floor((px / MAP_SIZE) * size)) * 4;
      return [data[o], data[o + 1], data[o + 2]];
    };
    const lake = at(LOCATIONS.lake_azure.x, LOCATIONS.lake_azure.z);
    expect(lake[2]).toBeGreaterThan(lake[0] + 40);
    const verdant = at(-300, 380);
    expect(verdant[1]).toBeGreaterThan(verdant[2]);
    const ember = at(LOCATIONS.camp_durga.x, LOCATIONS.camp_durga.z);
    expect(ember[0]).toBeGreaterThan(ember[2]);
  });

  it('uses each Region\'s palette colour', () => {
    const flat = { heightAt: () => 20, waterDepthAt: () => 0 };
    const ember = renderMapPixels(flat, () => ({ verdant: 0, ember: 1, azure: 0, crater: 0 }), SIZE);
    const p = pixel(ember, SIZE / 2, SIZE / 2);
    expect(p[0]).toBeGreaterThan(p[2]); // warm canyon red
  });
});

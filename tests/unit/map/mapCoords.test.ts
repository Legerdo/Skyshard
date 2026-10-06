import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clampView, initialView, MAP_SIZE, MAP_ZOOM_MAX, MAP_ZOOM_MIN, mapToWorld, METERS_PER_PX, metersToPx, panView, screenToView,
  viewToScreen, worldToMap, zoomViewAt,
} from '../../../src/map/mapCoords';

// Map coordinate transform (task 13.5, design "지도 (Map_System)"): px = (x + 560) / 1120 × 1024,
// py = (z + 560) / 1120 × 1024, north (−z) up; pan and 1×–4× zoom around the cursor.

describe('map coordinates', () => {
  it('maps the world square onto the 1024 px image with north up', () => {
    expect(worldToMap(-560, -560)).toEqual({ px: 0, py: 0 }); // north-west corner, top left
    expect(worldToMap(560, 560)).toEqual({ px: 1024, py: 1024 });
    expect(worldToMap(0, 0)).toEqual({ px: 512, py: 512 });
    expect(worldToMap(-250, 300)).toEqual({ px: ((-250 + 560) / 1120) * 1024, py: ((300 + 560) / 1120) * 1024 });
    // East is right, north is up.
    expect(worldToMap(100, 0).px).toBeGreaterThan(512);
    expect(worldToMap(0, -100).py).toBeLessThan(512);
    expect(METERS_PER_PX).toBeCloseTo(1.09375, 12);
    expect(metersToPx(60)).toBeCloseTo(60 / 1.09375, 12);
  });

  it('inverts exactly', () => {
    fc.assert(
      fc.property(fc.double({ min: -560, max: 560, noNaN: true }), fc.double({ min: -560, max: 560, noNaN: true }), (x, z) => {
        const { px, py } = worldToMap(x, z);
        const back = mapToWorld(px, py);
        expect(back.x).toBeCloseTo(x, 9);
        expect(back.z).toBeCloseTo(z, 9);
      }),
      { numRuns: 100 },
    );
  });
});

describe('map pan and zoom', () => {
  const W = 1200;
  const H = 800;

  it('fits and centres the whole map at zoom 1', () => {
    const v = initialView(W, H);
    expect(v.zoom).toBe(1);
    expect(v.fit).toBeCloseTo(H / MAP_SIZE, 12);
    const tl = viewToScreen(v, 0, 0);
    const br = viewToScreen(v, MAP_SIZE, MAP_SIZE);
    expect(tl.y).toBeCloseTo(0, 9);
    expect(br.y).toBeCloseTo(H, 9);
    expect((tl.x + br.x) / 2).toBeCloseTo(W / 2, 9);
  });

  it('zooms 1×–4× keeping the map pixel under the cursor in place', () => {
    const v = initialView(W, H);
    const cursor = { x: 700, y: 300 };
    const under = screenToView(v, cursor.x, cursor.y);
    const z2 = zoomViewAt(v, 2, cursor.x, cursor.y, W, H);
    expect(z2.zoom).toBe(2);
    const after = viewToScreen(z2, under.px, under.py);
    expect(after.x).toBeCloseTo(cursor.x, 9);
    expect(after.y).toBeCloseTo(cursor.y, 9);
    expect(zoomViewAt(v, 10, 0, 0, W, H).zoom).toBe(MAP_ZOOM_MAX);
    expect(zoomViewAt(z2, 0.1, 0, 0, W, H).zoom).toBe(MAP_ZOOM_MIN);
  });

  it('pans by drags without leaving the image edge inside the viewport', () => {
    const v = zoomViewAt(initialView(W, H), 3, W / 2, H / 2, W, H);
    const dragged = panView(v, 50, -30, W, H);
    expect(dragged.offsetX).toBeCloseTo(v.offsetX + 50, 9);
    expect(dragged.offsetY).toBeCloseTo(v.offsetY - 30, 9);
    const far = panView(v, 1e6, 1e6, W, H);
    expect(far.offsetX).toBe(0);
    expect(far.offsetY).toBe(0);
    const size = MAP_SIZE * v.fit * v.zoom;
    const other = panView(v, -1e6, -1e6, W, H);
    expect(other.offsetX).toBeCloseTo(W - size, 9);
    expect(other.offsetY).toBeCloseTo(H - size, 9);
    // At zoom 1 the narrow axis stays centred.
    expect(clampView({ ...initialView(W, H), offsetX: 0 }, W, H).offsetX).toBeCloseTo((W - MAP_SIZE * (H / MAP_SIZE)) / 2, 9);
  });
});

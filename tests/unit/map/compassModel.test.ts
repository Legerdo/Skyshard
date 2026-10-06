import { describe, expect, it } from 'vitest';
import { dirFromYaw, yawFromDir } from '../../../src/core/math';
import {
  bearingDeg, COMPASS_WAYSTONE_RANGE, compassModel, compassTicks, projectBearing, wrapDeg, type CompassInputs,
} from '../../../src/map/compassModel';
import { headingFromYaw } from '../../../src/map/mapCoords';

// Compass projection (task 13.7, design "Compass", Req 33.4, 3.6, 15.4): bearing = atan2(dx, −dz), Δ = wrap(bearing −
// heading), u = 0.5 + Δ / 180°, full opacity to 70°, fading to 0 at 90°, hidden beyond.

const base: CompassInputs = { player: { x: 0, z: 0 }, heading: 0, main: null, side: null, waystones: [], landmarks: [] };

describe('compass projection', () => {
  it('measures bearings from north clockwise with +x east and −z north', () => {
    expect(bearingDeg(0, -10)).toBeCloseTo(0, 12);
    expect(bearingDeg(10, 0)).toBeCloseTo(90, 12);
    expect(bearingDeg(0, 10)).toBeCloseTo(180, 12);
    expect(bearingDeg(-10, 0)).toBeCloseTo(270, 12);
    expect(bearingDeg(5, -5)).toBeCloseTo(45, 12);
  });

  it('wraps Δ into (−180°, 180°]', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(190)).toBeCloseTo(-170, 12);
    expect(wrapDeg(-190)).toBeCloseTo(170, 12);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(720 + 30)).toBeCloseTo(30, 12);
  });

  it('places Δ at u = 0.5 + Δ / 180 and fades from 70° to 90°', () => {
    expect(projectBearing(0, 0)).toMatchObject({ delta: 0, u: 0.5, opacity: 1, visible: true });
    expect(projectBearing(90, 0)).toMatchObject({ u: 1, opacity: 0, visible: true });
    expect(projectBearing(270, 0)).toMatchObject({ u: 0, opacity: 0, visible: true });
    expect(projectBearing(70, 0).opacity).toBe(1);
    expect(projectBearing(80, 0).opacity).toBeCloseTo(0.5, 12);
    expect(projectBearing(-75 + 360, 0).opacity).toBeCloseTo(0.75, 12);
    expect(projectBearing(91, 0)).toMatchObject({ opacity: 0, visible: false });
    // Across north: heading 350°, bearing 10° is 20° to the right.
    const p = projectBearing(10, 350);
    expect(p.delta).toBeCloseTo(20, 12);
    expect(p.u).toBeCloseTo(0.5 + 20 / 180, 12);
  });

  it('reads the camera heading from the core yaw on the same scale as the bearings', () => {
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0], [3, -4], [-2, 5]] as const) {
      const yaw = yawFromDir(dx, dz);
      const d = dirFromYaw(yaw);
      expect(headingFromYaw(yaw)).toBeCloseTo(bearingDeg(d.x, d.z), 9);
    }
    expect(headingFromYaw(0)).toBeCloseTo(180, 12); // yaw 0 faces +z, the south
  });

  it('shows 15° ticks with N / E / S / W inside the 180° view only', () => {
    const ticks = compassTicks(0);
    expect(ticks.map((t) => t.bearing).sort((a, b) => a - b)).toEqual([0, 15, 30, 45, 60, 75, 90, 270, 285, 300, 315, 330, 345]);
    expect(ticks.filter((t) => t.label !== null).map((t) => t.label).sort()).toEqual(['E', 'N', 'W']);
    const south = compassTicks(180).find((t) => t.label === 'S');
    expect(south?.u).toBeCloseTo(0.5, 12);
  });
});

describe('compass contents', () => {
  it('points at the Main_Quest exact marker and the tracked Side_Quest in their own kinds', () => {
    const m = compassModel({
      ...base,
      main: { kind: 'exact', pos: { x: 100, y: 0, z: 0 } },
      side: { kind: 'exact', pos: { x: 0, y: 0, z: -50 } },
    });
    const main = m.markers.find((k) => k.kind === 'main');
    const side = m.markers.find((k) => k.kind === 'side');
    expect(main?.u).toBeCloseTo(1, 12); // due east at heading north: the right edge
    expect(main?.distance).toBeCloseTo(100, 12);
    expect(side?.u).toBeCloseTo(0.5, 12);
    expect(m.inMainZone).toBe(false);
  });

  it('points at a zone marker\'s centre from outside and shows "탐색 구역" instead inside it (Req 3.6)', () => {
    const zone = { kind: 'zone' as const, center: { x: 0, y: 0, z: -200 }, radius: 60 };
    const outside = compassModel({ ...base, main: zone });
    expect(outside.inMainZone).toBe(false);
    expect(outside.markers.find((k) => k.kind === 'main')?.u).toBeCloseTo(0.5, 12);
    const inside = compassModel({ ...base, player: { x: 10, z: -170 }, main: zone });
    expect(inside.inMainZone).toBe(true);
    expect(inside.markers.some((k) => k.kind === 'main')).toBe(false);
  });

  it('lists active Waystones within 150 m and discovered Landmarks, hiding what is behind the view', () => {
    const m = compassModel({
      ...base,
      waystones: [
        { id: 'ws_thistlewick', x: 0, z: -(COMPASS_WAYSTONE_RANGE - 1) },
        { id: 'ws_ember', x: 0, z: -(COMPASS_WAYSTONE_RANGE + 1) },
      ],
      landmarks: [
        { id: 'lm_elderbough', x: -300, z: -300 },
        { id: 'lm_waterfall', x: 0, z: 400 }, // behind (south) while facing north
      ],
    });
    expect(m.markers.map((k) => `${k.kind}:${k.id}`).sort()).toEqual(['landmark:lm_elderbough', 'waystone:ws_thistlewick']);
    const elderbough = m.markers.find((k) => k.id === 'lm_elderbough');
    expect(elderbough?.u).toBeCloseTo(0.5 - 45 / 180, 12);
  });
});

import { describe, expect, it } from 'vitest';
import { createGameEventBus, type GameEvents } from '../../../src/core/gameEvents';
import type { Vec3 } from '../../../src/core/types';
import type { RegionId } from '../../../src/data/ids';
import { AREA_VOLUMES, DISCOVERY_VOLUMES } from '../../../src/data/volumes';
import { LOCATIONS, type LocationId } from '../../../src/data/worldLayout';
import { regionUnlocked } from '../../../src/logic/gates';
import { createNewGameState, type GameState } from '../../../src/logic/save/gameState';
import { VolumeIndex } from '../../../src/world/volumeIndex';
import { WorldTriggers } from '../../../src/world/worldTriggers';

// Region / area / Landmark entry (task 4.5; Req 8.7, 9.4).
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const on = (id: LocationId): Vec3 => v(LOCATIONS[id].x, LOCATIONS[id].groundY, LOCATIONS[id].z);

function setup(state: GameState = createNewGameState(1)) {
  const bus = createGameEventBus();
  const entered: GameEvents['area:entered'][] = [];
  const landmarks: GameEvents['landmark:discovered'][] = [];
  bus.on('area:entered', (p) => entered.push(p));
  bus.on('landmark:discovered', (p) => landmarks.push(p));
  const volumes = new VolumeIndex();
  volumes.addAll(AREA_VOLUMES);
  volumes.addAll(DISCOVERY_VOLUMES);
  const titles: RegionId[] = [];
  const triggers = new WorldTriggers({
    bus, state, volumes, unlocked: (r) => regionUnlocked(r, state), sinks: { regionTitle: (r) => titles.push(r) },
  });
  const visit = (p: Vec3): void => {
    triggers.tick(p);
    bus.dispatch();
  };
  return { state, triggers, entered, landmarks, titles, visit };
}

describe('WorldTriggers', () => {
  it('enters the start Region once with a title card and registers it on the map', () => {
    const { state, entered, titles, visit } = setup();
    visit(v(-240, 18, 290)); // Thistlewick
    expect(entered).toContainEqual({ regionId: 'verdant', areaId: 'verdant', first: true });
    expect(entered).toContainEqual({ regionId: 'verdant', areaId: 'thistlewick', first: true });
    expect(titles).toEqual(['verdant']);
    expect(state.discovery.regions).toEqual(['verdant']);
    const before = entered.length;
    visit(v(-241, 18, 290)); // still there
    expect(entered).toHaveLength(before);
  });

  it('tells a return from a first entry and shows the title card only the first time', () => {
    const { entered, titles, visit } = setup();
    visit(on('thistlewick'));
    visit(on('resonance_altar'));
    visit(on('thistlewick'));
    const regions = entered.filter((e) => e.areaId === e.regionId);
    expect(regions).toEqual([
      { regionId: 'verdant', areaId: 'verdant', first: true },
      { regionId: 'crater', areaId: 'crater', first: true },
      { regionId: 'verdant', areaId: 'verdant', first: false },
    ]);
    expect(entered.filter((e) => e.areaId === 'thistlewick').map((e) => e.first)).toEqual([true, false]);
    expect(titles).toEqual(['verdant', 'crater']);
  });

  it('remembers visited areas in GameState, so a later session reports a return', () => {
    const first = setup();
    first.visit(on('resonance_altar'));
    const again = setup(first.state);
    again.visit(on('resonance_altar'));
    expect(again.entered).toContainEqual({ regionId: 'crater', areaId: 'resonance_altar', first: false });
    expect(again.titles).toEqual([]);
  });

  it('does not enter a locked Region until its barriers are open', () => {
    const { state, entered, visit } = setup();
    visit(on('resonance_altar'));
    visit(v(40, 26, -118)); // azure rectangle, south of the gate wall
    expect(entered.some((e) => e.regionId === 'azure')).toBe(false);
    state.skyshards = 2;
    visit(v(40, 30, -134));
    expect(entered).toContainEqual({ regionId: 'azure', areaId: 'azure', first: true });
    expect(entered).toContainEqual({ regionId: 'azure', areaId: 'gate_azure', first: true });
  });

  it('discovers a Landmark once when its radius is first entered', () => {
    const { state, landmarks, visit } = setup();
    visit(on('lm_elderbough'));
    visit(on('hollowroot_entrance'));
    visit(on('lm_elderbough'));
    expect(landmarks).toEqual([{ landmarkId: 'lm_elderbough', regionId: 'verdant' }]);
    expect(state.discovery.landmarks).toEqual(['lm_elderbough']);
  });

  it('enters a Challenge_Area from inside it (the Hollowroot sinkhole), not from the ground above', () => {
    const { entered, visit } = setup();
    visit(on('hollowroot_entrance'));
    expect(entered.some((e) => e.areaId === 'hollowroot')).toBe(false);
    visit(v(-228, -10, 128));
    expect(entered).toContainEqual({ regionId: 'verdant', areaId: 'hollowroot', first: true });
  });
});

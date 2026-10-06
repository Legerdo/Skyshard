import { describe, expect, it } from 'vitest';
import { CHESTS, ECHO_TABLETS } from '../../../src/data/pois';
import { mapMarkFlag } from '../../../src/data/vistas';
import { createNewGameState } from '../../../src/logic/save/gameState';
import type { MapContent } from '../../../src/map/mapContent';
import { metersToPx, worldToMap } from '../../../src/map/mapCoords';
import { MAP_ZONE_MIN_RADIUS, mapModel, regionOfPlacedId } from '../../../src/map/mapModel';

// What the map draws (task 13.5; Req 33.1, 33.2, 33.5, 3.6, 9.5, 11.2, 15.4).

const none = { main: null, side: null };

describe('map model', () => {
  it('shows only discovered Regions, Thistlewick always, and Landmarks discovered or marked by a Vista', () => {
    const gs = createNewGameState(1);
    const empty = mapModel(gs, none);
    expect(empty.regions).toEqual([]);
    expect(empty.village.name).toBe('Thistlewick');
    expect(empty.landmarks).toEqual([]);
    gs.discovery.regions.push('verdant');
    gs.discovery.landmarks.push('lm_elderbough');
    gs.world.flags[mapMarkFlag('lm_breezewatch')] = true;
    const m = mapModel(gs, none);
    expect(m.regions.map((r) => r.name)).toEqual(['Verdant Reach']);
    expect(m.landmarks.map((l) => [l.id, l.discovered])).toEqual([['lm_breezewatch', false], ['lm_elderbough', true]].sort());
  });

  it('lists active Waystones as destinations and Vista-marked inactive ones as plain markers (Req 11.2)', () => {
    const gs = createNewGameState(1);
    gs.world.waystones.push('ws_thistlewick');
    gs.world.flags[mapMarkFlag('ws_elderbough')] = true;
    const m = mapModel(gs, none);
    expect(m.waystones.map((w) => [w.id, w.active])).toEqual([['ws_thistlewick', true], ['ws_elderbough', false]]);
    const at = worldToMap(-232, 318);
    expect(m.waystones[0]).toMatchObject({ px: at.px, py: at.py });
  });

  it('hides undiscovered POIs even over revealed ground (Req 33.2) and counts Chests / Echo_Tablets per Region', () => {
    const gs = createNewGameState(1);
    gs.discovery.regions.push('verdant', 'ember');
    const content: MapContent = {
      pois: [
        { id: 'poi_verdant_1', kind: 'hidden', region: 'verdant', x: -300, z: 250, name: '비밀 동굴' },
        { id: 'poi_verdant_2', kind: 'lore', region: 'verdant', x: -310, z: 260, name: '' },
      ],
      chests: [
        { id: 'chest_verdant_1', region: 'verdant' },
        { id: 'chest_verdant_2', region: 'verdant' },
        { id: 'chest_ember_1', region: 'ember' },
      ],
      tablets: [{ id: 'tab_verdant_1', region: 'verdant' }],
    };
    gs.discovery.pois.push('poi_verdant_2');
    gs.world.chests.push('chest_verdant_2', 'chest_ember_1');
    gs.world.echoTablets.push('tab_verdant_1');
    const m = mapModel(gs, none, content);
    expect(m.pois.map((p) => p.id)).toEqual(['poi_verdant_2']);
    const verdant = m.counts.find((c) => c.region === 'verdant');
    expect(verdant).toMatchObject({ discovered: true, chests: { found: 1, total: 2 }, tablets: { found: 1, total: 1 } });
    expect(m.counts.find((c) => c.region === 'ember')).toMatchObject({ chests: { found: 1, total: 1 }, tablets: { found: 0, total: 0 } });
    expect(m.counts.find((c) => c.region === 'azure')?.discovered).toBe(false);
  });

  it('counts found Chests by their id prefix when a content table lists none', () => {
    const gs = createNewGameState(1);
    gs.world.chests.push('chest_verdant_3', 'chest_azure_1');
    const m = mapModel(gs, none, { pois: [], chests: [], tablets: [] });
    expect(m.counts.find((c) => c.region === 'verdant')?.chests).toEqual({ found: 1, total: 0 });
    expect(regionOfPlacedId('tab_crater_2')).toBe('crater');
    expect(regionOfPlacedId('bogus')).toBeNull();
  });

  it('takes the per-Region Chest / Echo_Tablet totals and the map POIs from src/data/pois.ts (tasks 12.7, 20.1)', () => {
    const gs = createNewGameState(1);
    gs.world.chests.push('chest_pz_verdant_1', 'chest_verdant_3');
    gs.world.echoTablets.push('tab_ember_2');
    gs.discovery.hiddenPlaces.push('poi_verdant_1');
    gs.discovery.pois.push('camp_azure_1');
    const m = mapModel(gs, none);
    for (const region of ['verdant', 'ember', 'azure', 'crater'] as const) {
      const counts = m.counts.find((c) => c.region === region);
      expect(counts?.chests.total, region).toBe(CHESTS.filter((c) => c.region === region).length);
      expect(counts?.tablets.total, region).toBe(ECHO_TABLETS.filter((t) => t.region === region).length);
    }
    expect(m.counts.find((c) => c.region === 'verdant')?.chests.found).toBe(2);
    expect(m.counts.find((c) => c.region === 'ember')?.tablets).toEqual({ found: 1, total: 3 });
    expect(m.pois.map((p) => [p.id, p.kind]).sort()).toEqual([['camp_azure_1', 'camp'], ['poi_verdant_1', 'hidden']]);
  });

  it('draws exact Objective pins and zone circles of at least 60 m for the Main and the tracked Side_Quest (Req 3.6, 15.4)', () => {
    const gs = createNewGameState(1);
    const m = mapModel(gs, {
      main: { text: '탐색', marker: { kind: 'zone', center: { x: 0, y: 0, z: 0 }, radius: 40 } },
      side: { text: '연 찾기', marker: { kind: 'exact', pos: { x: 10, y: 0, z: 20 } } },
    });
    const main = m.objectives.find((o) => o.quest === 'main');
    expect(main).toMatchObject({ kind: 'zone', px: 512, py: 512 });
    expect(main?.radiusPx).toBeCloseTo(metersToPx(MAP_ZONE_MIN_RADIUS), 9);
    const wide = mapModel(gs, { main: { text: '', marker: { kind: 'zone', center: { x: 0, y: 0, z: 0 }, radius: 90 } }, side: null });
    expect(wide.objectives[0]?.radiusPx).toBeCloseTo(metersToPx(90), 9);
    expect(m.objectives.find((o) => o.quest === 'side')).toMatchObject({ kind: 'exact', radiusPx: 0, ...worldToMap(10, 20) });
    expect(mapModel(gs, { main: { text: '', marker: { kind: 'none' } }, side: null }).objectives).toEqual([]);
  });
});

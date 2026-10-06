import { describe, expect, it } from 'vitest';
import type { RegionId } from '../../src/data/ids';
import { ITEM_BY_ID } from '../../src/data/items';
import {
  CHESTS, ECHO_TABLETS, HIDDEN_PLACES, LORE_STONES, MAIN_POI_REGIONS, POI_MINIMUMS, POIS, SKY_RING_TRIAL, poiDataErrors,
  type ChestDef, type PoiDef, type PoiKind,
} from '../../src/data/pois';
import { CAMPS } from '../../src/data/spawns';
import { PLAY_RADIUS } from '../../src/data/worldLayout';

// Task 20.1 (design "Region별 최소 수량", "Chest 맥락 규칙"; Req 10.2–10.4, 10.10, 9.6): the POI list's data rules. Any
// Region / kind below its minimum, a Chest without a `context` or a main Region without a `high` glowing Chest fails.

const count = (pois: readonly PoiDef[], region: RegionId, kind: PoiKind): number =>
  pois.filter((p) => p.region === region && p.kind === kind).length;

describe('POI data (Req 10.2–10.4)', () => {
  it('has no data errors', () => {
    expect(poiDataErrors()).toEqual([]);
  });

  it.each(Object.entries(POI_MINIMUMS) as [RegionId, Partial<Record<PoiKind, number>>][])(
    '%s meets the minimum count of every kind',
    (region, mins) => {
      for (const [kind, min] of Object.entries(mins) as [PoiKind, number][]) {
        expect(count(POIS, region, kind), `${region} ${kind}`).toBeGreaterThanOrEqual(min);
      }
    },
  );

  it('the minimum table is the design’s: 26 per main Region, 7 in the crater (85 with the second verdant Waystone)', () => {
    const total = (r: RegionId): number => Object.values(POI_MINIMUMS[r] ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    expect(MAIN_POI_REGIONS.map(total)).toEqual([26, 26, 26]);
    expect(total('crater')).toBe(7);
    expect(count(POIS, 'verdant', 'waystone')).toBeGreaterThanOrEqual(2); // ws_thistlewick and ws_elderbough
  });

  it('every Chest has a context, and each main Region has a high glowing Chest (reached by climbing or gliding only)', () => {
    for (const p of POIS.filter((q) => q.kind === 'chest')) expect(p.context, p.id).toBeDefined();
    for (const c of CHESTS) expect(['hidden', 'camp', 'high', 'puzzle', 'sidepath', 'cave']).toContain(c.context);
    for (const region of MAIN_POI_REGIONS) {
      const high = CHESTS.filter((c) => c.region === region && c.context === 'high' && c.tier === 'glowing');
      expect(high.length, region).toBeGreaterThanOrEqual(1);
    }
  });

  it('fails on a missing POI, a Chest without context or a main Region without its high glowing Chest', () => {
    const campless = POIS.filter((p) => p.id !== 'camp_ember_2');
    expect(poiDataErrors(campless)).toEqual([expect.stringContaining('camp')]);

    const noContext = POIS.map((p): PoiDef => (p.id === 'chest_verdant_7' ? { ...p, context: undefined } : p));
    expect(poiDataErrors(noContext)).toContain('chest chest_verdant_7 has no context');

    const lowered = (c: ChestDef): ChestDef => (c.region === 'azure' && c.context === 'high' ? { ...c, context: 'sidepath' } : c);
    const chests = CHESTS.map(lowered);
    const pois = POIS.map((p) => {
      const c = chests.find((x) => x.id === p.id);
      return c === undefined ? p : { ...p, context: c.context };
    });
    expect(poiDataErrors(pois, chests)).toEqual([expect.stringContaining('high glowing Chest')]);

    const tooFewTablets = POIS.filter((p) => p.id !== 'tab_azure_3');
    expect(poiDataErrors(tooFewTablets).join()).toMatch(/tablet/);
  });

  it('ids are unique and every POI lies inside the play area (the Sanctum floats over the crater)', () => {
    const keys = POIS.map((p) => `${p.kind}:${p.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(CHESTS.map((c) => c.id)).size).toBe(CHESTS.length);
    for (const p of POIS) {
      expect(Math.hypot(p.pos.x, p.pos.z), p.id).toBeLessThanOrEqual(PLAY_RADIUS);
      expect(Number.isFinite(p.pos.y), p.id).toBe(true);
      expect(p.radius, p.id).toBeGreaterThan(0);
      expect(p.name.length, p.id).toBeGreaterThan(0);
    }
  });
});

describe('Chests (Req 10.5–10.7, 10.10)', () => {
  it('ids follow chest_<region>_<n> (puzzle rewards chest_pz_<region>_<n>) and carry their Region', () => {
    for (const c of CHESTS) expect(c.id, c.id).toMatch(new RegExp(`^chest_(?:pz_)?${c.region}_\\d+$`));
  });

  it("each Enemy_Camp's locked Chest is a fine camp Chest of the same Region", () => {
    for (const camp of CAMPS) {
      if (camp.chestId === null) continue;
      const chest = CHESTS.find((c) => c.id === camp.chestId);
      expect(chest, camp.id).toBeDefined();
      expect(chest).toMatchObject({ tier: 'fine', context: 'camp', region: camp.region, source: { kind: 'camp', campId: camp.id } });
    }
  });

  it('the hidden Elites and the Sky Ring Trial leave glowing Chests', () => {
    for (const elite of ['oldMossback', 'emberjaw', 'galeclaw'] as const) {
      const chest = CHESTS.find((c) => c.source.kind === 'elite' && c.source.eliteId === elite);
      expect(chest?.tier, elite).toBe('glowing');
    }
    const trial = CHESTS.find((c) => c.id === SKY_RING_TRIAL.chestId);
    expect(trial).toMatchObject({ tier: 'glowing', region: 'azure', source: { kind: 'trial', trialId: SKY_RING_TRIAL.id } });
  });

  it('designated items are equipment, each named by one Chest', () => {
    const items = CHESTS.flatMap((c) => (c.item === undefined ? [] : [c.item]));
    expect(new Set(items).size).toBe(items.length);
    for (const c of CHESTS) {
      if (c.item === undefined) continue;
      expect(c.tier, c.id).toBe('glowing');
      expect(ITEM_BY_ID.get(c.item)?.effect, c.item).toBeDefined();
    }
  });
});

describe('Echo_Tablets, hidden places, lore and the Sky Ring Trial (Req 10.8–10.10, 9.6)', () => {
  it('three Echo_Tablets per main Region, tab_<region>_1..3, each with a 1–2 sentence record', () => {
    for (const region of MAIN_POI_REGIONS) {
      const ids = ECHO_TABLETS.filter((t) => t.region === region).map((t) => t.id).sort();
      expect(ids).toEqual([1, 2, 3].map((n) => `tab_${region}_${n}`));
    }
    for (const t of ECHO_TABLETS) {
      const sentences = t.text.split(/[.!?。]\s*/).filter((s) => s.trim() !== '');
      expect(sentences.length, t.id).toBeGreaterThanOrEqual(1);
      expect(sentences.length, t.id).toBeLessThanOrEqual(2);
    }
  });

  it('one hidden place per main Region, and every lore stone has its text', () => {
    for (const region of MAIN_POI_REGIONS) expect(HIDDEN_PLACES.filter((h) => h.region === region)).toHaveLength(1);
    for (const l of LORE_STONES) expect(l.text.length, l.id).toBeGreaterThan(0);
  });

  it('the azure Sky Ring Trial: 8 rings 15 m apart along the course, centres from y 116 down to 87, 60 s', () => {
    const { rings, start, timeLimitSec, region } = SKY_RING_TRIAL;
    expect(region).toBe('azure');
    expect(timeLimitSec).toBe(60);
    expect(rings).toHaveLength(8);
    expect(rings[0]?.y).toBeCloseTo(116, 6);
    expect(rings[7]?.y).toBeCloseTo(87, 6);
    let prev = { x: start.x, z: start.z };
    for (const r of rings) {
      expect(Math.hypot(r.x - prev.x, r.z - prev.z)).toBeCloseTo(15, 6);
      prev = r;
    }
    expect(POIS.filter((p) => p.kind === 'trial' && p.region === 'azure')).toHaveLength(1);
  });
});

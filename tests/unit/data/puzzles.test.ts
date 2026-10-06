import { describe, expect, it } from 'vitest';
import { RECEIVER_DEFS } from '../../../src/data/receivers';
import { minTimeLimit, OPEN_WORLD_PUZZLES, partElement, PUZZLES, isOpensReward } from '../../../src/data/puzzles';
import { regionAt } from '../../../src/data/worldLayout';

// Puzzle_Mechanism data (design "Puzzle_Mechanism 규칙", "오픈월드 퍼즐"; Req 13.1, 13.2, 13.6, 13.7, 10.2).

const MAIN_REGIONS = ['verdant', 'ember', 'azure'] as const;
/** Wren's largest Burst radius (8.5 m): sequence parts farther apart than twice this never take one hit together. */
const WIDEST_HIT = 8.5;

describe('puzzle data', () => {
  it('every sequence gives each step at least 5 s: timeLimitSec ≥ order.length × 5 (Req 13.6)', () => {
    const sequences = PUZZLES.filter((d) => d.kind === 'sequence');
    expect(sequences.length).toBeGreaterThan(0);
    for (const d of sequences) {
      const steps = d.order?.length ?? 0;
      expect(steps, d.id).toBeGreaterThan(0);
      expect(d.parts.length, d.id).toBeGreaterThanOrEqual(steps);
      expect(d.timeLimitSec ?? 0, d.id).toBeGreaterThanOrEqual(minTimeLimit(steps));
      expect(minTimeLimit(steps)).toBe(steps * 5);
    }
  });

  it('places the six open-world puzzles of the design table, two per main Region (Req 10.2)', () => {
    const table = OPEN_WORLD_PUZZLES.map((d) => ({
      id: d.id, region: d.region, kind: d.kind, devices: d.parts.map((p) => p.device), elements: d.parts.map((_, i) => partElement(d, i)),
    }));
    expect(table).toEqual([
      { id: 'pz_verdant_1', region: 'verdant', kind: 'allOf', devices: ['brazier', 'brazier', 'brazier'], elements: ['ember', 'ember', 'ember'] },
      { id: 'pz_verdant_2', region: 'verdant', kind: 'single', devices: ['windWheel'], elements: ['gale'] },
      { id: 'pz_ember_1', region: 'ember', kind: 'single', devices: ['heatCrystal'], elements: ['tide'] },
      { id: 'pz_ember_2', region: 'ember', kind: 'single', devices: ['unstableCrystal'], elements: ['ember'] },
      { id: 'pz_azure_1', region: 'azure', kind: 'sequence', devices: ['windWheel', 'windWheel', 'windWheel'], elements: ['gale', 'gale', 'gale'] },
      { id: 'pz_azure_2', region: 'azure', kind: 'weight', devices: ['pressurePlate', 'pressurePlate'], elements: ['terra', 'terra'] },
    ]);
    expect(OPEN_WORLD_PUZZLES.find((d) => d.id === 'pz_azure_1')?.timeLimitSec).toBe(15);
    for (const region of MAIN_REGIONS) expect(OPEN_WORLD_PUZZLES.filter((d) => d.region === region), region).toHaveLength(2);
  });

  it('ids follow pz_<region>_<n>, parts are uniquely named after their puzzle and stand inside its Region', () => {
    const ids = PUZZLES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const partIds = PUZZLES.flatMap((d) => d.parts.map((p) => p.id));
    expect(new Set(partIds).size).toBe(partIds.length);
    for (const d of OPEN_WORLD_PUZZLES) {
      expect(d.id).toMatch(new RegExp(`^pz_${d.region}_\\d+$`));
      for (const p of d.parts) {
        expect(p.id.startsWith(`${d.id}_`), p.id).toBe(true);
        expect(regionAt(p.pos), p.id).toBe(d.region);
      }
      if (isOpensReward(d.reward)) expect(regionAt(d.reward.at), d.id).toBe(d.region);
    }
  });

  it('every device part shows an Element its device reacts to (Req 13.2); plates show Terra for the stone pillar', () => {
    for (const d of PUZZLES) {
      d.parts.forEach((p, i) => {
        const element = partElement(d, i);
        if (p.device === 'arrival') return expect(element, p.id).toBeNull();
        if (p.device === 'pressurePlate') return expect(element, p.id).toBe('terra');
        expect(element, p.id).not.toBeNull();
        if (element !== null) expect(RECEIVER_DEFS[p.device].accepts, p.id).toContain(element);
      });
    }
  });

  it('kinds are well formed: single has one part, weight has a plate, only sequences carry an order', () => {
    for (const d of PUZZLES) {
      if (d.kind === 'single') expect(d.parts, d.id).toHaveLength(1);
      if (d.kind === 'weight') expect(d.parts.some((p) => p.device === 'pressurePlate'), d.id).toBe(true);
      if (d.kind !== 'sequence') expect([d.order, d.timeLimitSec], d.id).toEqual([undefined, undefined]);
    }
  });

  it('sequence parts stand far enough apart that one hit never rings two', () => {
    for (const d of PUZZLES.filter((x) => x.kind === 'sequence')) {
      for (const a of d.parts) {
        for (const b of d.parts) {
          if (a === b) continue;
          expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z), `${a.id}–${b.id}`).toBeGreaterThan(2 * WIDEST_HIT + a.radius + b.radius);
        }
      }
    }
  });

  it('each hint is one short line (Req 13.7)', () => {
    for (const d of PUZZLES) {
      expect(d.hint.trim().length, d.id).toBeGreaterThan(0);
      expect(d.hint, d.id).not.toMatch(/\n/);
      expect(d.hint.length, d.id).toBeLessThanOrEqual(40);
    }
  });
});

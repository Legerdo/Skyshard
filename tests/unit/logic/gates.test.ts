import { describe, expect, it } from 'vitest';
import { BARRIERS } from '../../../src/data/barriers';
import {
  altarPillarVisible, altarPromptText, altarStatus, barrierPromptText, isBarrierOpen, openBarrierIds, regionUnlocked, type WorldProgress,
} from '../../../src/logic/gates';

// Progress gates derived from GameState (task 4.5; Req 4.5, 4.6, 4.9, 5.2, 5.3, 2.7).
const at = (skyshards: number, altarActivated = false): WorldProgress => ({ skyshards, altarActivated });

describe('barrier derivation', () => {
  it('opens the ember pair at 1 Skyshard, the azure pair at 2 and the seal only with the activated altar', () => {
    expect(openBarrierIds(at(0))).toEqual([]);
    expect(openBarrierIds(at(1))).toEqual(['gate_ember', 'veil_ember']);
    expect(openBarrierIds(at(2))).toEqual(['gate_ember', 'gate_azure', 'veil_ember', 'veil_azure']);
    expect(openBarrierIds(at(3))).toEqual(['gate_ember', 'gate_azure', 'veil_ember', 'veil_azure']);
    expect(openBarrierIds(at(3, true))).toEqual(['gate_ember', 'gate_azure', 'veil_ember', 'veil_azure', 'seal_sanctum']);
  });

  it('opens each gate together with its veil', () => {
    for (let n = 0; n <= 3; n++) {
      for (const altar of [false, true]) {
        const p = at(n, altar);
        expect(isBarrierOpen('veil_ember', p)).toBe(isBarrierOpen('gate_ember', p));
        expect(isBarrierOpen('veil_azure', p)).toBe(isBarrierOpen('gate_azure', p));
      }
    }
  });

  it('gives the same result from equal progress, whatever happened before (load restores the same gates)', () => {
    expect(openBarrierIds({ ...at(2) })).toEqual(openBarrierIds(at(2)));
  });

  it('keeps a Region locked until all of its barriers are open', () => {
    expect(regionUnlocked('verdant', at(0))).toBe(true);
    expect(regionUnlocked('crater', at(0))).toBe(true);
    expect(regionUnlocked('ember', at(0))).toBe(false);
    expect(regionUnlocked('ember', at(1))).toBe(true);
    expect(regionUnlocked('azure', at(1))).toBe(false);
    expect(regionUnlocked('azure', at(2))).toBe(true);
    expect(regionUnlocked('sanctum', at(3))).toBe(false);
    expect(regionUnlocked('sanctum', at(3, true))).toBe(true);
  });
});

describe('prompt texts', () => {
  it('shows "Skyshard n/필요 수" at a closed gate (Req 4.9)', () => {
    expect(barrierPromptText(BARRIERS.gate_ember, at(0))).toBe('Skyshard 0/1');
    expect(barrierPromptText(BARRIERS.gate_azure, at(1))).toBe('Skyshard 1/2');
  });

  it('shows "Skyshard n/3" at the altar until all three are held, then the activation line (Req 5.2)', () => {
    expect(altarPromptText(at(0))).toBe('Skyshard 0/3');
    expect(altarPromptText(at(2))).toBe('Skyshard 2/3');
    expect(altarStatus(at(2))).toBe('charging');
    expect(altarStatus(at(3))).toBe('ready');
    expect(altarPromptText(at(3))).toBe('공명시키기');
    expect(altarStatus(at(3, true))).toBe('activated');
  });

  it('raises the light pillar from Skyshard 3 (Req 5.3)', () => {
    expect(altarPillarVisible(at(2))).toBe(false);
    expect(altarPillarVisible(at(3))).toBe(true);
    expect(altarPillarVisible(at(3, true))).toBe(true);
  });
});

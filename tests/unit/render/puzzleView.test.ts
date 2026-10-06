import type { Mesh, MeshLambertMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import { ELEMENT_DEFS } from '../../../src/data/elements';
import { OPEN_WORLD_PUZZLES, partElement } from '../../../src/data/puzzles';
import { TempPuzzleView } from '../../../src/render/tempPuzzleView';
import type { PuzzleView } from '../../../src/world/puzzleSystem';

// TEMPORARY Puzzle_Mechanism visuals (task 9.5), built in Node without a WebGL context.

/** Views of the open-world puzzles on flat ground, with one lit part and one solved puzzle. */
function views(): PuzzleView[] {
  return OPEN_WORLD_PUZZLES.map((def, i) => ({
    id: def.id, kind: def.kind, solved: i === 1, open: i === 1, opensAt: { x: 0, y: 0, z: 0 }, solvedAgo: i === 1 ? 0.5 : null,
    failFlash: 0, timeLeft: def.kind === 'sequence' ? 0.5 : null,
    parts: def.parts.map((p, j) => ({
      id: p.id, device: p.device, pos: { x: p.pos.x, y: 0, z: p.pos.z }, radius: p.radius, height: p.height,
      element: partElement(def, j), notches: def.kind === 'sequence' ? j + 1 : 0, active: j === 0, state: 'idle', present: true, telegraph: 0,
      body: true,
    })),
  }));
}

describe('TempPuzzleView', () => {
  it('draws every part with the Element icon it needs in that Element colour (Req 13.2)', () => {
    const view = new TempPuzzleView({ views });
    view.update(1.25);
    for (const def of OPEN_WORLD_PUZZLES) {
      def.parts.forEach((p, j) => {
        const element = partElement(def, j);
        const icon = view.object.getObjectByName(`puzzleIcon:${p.id}`) as Mesh | undefined;
        expect(icon, p.id).toBeDefined();
        if (element === null || icon === undefined) return;
        expect((icon.material as MeshLambertMaterial).color.getHex(), p.id).toBe(ELEMENT_DEFS[element].color);
      });
    }
    expect(view.object.getObjectByName('puzzleOpens:pz_verdant_2')?.visible).toBe(true);
    expect(view.object.getObjectByName('puzzleOpens:pz_verdant_1')?.visible).toBe(false);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });
});

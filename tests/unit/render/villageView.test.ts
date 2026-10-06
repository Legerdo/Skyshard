import { MeshToonMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import { SIDE_QUEST_FLAGS } from '../../../src/data/dialogue';
import { NPC_PLACEMENTS, VILLAGE_BUILDINGS } from '../../../src/data/village';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { villageLook } from '../../../src/logic/village';
import { TempVillageView } from '../../../src/render/tempVillageView';
import type { KiteState } from '../../../src/world/sideQuests';
import type { NpcView } from '../../../src/world/npcSystem';

// TEMPORARY Thistlewick view (tasks 13.1–13.3): the progress look and the NPCs mirrored from the simulation, built in
// Node without a WebGL context.

function setup() {
  const gs = createNewGameState(1);
  const kite: { state: KiteState } = { state: 'hanging' };
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const npcs: (Mutable<NpcView> & { pos: Vec3 })[] = NPC_PLACEMENTS.map((p) => ({
    id: p.id, pos: { x: p.home.x, y: 18, z: p.home.z }, yaw: p.yaw, anim: p.idle[0] ?? 'idle', present: true, talking: false,
  }));
  const view = new TempVillageView({
    village: { buildings: VILLAGE_BUILDINGS.map((def) => ({ def, baseY: 18 })), look: () => villageLook(gs) },
    npcs: { views: () => npcs },
    sideQuests: { kiteState: () => kite.state },
    heightAt: () => 18,
  });
  return { gs, kite, npcs, view };
}

const lit = (view: TempVillageView): boolean[] =>
  view.parts.lanternLamps.map((m) => ((m.material as MeshToonMaterial).emissiveIntensity > 0 && (m.material as MeshToonMaterial).emissive.getHex() !== 0));

describe('TempVillageView', () => {
  it('shows the Skyshard 0 village: lanterns out, wilted beds, the makeshift stand, Blight about, the kite on the windmill', () => {
    const { view } = setup();
    const p = view.parts;
    expect(lit(view).every((l) => !l)).toBe(true);
    expect([p.bunting.visible, p.garlands.visible, p.bedsBloom.visible, p.bedsWilted.visible]).toEqual([false, false, false, true]);
    expect([p.stallMakeshift.visible, p.stallRestored.visible]).toEqual([true, false]);
    expect([p.starLanterns.visible, p.festival.visible, p.blight.visible]).toEqual([false, false, true]);
    expect([p.villageKite.visible, p.windmillKite.visible, p.fieldFlowers.visible, p.smoke.visible]).toEqual([false, true, false, false]);
    view.dispose();
  });

  it('adds each stage cumulatively and follows the Side_Quest flags', () => {
    const { gs, kite, view } = setup();
    const p = view.parts;
    gs.skyshards = 1;
    view.update(1);
    expect(lit(view).every((l) => l)).toBe(true);
    expect([p.bunting.visible, p.garlands.visible, p.stallRestored.visible]).toEqual([true, false, false]);
    gs.skyshards = 2;
    view.update(2);
    expect([p.garlands.visible, p.bedsBloom.visible, p.bedsWilted.visible, p.stallRestored.visible, p.stallMakeshift.visible]).toEqual([true, true, false, true, false]);
    gs.skyshards = 3;
    view.update(3);
    expect([p.starLanterns.visible, p.festival.visible, p.bunting.visible]).toEqual([true, false, true]);
    gs.gameCompleted = true;
    view.update(4);
    expect([p.festival.visible, p.blight.visible, p.starLanterns.visible]).toEqual([true, false, true]);
    gs.world.flags[SIDE_QUEST_FLAGS.sq_tamsin] = true;
    gs.world.flags[SIDE_QUEST_FLAGS.sq_hobb] = true;
    gs.world.flags[SIDE_QUEST_FLAGS.sq_durga] = true;
    kite.state = 'flying';
    view.update(5);
    expect([p.villageKite.visible, p.windmillKite.visible, p.fieldFlowers.visible, p.smoke.visible]).toEqual([true, false, true, true]);
    expect((p.forgeGlow.material as MeshToonMaterial).emissive.getHex()).not.toBe(0);
    view.dispose();
  });

  it('draws each NPC where the NpcSystem puts it, facing its yaw, and hides a companion that joined', () => {
    const { npcs, view } = setup();
    const maren = npcs.find((n) => n.id === 'maren');
    if (maren === undefined) throw new Error('no maren');
    maren.pos.x += 3;
    maren.yaw = 1.2;
    maren.anim = 'walk';
    view.update(0.1);
    const obj = view.npcObject('maren');
    expect(obj?.position.x).toBeCloseTo(maren.pos.x, 9);
    expect(obj?.position.z).toBeCloseTo(maren.pos.z, 9);
    expect(obj?.rotation.y).toBeCloseTo(1.2, 9);
    const isla = npcs.find((n) => n.id === 'isla');
    if (isla === undefined) throw new Error('no isla');
    expect(view.npcObject('isla')?.visible).toBe(true);
    isla.present = false;
    view.update(0.2);
    expect(view.npcObject('isla')?.visible).toBe(false);
    view.dispose();
    expect(view.object.children).toHaveLength(0);
  });

  it('plays each NPC rig its animation state (Req 14.9), idle while talking, looking at the player within 8 m', () => {
    const { npcs, view } = setup();
    const hobb = npcs.find((n) => n.id === 'hobb')!;
    hobb.anim = 'hammer';
    view.update(1.0);
    expect(view.npcVisual('hobb')?.anim.animator?.current('base')).toBe('npc_work_hammer');
    hobb.talking = true;
    view.update(1.1);
    expect(view.npcVisual('hobb')?.anim.animator?.current('base')).toBe('npc_idle');
    // Companions before they join play the NPC clips on their hero rigs.
    expect(view.npcVisual('talus')?.anim.animator?.current('base')).toBe('npc_armsCrossed');
    view.dispose();
    const maren = NPC_PLACEMENTS.find((p) => p.id === 'maren')!;
    const player = { x: maren.home.x + 1, y: 18, z: maren.home.z + 3 };
    const near = setup();
    const looking = new TempVillageView({
      village: { buildings: [], look: () => villageLook(near.gs) },
      // Maren faces 30° off the player: inside the ±70° look range.
      npcs: { views: () => near.npcs.map((n) => ({ ...n, yaw: Math.atan2(player.x - n.pos.x, player.z - n.pos.z) + 0.5 })) },
      sideQuests: { kiteState: () => 'hanging' }, heightAt: () => 18,
      player: () => player,
    });
    for (let i = 1; i <= 30; i++) looking.update(i / 60);
    expect(looking.npcVisual('maren')?.anim.procedural?.lookAmount).toBe(1);
    looking.dispose();
    near.view.dispose();
  });
});

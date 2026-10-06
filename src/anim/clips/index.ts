/*
 * The clip library (design.md "포즈 클립과 샘플링": src/anim/clips/ per target — common.ts, kairen.ts · isla.ts · wren.ts
 * · talus.ts, enemies.ts, caelith.ts, npc.ts) and which clips each rig's Animator loads.
 */
import type { CharacterId } from '../../data/ids';
import type { PoseClip } from '../clip';
import { CAELITH_ATTACK_CLIPS, CAELITH_CLIP_LIST } from './caelith';
import { COMMON_CLIPS } from './common';
import { ENEMY_CLIP_SETS, ENEMY_CLIPS, type EnemyClipModel } from './enemies';
import { ISLA_CLIPS } from './isla';
import { KAIREN_CLIPS } from './kairen';
import { NPC_CLIPS } from './npc';
import { TALUS_CLIPS } from './talus';
import { WREN_CLIPS } from './wren';

export { CAELITH_ATTACK_CLIPS, CAELITH_CLIP_LIST, COMMON_CLIPS, ENEMY_CLIP_SETS, ENEMY_CLIPS, NPC_CLIPS };
export type { EnemyClipModel };

/** Each character's own attack / Skill / Burst clips (never shared, Req 22.6). */
export const CHARACTER_CLIPS: Readonly<Record<CharacterId, readonly PoseClip[]>> = {
  kairen: KAIREN_CLIPS,
  isla: ISLA_CLIPS,
  wren: WREN_CLIPS,
  talus: TALUS_CLIPS,
};

/** A hero rig's clips: the shared 20, its own attacks, and the NPC set (a companion before it joins). */
export function heroClips(id: CharacterId): readonly PoseClip[] {
  return [...COMMON_CLIPS, ...CHARACTER_CLIPS[id], ...NPC_CLIPS];
}

/** Every clip by name (names are unique across the library). */
export const CLIP_LIBRARY: ReadonlyMap<string, PoseClip> = (() => {
  const map = new Map<string, PoseClip>();
  const all = [...COMMON_CLIPS, ...Object.values(CHARACTER_CLIPS).flat(), ...ENEMY_CLIPS, ...CAELITH_CLIP_LIST, ...NPC_CLIPS];
  for (const clip of all) {
    const prior = map.get(clip.name);
    if (prior !== undefined && prior !== clip) throw new Error(`clip library: two clips named ${clip.name}`);
    map.set(clip.name, clip);
  }
  return map;
})();

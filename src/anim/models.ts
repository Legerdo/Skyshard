/*
 * Every procedural model by entity id (design.md "Visual Construction", Req 40.4): heroes (./heroes), enemies and Elites
 * (./enemyRigs), NPCs (./npcRigs) and Caelith (./caelithRig). The ProceduralVisualProvider builds from these.
 */
import { isCharacterId, isEliteId, isEnemyId, isNpcId, type VisualEntityId } from '../data/ids';
import { caelithRigSpec } from './caelithRig';
import { eliteRigSpec, enemyRigSpec } from './enemyRigs';
import { heroRigSpec } from './heroes';
import { npcRigSpec } from './npcRigs';
import type { RigSpec } from './rigTypes';

/** The procedural RigSpec of any VisualEntityId. */
export function modelRigSpec(id: VisualEntityId): RigSpec {
  if (isCharacterId(id)) return heroRigSpec(id);
  if (isEnemyId(id)) return enemyRigSpec(id);
  if (isEliteId(id)) return eliteRigSpec(id);
  if (isNpcId(id)) return npcRigSpec(id);
  return caelithRigSpec();
}

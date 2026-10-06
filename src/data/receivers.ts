// Environment Element receivers (design "환경 수신자", Req 13.1, 13.2, 13.8, 13.9). Pure data: which Element each
// device kind accepts (its surface shows that Element's icon and colour, or the Element its puzzle part names), its
// states and the hazard numbers.

import type { ElementId } from './ids';

export const RECEIVER_KINDS = [
  'brambleGate',
  'brazier',
  'heatCrystal',
  'fireObstacle',
  'windWheel',
  'crackedBoulder',
  'pressurePlate',
  'unstableCrystal',
  'elementPedestal',
] as const;
export type ReceiverKind = (typeof RECEIVER_KINDS)[number];

export interface ReceiverDef {
  kind: ReceiverKind;
  /** Korean device name. */
  name: string;
  /** Elements that work on it; the first is the icon shown on its surface (Req 13.2). Empty: weight only. */
  accepts: readonly ElementId[];
  /** A Charged_Attack hit works too (crackedBoulder). */
  chargedBreaks: boolean;
  /** State before any input. */
  initial: string;
  /** State after the accepted input. */
  done: string;
}

function def(
  kind: ReceiverKind,
  name: string,
  accepts: readonly ElementId[],
  initial: string,
  done: string,
  chargedBreaks = false,
): ReceiverDef {
  return { kind, name, accepts, chargedBreaks, initial, done };
}

export const RECEIVER_DEFS: Readonly<Record<ReceiverKind, ReceiverDef>> = {
  brambleGate: def('brambleGate', '가시덤불', ['ember'], 'intact', 'burnt'),
  brazier: def('brazier', '화로', ['ember'], 'unlit', 'lit'),
  heatCrystal: def('heatCrystal', '과열 수정', ['tide'], 'hot', 'cooled'),
  fireObstacle: def('fireObstacle', '불붙은 장애물', ['tide'], 'burning', 'extinguished'),
  windWheel: def('windWheel', '바람개비', ['gale'], 'still', 'spinning'),
  crackedBoulder: def('crackedBoulder', '금 간 바위', ['terra'], 'intact', 'broken', true),
  pressurePlate: def('pressurePlate', '압력판', [], 'up', 'down'),
  unstableCrystal: def('unstableCrystal', '불안정 수정', ['ember'], 'stable', 'exploded'),
  // Starfall Observatory's star pedestals (pz_observatory_1): each takes any Element and lights; which one it should
  // take, and when, is the sequence puzzle's order, so a wrong Element is a wrong step rather than a rejected input.
  elementPedestal: def('elementPedestal', '별자리 받침대', ['ember', 'tide', 'gale', 'terra'], 'dark', 'lit'),
};

/** A Tide-cooled Heat_Crystal stays cool, harmless and climbable this long (Req 13.8). */
export const HEAT_CRYSTAL_COOL_SECONDS = 10;
/** With this little of its cooling left a Heat_Crystal flashes orange (design Cinderspire H1). */
export const HEAT_CRYSTAL_WARNING_SECONDS = 2;

/**
 * Unstable_Crystal blast (Req 13.9): `telegraph` s after Ember it explodes, hitting enemies and the
 * Player_Character within `radius` m for computeDamage kind 'hazard' (ATK `atk` at level 1, × dmgMul).
 */
export const UNSTABLE_CRYSTAL = { telegraph: 1, radius: 4, atk: 120, dmgMul: 1, poise: 40, knockback: 3 } as const;

// Element display and mark-effect data (design "Element_Mark 상태", Req 25.1, 25.4).
// Pure data. Every Element differs in both icon shape and colour, so marks never rely on colour alone.

import { ELEMENT_IDS, ELEMENT_NAMES, type ElementId } from './ids';
import { MARK_EFFECTS, type MarkEffect } from './reactions';

/** Icon silhouettes drawn above HP bars, on receivers and in the HUD. */
export type ElementIconShape = 'triFlame' | 'ringWaves' | 'spiral' | 'hexCrystal';

export interface ElementDef {
  id: ElementId;
  /** "Ember·불꽃" style display name. */
  name: string;
  icon: ElementIconShape;
  /** Korean description of the icon shape (codex, accessibility text). */
  iconLabel: string;
  /** 0xRRGGBB. */
  color: number;
  /** Same colour as a CSS hex string. */
  cssColor: string;
  /** Effect while the mark is held (Req 25.4). */
  markEffect: MarkEffect;
}

const css = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

function def(id: ElementId, icon: ElementIconShape, iconLabel: string, color: number): ElementDef {
  return { id, name: ELEMENT_NAMES[id], icon, iconLabel, color, cssColor: css(color), markEffect: MARK_EFFECTS[id] };
}

export const ELEMENT_DEFS: Readonly<Record<ElementId, ElementDef>> = {
  ember: def('ember', 'triFlame', '세 갈래 불꽃', 0xff7a45),
  tide: def('tide', 'ringWaves', '겹친 물결 원', 0x3fa7f5),
  gale: def('gale', 'spiral', '나선', 0x5ed3a5),
  terra: def('terra', 'hexCrystal', '육각 결정', 0xd9a441),
};

/** ELEMENT_DEFS in ELEMENT_IDS order. */
export const ELEMENT_LIST: readonly ElementDef[] = ELEMENT_IDS.map((id) => ELEMENT_DEFS[id]);

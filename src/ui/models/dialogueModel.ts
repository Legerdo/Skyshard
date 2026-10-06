/*
 * What the Dialogue screen draws for the open window (design "Dialogue_System", task 13.1; Req 14.4, 14.6): the
 * speaker's name plate, the text typed so far (the rest is laid out but hidden, so the window never reflows while
 * typing), the window counter, and once the window is complete the "next" mark with the advance keys as currently
 * bound (F · Space · 좌클릭 by default). Pure: no DOM, so it runs in Node tests.
 */
import type { DialogueView } from '../../dialogue/dialogueSystem';
import { DIALOGUE_RULES, type Speaker } from '../../data/dialogue';
import { isNpcId } from '../../data/ids';

/** Name plate colour per speaker: the companions in their Element colour, the villagers in earthy tones. */
export const SPEAKER_PLATE_COLOR: Readonly<Record<Speaker, string>> = {
  maren: '#9DBB7A', pip: '#E3B062', bram: '#C2B29E', tamsin: '#EFA9BC', hobb: '#CFAF6A', durga: '#E08A5E', oriel: '#8FA6E6',
  kairen: '#FF7A45', isla: '#3FA7F5', wren: '#5ED3A5', talus: '#D9A441',
};

export interface DialogueWindowModel {
  readonly speaker: Speaker;
  readonly name: string;
  /** A companion (party member) or a named NPC. */
  readonly role: 'npc' | 'companion';
  readonly plateColor: string;
  /** Typed so far, and the rest of the window's text (hidden). */
  readonly shown: string;
  readonly hidden: string;
  /** The whole window text, for assistive technology (announced once per window). */
  readonly full: string;
  /** "2 / 4": the window and the count. */
  readonly counter: string;
  /** Whether the next advance moves on ('next' / 'end') or completes the typing ('typing'). */
  readonly state: 'typing' | 'next' | 'end';
  /** The advance hint once the window is complete, e.g. "F · Space · 좌클릭 다음" / "… 닫기"; null while typing. */
  readonly hint: string | null;
}

/** The window model for `view`; `keys` are the advance keys' labels as bound now. */
export function dialogueWindowModel(view: DialogueView, keys: readonly string[]): DialogueWindowModel {
  const visible = Math.max(0, Math.min(view.text.length, view.visible));
  const last = view.line + 1 >= view.count;
  const state = !view.complete ? 'typing' : last ? 'end' : 'next';
  const keyText = [...new Set(keys.filter((k) => k.length > 0))].join(' · ');
  return {
    speaker: view.speaker,
    name: view.speakerName,
    role: isNpcId(view.speaker) ? 'npc' : 'companion',
    plateColor: SPEAKER_PLATE_COLOR[view.speaker],
    shown: view.text.slice(0, visible),
    hidden: view.text.slice(visible),
    full: view.text,
    counter: `${view.line + 1} / ${view.count}`,
    state,
    hint: state === 'typing' ? null : `${keyText} ${state === 'end' ? '닫기' : '다음'}`.trim(),
  };
}

/** Lines of text a window of `text` needs at `charsPerLine` (the window shows at most DIALOGUE_RULES.maxLines). */
export function windowLines(text: string, charsPerLine = DIALOGUE_RULES.maxTextLength / DIALOGUE_RULES.maxLines): number {
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

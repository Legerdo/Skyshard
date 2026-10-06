import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, NPC_IDS } from '../../../src/data/ids';
import type { DialogueView } from '../../../src/dialogue/dialogueSystem';
import { dialogueWindowModel, SPEAKER_PLATE_COLOR, windowLines } from '../../../src/ui/models/dialogueModel';

// The Dialogue screen's window model (task 13.1; Req 14.4, 14.6).

const view = (over: Partial<DialogueView> = {}): DialogueView => ({
  dialogueId: 'dlg_maren_ms1_maren', npc: 'maren', speaker: 'maren', speakerName: 'Elder Maren', text: '먼 길을 온 방랑자로군.',
  visible: 4, complete: false, line: 0, count: 3, ...over,
});
const KEYS = ['F', 'Space', '좌클릭'];

describe('dialogueWindowModel', () => {
  it('splits the typed part from the hidden rest and shows no hint while typing', () => {
    const m = dialogueWindowModel(view(), KEYS);
    expect(m.shown + m.hidden).toBe(view().text);
    expect(m.shown).toBe('먼 길을');
    expect(m).toMatchObject({ name: 'Elder Maren', role: 'npc', counter: '1 / 3', state: 'typing', hint: null, full: view().text });
  });

  it('once complete: "다음" with the bound keys, and "닫기" on the last window', () => {
    const text = view().text;
    expect(dialogueWindowModel(view({ visible: text.length, complete: true }), KEYS)).toMatchObject({ state: 'next', hint: 'F · Space · 좌클릭 다음', hidden: '' });
    expect(dialogueWindowModel(view({ visible: text.length, complete: true, line: 2 }), ['G', 'G', '좌클릭']).hint).toBe('G · 좌클릭 닫기');
  });

  it('marks companions and gives every speaker a name plate colour', () => {
    expect(dialogueWindowModel(view({ speaker: 'isla', speakerName: 'Isla' }), KEYS).role).toBe('companion');
    for (const id of [...NPC_IDS, ...CHARACTER_IDS]) expect(SPEAKER_PLATE_COLOR[id]).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('a window of 90 characters takes the full three lines at 30 per line', () => {
    expect(windowLines('가'.repeat(90))).toBe(3);
    expect(windowLines('가'.repeat(31))).toBe(2);
  });
});

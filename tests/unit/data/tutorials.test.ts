import { describe, expect, it } from 'vitest';
import { GAME_EVENT_NAMES } from '../../../src/core/gameEvents';
import { INPUT_ACTIONS } from '../../../src/input/actions';
import { DEFAULT_BINDINGS } from '../../../src/input/bindings';
import { NPC_PLACEMENTS } from '../../../src/data/village';
import {
  CONTROLLER_DONE_EVENTS, FIRST_TEN_MINUTE_HINTS, HINT_TEXT_MAX, REQUIRED_GUIDANCE, TUTORIAL_ANCHORS, TUTORIAL_HINT_IDS,
  TUTORIAL_HINTS, tutorialHint,
} from '../../../src/data/tutorials';
import { HINT_MAX_LINES, hintLines } from '../../../src/logic/tutorial';
import { hintKeyLabels } from '../../../src/tutorial/hintKeys';

// Tutorial_Hint data (design "Tutorial_System" table; Req 34.1, 34.3).

describe('Tutorial_Hint data', () => {
  it('defines the 20 hints tut_move … tut_puzzle in the design table order, with unique ids', () => {
    expect(TUTORIAL_HINT_IDS).toEqual([
      'tut_move', 'tut_camera', 'tut_jump', 'tut_interact', 'tut_attack', 'tut_dodge', 'tut_switch', 'tut_skill',
      'tut_reaction', 'tut_burst', 'tut_sprint', 'tut_climb', 'tut_glide', 'tut_map', 'tut_waystone', 'tut_lockon',
      'tut_heal', 'tut_equipment', 'tut_upgrade', 'tut_puzzle',
    ]);
    expect(new Set(TUTORIAL_HINT_IDS).size).toBe(20);
    for (const id of TUTORIAL_HINT_IDS) expect(tutorialHint(id)?.id).toBe(id);
    expect(tutorialHint('tut_unknown')).toBeNull();
  });

  it("covers every one of Req 34.1's 17 guidance items with a hint", () => {
    const items = ['이동', '카메라', '점프', '질주', '상호작용', '공격', 'Dodge', '캐릭터 교체', 'Skill', 'Burst', 'Reaction', '등반', '활강', '지도',
      'Waystone', '장비', '능력 강화'];
    expect(Object.keys(REQUIRED_GUIDANCE).sort()).toEqual([...items].sort());
    const hints = Object.values(REQUIRED_GUIDANCE);
    expect(new Set(hints).size).toBe(17);
    for (const id of hints) expect(TUTORIAL_HINT_IDS).toContain(id);
    // The three extra hints are the design's additions.
    expect(TUTORIAL_HINT_IDS.filter((id) => !hints.includes(id))).toEqual(['tut_lockon', 'tut_heal', 'tut_puzzle']);
  });

  it("lists Req 34.2's ten first-10-minute controls, all taught by hints", () => {
    expect(FIRST_TEN_MINUTE_HINTS).toHaveLength(10);
    for (const id of FIRST_TEN_MINUTE_HINTS) expect(TUTORIAL_HINT_IDS).toContain(id);
  });

  it('keeps every text within 40 characters and 2 card lines, Korean with English proper nouns', () => {
    for (const h of TUTORIAL_HINTS) {
      expect(h.text.length, h.id).toBeGreaterThan(0);
      expect(h.text.length, `${h.id}: ${h.text}`).toBeLessThanOrEqual(HINT_TEXT_MAX);
      const lines = hintLines(h.text);
      expect(lines.length, h.id).toBeLessThanOrEqual(HINT_MAX_LINES);
      for (const line of lines) expect(line.length, `${h.id}: ${line}`).toBeLessThanOrEqual(24);
      expect(/[가-힣]/.test(h.text), h.id).toBe(true);
      // No hard-coded default key names: the keys come from the bindings as icons.
      expect(h.text, h.id).not.toMatch(/WASD|Space|Shift|좌클릭|우클릭|\b[A-Z]키|\b[EQFRZIMC]로/);
    }
  });

  it('shows at least one key per hint and only actions that have keys', () => {
    const actions = new Set<string>(INPUT_ACTIONS);
    for (const h of TUTORIAL_HINTS) {
      expect(h.actions.length, h.id).toBeGreaterThan(0);
      for (const a of h.actions) expect(actions.has(a), `${h.id}: ${a}`).toBe(true);
      expect(hintKeyLabels(h.actions, DEFAULT_BINDINGS).length, h.id).toBeGreaterThan(0);
      if (h.doneWhen.kind === 'action') for (const a of h.doneWhen.actions) expect(actions.has(a), `${h.id}: ${a}`).toBe(true);
    }
  });

  it('uses the four trigger kinds with valid targets and done events', () => {
    const kinds = new Set(TUTORIAL_HINTS.map((h) => h.trigger.kind));
    expect([...kinds].sort()).toEqual(['event', 'near', 'signal', 'start']);
    const npcs = new Set<string>(NPC_PLACEMENTS.map((n) => n.id));
    const events = new Set<string>(GAME_EVENT_NAMES);
    const doneEvents = new Set<string>([...GAME_EVENT_NAMES, ...CONTROLLER_DONE_EVENTS]);
    for (const h of TUTORIAL_HINTS) {
      const t = h.trigger;
      if (t.kind === 'start') expect(t.delay, h.id).toBeGreaterThanOrEqual(0);
      if (t.kind === 'near') {
        expect(t.radius, h.id).toBeGreaterThan(0);
        expect(t.targetId in TUTORIAL_ANCHORS || npcs.has(t.targetId), `${h.id}: ${t.targetId}`).toBe(true);
      }
      if (t.kind === 'event') expect(events.has(t.event), `${h.id}: ${t.event}`).toBe(true);
      if (h.doneWhen.kind === 'event') expect(doneEvents.has(h.doneWhen.event), `${h.id}: ${h.doneWhen.event}`).toBe(true);
    }
    // The first-10-minute placement of the design timeline.
    expect(tutorialHint('tut_move')?.trigger).toEqual({ kind: 'start', delay: 0 });
    expect(tutorialHint('tut_camera')?.trigger).toEqual({ kind: 'start', delay: 3 });
    expect(tutorialHint('tut_jump')?.trigger).toEqual({ kind: 'near', targetId: 'plaza_step', radius: 3 });
    expect(tutorialHint('tut_interact')?.trigger).toEqual({ kind: 'near', targetId: 'maren', radius: 2.5 });
    expect(tutorialHint('tut_reaction')?.actions).toContain('switch2'); // Isla's switch key (Req 34.6)
  });

  it('puts the plaza step between the village entrance and Elder Maren, and the field on the Breezewatch road', () => {
    const maren = NPC_PLACEMENTS.find((n) => n.id === 'maren');
    expect(maren).toBeDefined();
    const step = TUTORIAL_ANCHORS.plaza_step;
    const field = TUTORIAL_ANCHORS.breezewatch_field;
    // Within the village pad (22 m) and short of the plaza centre.
    expect(Math.hypot(step.x - -250, step.z - 300)).toBeLessThan(12);
    expect(Math.hypot(step.x - -250, step.z - 300)).toBeGreaterThan(5);
    // Outside the 40 m village area, not over the ms1 raid field or the watchtower.
    expect(Math.hypot(field.x - -250, field.z - 300)).toBeGreaterThan(40);
    expect(Math.hypot(field.x - -200, field.z - 320)).toBeGreaterThan(16 + 10);
    expect(Math.hypot(field.x - -220, field.z - 332)).toBeGreaterThan(16 + 10);
  });
});

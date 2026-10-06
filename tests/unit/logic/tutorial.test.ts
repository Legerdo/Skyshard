import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TUTORIAL_HINT_IDS, TUTORIAL_HINTS } from '../../../src/data/tutorials';
import {
  completedHints, emptyTutorialQueue, enqueueHint, HINT_GAP_SECONDS, HINT_MAX_LINES, HINT_MIN_SHOW_SECONDS, HINT_SHOW_SECONDS, hintLines,
  stepTutorial,
  type TutorialQueue, type TutorialStepInput,
} from '../../../src/logic/tutorial';

// Tutorial_Hint queue and timer (design "Tutorial_System"; Req 34.3–34.5).

const DT = 1 / 60;
const ORDER: readonly string[] = TUTORIAL_HINT_IDS;

/** A tiny driver: completed ids are recorded in `completed` as the adapter does. */
function driver() {
  let q: TutorialQueue = emptyTutorialQueue();
  const completed: string[] = [];
  const shown: string[] = [];
  const step = (over: Partial<TutorialStepInput> = {}) => {
    const r = stepTutorial(q, { dt: DT, suppressed: false, done: false, completed, order: ORDER, ...over });
    q = r.queue;
    if (r.completed !== null) completed.push(r.completed);
    if (r.shown !== null) shown.push(r.shown);
    return r;
  };
  const run = (seconds: number, over: Partial<TutorialStepInput> = {}) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) step(over);
  };
  return {
    get q() {
      return q;
    },
    completed,
    shown,
    enqueue: (id: string) => {
      q = enqueueHint(q, id, completed);
    },
    step,
    run,
  };
}

describe('Tutorial_Hint queue', () => {
  it('shows only the waiting hint earliest in display order, one at a time', () => {
    const d = driver();
    d.enqueue('tut_skill');
    d.enqueue('tut_attack');
    d.enqueue('tut_reaction');
    d.step();
    expect(d.q.current).toBe('tut_attack');
    expect(d.q.pending).toEqual(['tut_skill', 'tut_reaction']);
    // A later-ordered hint triggered meanwhile waits.
    d.enqueue('tut_burst');
    d.run(3);
    expect(d.q.current).toBe('tut_attack');
    d.step({ done: true });
    expect(d.completed).toEqual(['tut_attack']);
    expect(d.q.current).toBeNull();
    d.run(HINT_GAP_SECONDS / 2);
    expect(d.q.current).toBeNull(); // the short gap between cards
    d.run(HINT_GAP_SECONDS / 2 + DT);
    expect(d.q.current).toBe('tut_skill');
    expect(d.shown).toEqual(['tut_attack', 'tut_skill']);
  });

  it('lets an earlier-ordered hint take over after 1.5 s; the displaced one returns for the rest of its 8 s', () => {
    const d = driver();
    d.enqueue('tut_map');
    d.step();
    d.run(0.5);
    d.enqueue('tut_glide'); // Wren joins while the map hint shows
    d.run(HINT_MIN_SHOW_SECONDS - 0.5 - 2 * DT);
    expect(d.q.current).toBe('tut_map');
    d.run(3 * DT);
    expect(d.q.current).toBe('tut_glide');
    expect(d.q.pending).toEqual(['tut_map']);
    const mapShown = d.q.shownBefore.tut_map ?? 0;
    expect(mapShown).toBeCloseTo(HINT_MIN_SHOW_SECONDS, 1);
    d.step({ done: true });
    expect(d.completed).toEqual(['tut_glide']);
    d.run(HINT_GAP_SECONDS + DT);
    expect(d.q.current).toBe('tut_map');
    expect(d.q.shownFor).toBeCloseTo(mapShown, 1);
    d.run(HINT_SHOW_SECONDS - mapShown - 0.1);
    expect(d.q.current).toBe('tut_map');
    d.run(0.2);
    expect(d.completed).toEqual(['tut_glide', 'tut_map']);
    expect(d.shown).toEqual(['tut_map', 'tut_glide', 'tut_map']);
  });

  it('closes on its action the same tick and records it; a completed hint never queues again', () => {
    const d = driver();
    d.enqueue('tut_jump');
    d.step();
    const r = d.step({ done: true });
    expect(r.completed).toBe('tut_jump');
    expect(d.completed).toEqual(['tut_jump']);
    d.enqueue('tut_jump');
    expect(d.q.pending).toEqual([]);
    d.run(10);
    expect(d.shown).toEqual(['tut_jump']);
  });

  it('closes by itself after 8 s on screen', () => {
    const d = driver();
    d.enqueue('tut_camera');
    d.step();
    d.run(HINT_SHOW_SECONDS - 0.1);
    expect(d.q.current).toBe('tut_camera');
    d.run(0.2);
    expect(d.q.current).toBeNull();
    expect(d.completed).toEqual(['tut_camera']);
  });

  it('while suppressed shows nothing and stops the 8 s timer, then shows the rest of the time', () => {
    const d = driver();
    d.enqueue('tut_move');
    d.step();
    d.run(5);
    const shownFor = d.q.shownFor;
    d.run(30, { suppressed: true });
    expect(d.q.current).toBe('tut_move');
    expect(d.q.shownFor).toBe(shownFor);
    // A hint triggered during the cinematic waits; nothing new shows while suppressed.
    d.enqueue('tut_attack');
    d.run(2, { suppressed: true });
    expect(d.shown).toEqual(['tut_move']);
    d.run(HINT_SHOW_SECONDS - 5 - 0.1);
    expect(d.q.current).toBe('tut_move');
    d.run(0.2);
    expect(d.completed).toEqual(['tut_move']);
    d.run(HINT_GAP_SECONDS + DT);
    expect(d.q.current).toBe('tut_attack');
  });

  it('does not show a new hint while suppressed, and a queued hint completed elsewhere is dropped', () => {
    const d = driver();
    d.enqueue('tut_move');
    d.run(1, { suppressed: true });
    expect(d.q.current).toBeNull();
    d.completed.push('tut_move'); // e.g. a load that already has it
    d.run(1);
    expect(d.q.current).toBeNull();
    expect(d.q.pending).toEqual([]);
  });

  it('property: one hint at a time, never a completed one again, at most 8 s on screen in total, only earlier ones take over', () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('trigger' as const), id: fc.constantFrom(...ORDER) }),
      fc.record({ kind: fc.constant('tick' as const), done: fc.boolean(), suppressed: fc.boolean(), dt: fc.double({ min: 0, max: 3, noNaN: true }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 200 }), (ops) => {
        const d = driver();
        const onScreen = new Map<string, number>();
        for (const o of ops) {
          if (o.kind === 'trigger') d.enqueue(o.id);
          else {
            const before = d.q.current;
            const r = d.step({ done: o.done, suppressed: o.suppressed, dt: o.dt });
            if (r.completed !== null) {
              expect(r.completed).toBe(before);
              expect(r.shown).toBeNull();
            }
            if (before !== null && !o.suppressed && r.completed === null) {
              onScreen.set(before, (onScreen.get(before) ?? 0) + o.dt);
            }
            // A takeover only by a hint earlier in display order, never while hidden.
            if (r.shown !== null && before !== null) {
              expect(o.suppressed).toBe(false);
              expect(ORDER.indexOf(r.shown)).toBeLessThan(ORDER.indexOf(before));
            }
          }
          expect(new Set(d.completed).size).toBe(d.completed.length);
          if (d.q.current !== null) {
            expect(d.completed).not.toContain(d.q.current);
            expect(d.q.pending).not.toContain(d.q.current);
            expect(d.q.shownFor).toBeLessThan(HINT_SHOW_SECONDS);
          }
          for (const id of d.q.pending) expect(d.completed).not.toContain(id);
        }
        for (const [id, seconds] of onScreen) if (!d.completed.includes(id)) expect(seconds, id).toBeLessThan(HINT_SHOW_SECONDS + 1e-6);
      }),
      { numRuns: 300 },
    );
  });
});

describe('hint lines and the completed list', () => {
  it('breaks a text into at most 2 lines at the space nearest the middle', () => {
    expect(hintLines('짧은 안내')).toEqual(['짧은 안내']);
    expect(hintLines('Ember 표식이 있는 적에게 Isla로 교체해 증기 폭발을 일으키세요')).toEqual([
      'Ember 표식이 있는 적에게', 'Isla로 교체해 증기 폭발을 일으키세요',
    ]);
    const noSpace = '가'.repeat(30);
    expect(hintLines(noSpace)).toEqual(['가'.repeat(15), '가'.repeat(15)]);
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const lines = hintLines(s);
        expect(lines.length).toBeLessThanOrEqual(HINT_MAX_LINES);
        expect(lines.join(' ').replace(/\s+/g, '')).toBe(s.trim().replace(/\s+/g, ''));
      }),
    );
  });

  it('lists completed hints for "조작 안내 보기" in display order, skipping unknown ids', () => {
    const list = completedHints({ tutorials: ['tut_glide', 'tut_move', 'tut_nonexistent', 'tut_attack'] });
    expect(list.map((h) => h.id)).toEqual(['tut_move', 'tut_attack', 'tut_glide']);
    expect(completedHints({ tutorials: [] })).toEqual([]);
    expect(completedHints({ tutorials: [...TUTORIAL_HINT_IDS].reverse() })).toEqual([...TUTORIAL_HINTS]);
  });
});

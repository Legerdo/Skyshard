import './dialogueScreen.css';
import type { DialogueView } from '../dialogue/dialogueSystem';
import { h } from './dom';
import { dialogueWindowModel, type DialogueWindowModel } from './models/dialogueModel';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';

export interface DialogueScreenOptions {
  /** The window open now (PlaySim.dialogue.view()); null once the dialogue closed. */
  view(): DialogueView | null;
  /** Labels of the advance keys as currently bound (interact, jump, attack: F · Space · 좌클릭 by default). */
  keys(): readonly string[];
}

/*
 * Dialogue screen (design "Dialogue_System", task 13.1; Req 14.4, 14.6): the speaker's name plate over a window of at
 * most three lines at the bottom of the screen, the text typing at 45 characters per second, the window counter and,
 * once a window is complete, the "next" mark with the advance keys. `dialogue` context: the input context lets only
 * the advance actions (and pause) through and PauseMode 'dialogue' freezes the enemies (main.ts applyContext).
 *
 * The Dialogue_System (src/dialogue/dialogueSystem.ts) owns the playing dialogue and reads the advance presses in
 * the fixed tick; this screen only draws its view() every frame. It consumes every navigation input (Esc / B does not
 * close a dialogue) and never takes pointer input, so a left click reaches the game as the advance `attack`.
 * The typed part is decorative (aria-hidden); each window's whole text is announced once in a polite live region.
 */
export class DialogueScreen implements Screen {
  readonly id = 'dialogue';
  readonly context = 'dialogue';
  private readonly options: DialogueScreenOptions;
  private readonly root: HTMLElement;
  private readonly plate: HTMLElement;
  private readonly shown: HTMLElement;
  private readonly rest: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly live: HTMLElement;
  /** Last drawn state, so unchanged frames touch no DOM. */
  private drawn: DialogueWindowModel | null = null;
  private announced = '';

  constructor(options: DialogueScreenOptions) {
    this.options = options;
    this.plate = h('div', { class: 'dialogue-window__name' });
    this.shown = h('span', { class: 'dialogue-window__shown' });
    this.rest = h('span', { class: 'dialogue-window__rest' });
    this.counter = h('span', { class: 'dialogue-window__counter' });
    this.hint = h('span', { class: 'dialogue-window__hint' });
    this.live = h('p', { class: 'dialogue-window__live', 'aria-live': 'polite' });
    this.root = h('div', { class: 'dialogue-screen', role: 'dialog', 'aria-label': '대화' }, [
      h('section', { class: 'dialogue-window' }, [
        this.plate,
        h('p', { class: 'dialogue-window__text', 'aria-hidden': 'true' }, [this.shown, this.rest]),
        h('div', { class: 'dialogue-window__footer', 'aria-hidden': 'true' }, [this.counter, this.hint]),
        this.live,
      ]),
    ]);
  }

  mount(root: HTMLElement): void {
    this.drawn = null;
    this.announced = '';
    root.append(this.root);
    this.update();
  }

  unmount(): void {
    this.root.remove();
  }

  /** Every navigation input is consumed: the dialogue advances through the game's own input, not the menu keys. */
  onInput(_nav: NavInput): boolean {
    return true;
  }

  focusables(): readonly HTMLElement[] {
    return [];
  }

  update(): void {
    const view = this.options.view();
    if (view === null) return; // closing: the owner pops the screen
    const m = dialogueWindowModel(view, this.options.keys());
    const prev = this.drawn;
    this.drawn = m;
    if (prev?.name !== m.name || prev.plateColor !== m.plateColor || prev.role !== m.role) {
      this.plate.textContent = m.name;
      this.plate.style.setProperty('--speaker', m.plateColor);
      this.plate.dataset.role = m.role;
    }
    if (prev?.shown !== m.shown || prev.hidden !== m.hidden) {
      this.shown.textContent = m.shown;
      this.rest.textContent = m.hidden;
    }
    if (prev?.counter !== m.counter) this.counter.textContent = m.counter;
    if (prev?.hint !== m.hint || prev.state !== m.state) {
      this.hint.textContent = m.hint ?? '';
      this.hint.dataset.state = m.state;
    }
    const line = `${m.name}: ${m.full}`;
    if (line !== this.announced) {
      this.announced = line;
      this.live.textContent = line;
    }
  }
}

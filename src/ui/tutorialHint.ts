import './tutorialHint.css';
import type { Bindings } from '../input/bindings';
import type { TutorialHintDef } from '../data/tutorials';
import { hintLines } from '../logic/tutorial';
import { hintKeyLabels } from '../tutorial/hintKeys';

/*
 * Tutorial_Hint card (design HUD "Tutorial_Hint", Req 34.3): one hint at a time in a box above the Skill / Burst
 * icons, at most 2 lines of text beside key icons built from the CURRENT bindings. The card is rebuilt whenever the
 * hint or the bound keys change (a remap in Settings redraws it at once) and is hidden while there is no hint or a
 * cinematic, menu or dialogue suppresses it (the Tutorial_System returns null then). Announced politely to assistive
 * technology; it never takes pointer input.
 *
 * `buildHintCard` is the same card without the HUD placement, for the Settings "조작 안내 보기" list.
 */

/** A hint card element: key caps and the text in at most two lines. */
export function buildHintCard(def: TutorialHintDef, bindings: Readonly<Bindings>, className = 'tutorial-card'): HTMLElement {
  const card = document.createElement('div');
  card.className = className;
  fillHintCard(card, def, bindings);
  return card;
}

function fillHintCard(card: HTMLElement, def: TutorialHintDef, bindings: Readonly<Bindings>): void {
  const labels = hintKeyLabels(def.actions, bindings);
  const keys = document.createElement('div');
  keys.className = 'tutorial-card__keys';
  keys.dataset.count = String(labels.length);
  keys.setAttribute('aria-hidden', 'true');
  for (const label of labels) {
    const key = document.createElement('kbd');
    key.className = 'tutorial-card__key';
    if (label.length > 2) key.classList.add('is-wide');
    key.textContent = label;
    keys.append(key);
  }
  const text = document.createElement('p');
  text.className = 'tutorial-card__text';
  for (const line of hintLines(def.text)) {
    const span = document.createElement('span');
    span.className = 'tutorial-card__line';
    span.textContent = line;
    text.append(span);
  }
  // Screen readers get the keys and the sentence in one go.
  card.setAttribute('aria-label', labels.length > 0 ? `${labels.join(', ')}: ${def.text}` : def.text);
  card.replaceChildren(keys, text);
}

export class TutorialHintView {
  private readonly root: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private shown: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tutorial-hint';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.card = document.createElement('div');
    this.card.className = 'tutorial-card tutorial-hint__card';
    this.root.append(this.card);
    parent.append(this.root);
  }

  /** Shows `hint` with keys from `bindings`, or hides the card for null. Writes the DOM only when either changes. */
  update(hint: TutorialHintDef | null, bindings: Readonly<Bindings>): void {
    const signature = hint === null ? null : `${hint.id}|${hintKeyLabels(hint.actions, bindings).join('\u0001')}`;
    if (signature === this.shown) return;
    const fresh = hint !== null && (this.shown === null || this.shown.split('|')[0] !== hint.id);
    this.shown = signature;
    if (hint === null) {
      this.root.hidden = true;
      return;
    }
    fillHintCard(this.card, hint, bindings);
    this.root.hidden = false;
    if (fresh) {
      // Restart the entrance animation for a new hint (not for a key remap of the same one).
      this.root.classList.remove('is-entering');
      void this.root.offsetWidth;
      this.root.classList.add('is-entering');
    }
  }
}

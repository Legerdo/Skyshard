import './interactPrompt.css';
import type { InteractPrompt } from '../player/interaction';

/*
 * Interaction prompt (design "HUD" layout: 320×48 right of the screen centre; Req 14.3, 4.9, 5.2): the key
 * bound to `interact` (from the current bindings, so a remap shows at once), the target's name and its status
 * line ("Skyshard 1/2"). Hidden when nothing is in reach. Written to the DOM only when its content changes.
 * Announced politely to assistive technology; it never takes pointer input.
 */
export class InteractPromptView {
  private readonly root: HTMLDivElement;
  private readonly key: HTMLElement;
  private readonly name: HTMLSpanElement;
  private readonly detail: HTMLSpanElement;
  private shown: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'interact-prompt';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.hidden = true;
    this.key = document.createElement('kbd');
    this.key.className = 'interact-prompt__key';
    const text = document.createElement('div');
    text.className = 'interact-prompt__text';
    this.name = document.createElement('span');
    this.name.className = 'interact-prompt__name';
    this.detail = document.createElement('span');
    this.detail.className = 'interact-prompt__detail';
    text.append(this.name, this.detail);
    this.root.append(this.key, text);
    parent.append(this.root);
  }

  /** Shows `prompt` with `keyLabel` as the key, or hides the prompt for null. */
  set(prompt: InteractPrompt | null, keyLabel: string): void {
    const signature = prompt === null ? null : `${prompt.kind}|${prompt.id}|${prompt.name}|${prompt.detail ?? ''}|${keyLabel}`;
    if (signature === this.shown) return;
    this.shown = signature;
    if (prompt === null) {
      this.root.hidden = true;
      return;
    }
    this.key.textContent = keyLabel;
    this.name.textContent = prompt.name;
    this.detail.textContent = prompt.detail ?? '';
    this.detail.hidden = prompt.detail === null;
    this.root.hidden = false;
  }
}

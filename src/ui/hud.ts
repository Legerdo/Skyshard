import './hud.css';
import './hudDebugBadge.css'; // task 22.1
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import type { ObjectiveView } from '../quest/questSystem';
import { h } from './dom';
import { hudLayoutCssVars } from './hudLayout';
import type { Screen } from './screenManager';
import { clampSkyshards, formatSkyshards, objectiveLines, SKYSHARD_TOTAL, type ObjectiveLines } from './screenModels';

/** Text refresh interval (s): numbers and wording are written at about 15 Hz (design "갱신 전략"). */
export const HUD_TEXT_INTERVAL = 1 / 15;

/*
 * Gameplay HUD (design "HUD 레이아웃", Req 32.1): the bottom screen during play, `gameplay` context. This task
 * draws the tracked quest's current Objective (top left, 420×64 at UI scale 1) and the Skyshard progress
 * "Skyshard n/3" (top right, 180×48); `layer` hosts the other HUD widgets (Region title card, interaction
 * prompt, recovery fade). Party slots, HP, Skill / Burst, Stamina, Compass and the save indicator join with
 * tasks 6 and 14.
 *
 * Inputs: `setObjective` is the Quest_System `hud:objective` sink; `skyshardAcquired` follows
 * `'skyshard:acquired'`. The Skyshard count is the higher of the read-only GameState and the last acquired
 * index, so it is right whichever runs first in EventDispatch. Text is written only when it changes, at the
 * next ~15 Hz slot (well inside the 1 s the task allows). Nothing here takes pointer input.
 */
export class GameplayHud implements Screen {
  readonly id = 'gameplay';
  readonly context = 'gameplay';
  /** Parent for HUD widgets owned by other modules. */
  readonly layer: HTMLElement;
  private readonly root: HTMLElement;
  private readonly objectivePanel: HTMLElement;
  private readonly objectiveStage: HTMLElement;
  private readonly objectiveText: HTMLElement;
  private readonly skyshardText: HTMLElement;
  private readonly skyshardPips: HTMLElement[];
  private readonly debugBadge: HTMLElement; // task 22.1
  private readonly state: DeepReadonly<GameState>;
  private objective: ObjectiveLines | null = null;
  private acquired = 0;
  private sinceWrite = Infinity;
  private dirty = true;
  /** What the DOM shows now. */
  private shown: { objective: string | null; skyshards: number } = { objective: '', skyshards: -1 };

  constructor(state: DeepReadonly<GameState>) {
    this.state = state;
    this.objectiveStage = h('div', { class: 'hud-objective__stage' });
    this.objectiveText = h('div', { class: 'hud-objective__text' });
    this.objectivePanel = h('section', { class: 'hud-objective', 'aria-label': '현재 목표', 'aria-live': 'polite', hidden: true }, [
      this.objectiveStage,
      this.objectiveText,
    ]);
    this.skyshardPips = Array.from({ length: SKYSHARD_TOTAL }, () => h('span', { class: 'hud-skyshard__pip', 'aria-hidden': 'true' }));
    this.skyshardText = h('span', { class: 'hud-skyshard__text' });
    const skyshard = h('div', { class: 'hud-skyshard', role: 'status' }, [
      h('span', { class: 'hud-skyshard__pips', 'aria-hidden': 'true' }, this.skyshardPips),
      this.skyshardText,
    ]);
    this.layer = h('div', { class: 'hud__layer' });
    // Task 22.1: top-left "DEBUG" while GameState.debugUsed (Req 41.3); it stays through cinematics.
    this.debugBadge = h('div', { class: 'hud-debug-badge', role: 'status', hidden: true }, ['DEBUG']);
    this.root = h('div', { class: 'ui-screen hud' }, [this.layer, this.objectivePanel, skyshard, this.debugBadge]);
    // Task 14.3: every HUD box's size and place from the layout table (rem, so they follow --ui-scale).
    for (const [name, value] of Object.entries(hudLayoutCssVars())) this.root.style.setProperty(name, value);
  }

  /** Task 21.1: while a cinematic plays only its overlay (in `layer`) and the DEBUG badge show. */
  setCinematic(playing: boolean): void {
    this.root.classList.toggle('hud--cinematic', playing);
  }

  /** `hud:objective`: the tracked quest's current objective, null when nothing is left to track. */
  setObjective(view: ObjectiveView | null): void {
    this.objective = objectiveLines(view);
    this.dirty = true;
  }

  /** `'skyshard:acquired'` with its index (1–3). */
  skyshardAcquired(index: number): void {
    this.acquired = Math.max(this.acquired, clampSkyshards(index));
    this.dirty = true;
  }

  /** Skyshards the HUD shows. */
  get skyshards(): 0 | 1 | 2 | 3 {
    return clampSkyshards(Math.max(this.state.skyshards, this.acquired));
  }

  mount(root: HTMLElement): void {
    root.append(this.root);
    this.sinceWrite = Infinity; // write at once
  }

  unmount(): void {
    this.root.remove();
  }

  onInput(): boolean {
    return false;
  }

  focusables(): readonly HTMLElement[] {
    return [];
  }

  update(realDt: number): void {
    this.sinceWrite += Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    if (this.debugBadge.hidden === this.state.debugUsed) this.debugBadge.hidden = !this.state.debugUsed; // task 22.1
    if (this.sinceWrite < HUD_TEXT_INTERVAL) return;
    const skyshards = this.skyshards;
    if (!this.dirty && skyshards === this.shown.skyshards) return;
    this.sinceWrite = 0;
    this.dirty = false;
    this.writeObjective();
    this.writeSkyshards(skyshards);
  }

  private writeObjective(): void {
    const lines = this.objective;
    const key = lines === null ? null : `${lines.stage}\n${lines.text}`;
    if (key === this.shown.objective) return;
    this.shown.objective = key;
    this.objectivePanel.hidden = lines === null;
    if (lines === null) return;
    this.objectiveStage.textContent = lines.stage;
    this.objectiveText.textContent = lines.text;
  }

  private writeSkyshards(n: number): void {
    if (n === this.shown.skyshards) return;
    this.shown.skyshards = n;
    this.skyshardText.textContent = formatSkyshards(n);
    this.skyshardPips.forEach((pip, i) => pip.classList.toggle('is-lit', i < n));
  }
}

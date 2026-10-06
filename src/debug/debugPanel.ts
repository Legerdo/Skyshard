import './debugPanel.css';
import type { UiCommand } from '../core/uiCommands';
import type { Vec3 } from '../core/types';
import type { HarnessSnapshot } from '../harness/snapshot';
import { h } from '../ui/dom';
import { DEBUG_GLIM_GRANT } from './debugTools';
import { DEBUG_LOCATIONS } from './debugLocations';
import { debugEnabled } from './debugSession';

/*
 * Debug_Tools panel (design "Debug_Tools", Req 41.1, 41.2): mounted only when the page was opened with `?debug=1`;
 * without it mountDebugPanel returns null before creating any DOM or registering any shortcut, so no debug input does
 * anything. F9 opens and closes the "DEBUG" panel: 무적, 캐릭터 전원 합류, Glim 지급, Skyshard 지급, 지점 이동, 보스 직행,
 * 적 AI 상태 표시. It lives outside the ScreenManager stack on the top overlay layer (no ScreenId, PauseMode or input
 * context change) and releases the pointer lock while open so the mouse can use it. Every control only queues a
 * `debug` UiCommand; the simulation applies it on the next tick through the normal public methods (src/debug/
 * debugTools.ts). The AI labels read the same frozen snapshot as the Test_Harness and change nothing.
 */

export interface DebugPanelOptions {
  /** `location.search`. */
  search: string;
  /** Overlay root the panel goes on top of. */
  root: HTMLElement;
  /** Where F9 is listened for. */
  keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  commands: { push(command: UiCommand): void };
  releasePointerLock(): void;
  /** The toggles as the simulation holds them (null without a session). */
  toggles(): { readonly invincible: boolean; readonly showAi: boolean } | null;
  /** The Test_Harness snapshot (enemies within 60 m). */
  snapshot(): HarnessSnapshot;
  /** A world point in CSS pixels of the root, or null behind the camera / off screen. */
  project(pos: Readonly<Vec3>): { readonly x: number; readonly y: number } | null;
}

export interface DebugPanel {
  readonly open: boolean;
  toggle(): void;
  /** Every render frame: the toggles' state and the AI labels. */
  update(): void;
  dispose(): void;
}

/** The panel for a `?debug=1` page, or null (nothing created, nothing registered). */
export function mountDebugPanel(options: DebugPanelOptions): DebugPanel | null {
  if (!debugEnabled(options.search)) return null;
  return new DebugPanelView(options);
}

/** AI labels float this far above the enemy's feet (m). */
const LABEL_LIFT = 2.4;

class DebugPanelView implements DebugPanel {
  private readonly o: DebugPanelOptions;
  private readonly panel: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly labelPool: HTMLElement[] = [];
  private readonly invincible: HTMLInputElement;
  private readonly showAi: HTMLInputElement;
  private readonly location: HTMLSelectElement;
  private isOpen = false;

  constructor(options: DebugPanelOptions) {
    this.o = options;
    const send = (action: Extract<UiCommand, { kind: 'debug' }>['action']): void => options.commands.push({ kind: 'debug', action });
    this.invincible = h('input', { type: 'checkbox', class: 'debug-panel__check' });
    this.invincible.addEventListener('change', () => send({ op: 'invincible', on: this.invincible.checked }));
    this.showAi = h('input', { type: 'checkbox', class: 'debug-panel__check' });
    this.showAi.addEventListener('change', () => send({ op: 'showAi', on: this.showAi.checked }));
    this.location = h('select', { class: 'debug-panel__select', 'aria-label': '이동할 지점' },
      DEBUG_LOCATIONS.map((l) => h('option', { value: l.id }, [l.label])));
    const button = (label: string, onClick: () => void): HTMLButtonElement =>
      h('button', { type: 'button', class: 'debug-panel__button', onclick: onClick }, [label]);
    this.panel = h('section', { class: 'debug-panel', role: 'dialog', 'aria-label': 'DEBUG 패널', hidden: true }, [
      h('header', { class: 'debug-panel__header' }, [h('span', { class: 'debug-panel__tag' }, ['DEBUG']), h('span', { class: 'debug-panel__key' }, ['F9'])]),
      h('label', { class: 'debug-panel__row' }, [this.invincible, '무적']),
      button('캐릭터 전원 합류', () => send({ op: 'joinAll' })),
      button(`Glim 지급 (+${DEBUG_GLIM_GRANT.toLocaleString('ko-KR')})`, () => send({ op: 'grantGlim', amount: DEBUG_GLIM_GRANT })),
      button('Skyshard 지급', () => send({ op: 'grantSkyshard' })),
      h('div', { class: 'debug-panel__row' }, [
        this.location,
        button('지점 이동', () => {
          const at = DEBUG_LOCATIONS.find((l) => l.id === this.location.value);
          if (at !== undefined) send({ op: 'teleport', x: at.x, z: at.z });
        }),
      ]),
      button('보스 직행', () => send({ op: 'bossDirect' })),
      h('label', { class: 'debug-panel__row' }, [this.showAi, '적 AI 상태 표시']),
    ]);
    // Keys typed into the panel stay out of the game's input (Space on a button is not a jump).
    for (const type of ['keydown', 'keyup'] as const) {
      this.panel.addEventListener(type, (event) => {
        if (event.code !== 'F9') event.stopPropagation();
      });
    }
    this.labels = h('div', { class: 'debug-ai-labels', 'aria-hidden': 'true' });
    options.root.append(this.labels, this.panel);
    options.keyTarget.addEventListener('keydown', this.onKey, { capture: true });
  }

  get open(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.panel.hidden = !this.isOpen;
    if (this.isOpen) this.o.releasePointerLock();
  }

  update(): void {
    const toggles = this.o.toggles();
    if (this.isOpen && toggles !== null) {
      if (this.invincible.checked !== toggles.invincible) this.invincible.checked = toggles.invincible;
      if (this.showAi.checked !== toggles.showAi) this.showAi.checked = toggles.showAi;
    }
    const enemies = toggles?.showAi === true ? this.o.snapshot().enemies : [];
    let used = 0;
    for (const e of enemies) {
      const at = this.o.project({ x: e.pos.x, y: e.pos.y + LABEL_LIFT, z: e.pos.z });
      if (at === null) continue;
      let label = this.labelPool[used];
      if (label === undefined) {
        label = h('div', { class: 'debug-ai-label' });
        this.labelPool.push(label);
        this.labels.append(label);
      }
      used++;
      const telegraph = e.telegraph === null ? '' : ` · TG ${e.telegraph.toFixed(2)}s`;
      const text = `${e.kind} · ${e.state}${telegraph} · HP ${Math.ceil(e.hp)}/${e.maxHp}`;
      if (label.textContent !== text) label.textContent = text;
      label.style.transform = `translate(${at.x.toFixed(0)}px, ${at.y.toFixed(0)}px) translate(-50%, -100%)`;
      label.hidden = false;
    }
    for (let i = used; i < this.labelPool.length; i++) {
      const label = this.labelPool[i];
      if (label !== undefined && !label.hidden) label.hidden = true;
    }
  }

  dispose(): void {
    this.o.keyTarget.removeEventListener('keydown', this.onKey, { capture: true });
    this.panel.remove();
    this.labels.remove();
  }

  private readonly onKey = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || event.code !== 'F9' || event.repeat) return;
    event.preventDefault();
    this.toggle();
  };
}

import './settingsScreen.css';
import type { TutorialHintDef } from '../data/tutorials';
import { REMAPPABLE_ACTIONS, type InputAction, type RemappableAction } from '../input/actions';
import { DEFAULT_BINDINGS, GAMEPAD_LAYOUT, type Bindings, type InputCode } from '../input/bindings';
import { keyLabel } from '../input/keyLabels';
import { ACTION_LABELS, REMAP_TEXT, RemapFlow, type RemapOutcome } from '../settings/remapFlow';
import { SETTINGS_RANGES } from '../settings/sanitizeSettings';
import {
  isCustomQuality,
  QUALITY_PRESETS,
  type QualityPreset,
  type Settings,
  type SettingsStore,
  type ShadowQuality,
  type VegetationQuality,
} from '../settings/settings';
import { formatPercent, segmented, slider, tabs, toggleSwitch, type TabsControl } from './controls';
import { followHover, h, menuButton } from './dom';
import type { NavInput } from './navInput';
import type { Screen } from './screenManager';
import { buildHintCard } from './tutorialHint';

/*
 * Settings screen (design "Settings", "키 재지정", "게임패드"; Req 35.2, 35.3, 35.8, 37.5, 38.1, 38.2, 34.5; task 14.4).
 * Tabs: 오디오 (music / SFX on-off and volume), 그래픽 (preset with "사용자 지정", render scale, shadows, vegetation,
 * post-processing, performance panel), 조작 (mouse sensitivity, Y invert, key remap, "기본값으로", the fixed gamepad
 * layout), 접근성 (camera shake 0–100 %, UI scale 80–130 %) and 조작 안내 보기 (completed Tutorial_Hints in
 * completion order with the CURRENT key icons). Every control writes the SettingsStore at once; the store persists
 * each change and its subscribers apply it within their budgets (audio 0.1 s, graphics 1 s, the rest at once).
 *
 * Key remap: choosing an action shows "새 키를 누르세요"; the first key (raw code from the ScreenManager) or mouse
 * button (a capture-phase pointer listener) after the choosing input is released goes through the pure RemapFlow /
 * `remapBinding`. Esc and gamepad B cancel the remap only; refused keys show why and wait for the next input; a swap
 * shows "점프 ↔ 상호작용: 키를 서로 바꿨습니다". Esc / B otherwise close the screen through `onClose`.
 * `menu` context: game time stands still. Open it with `createSettingsScreen` from the Title or the Pause screen.
 */

export type SettingsTabId = 'audio' | 'graphics' | 'controls' | 'accessibility' | 'hints';

export const SETTINGS_TABS: readonly { readonly id: SettingsTabId; readonly label: string }[] = [
  { id: 'audio', label: '오디오' },
  { id: 'graphics', label: '그래픽' },
  { id: 'controls', label: '조작' },
  { id: 'accessibility', label: '접근성' },
  { id: 'hints', label: '조작 안내 보기' },
];

export interface SettingsScreenOptions {
  /** The page's settings (src/main.ts). */
  settings: SettingsStore;
  /** Completed Tutorial_Hints in display order (`completedHints(gameState)`), read when that tab opens. */
  hints(): readonly TutorialHintDef[];
  /** "닫기", Esc or B (outside a remap): the owner pops the screen. */
  onClose(): void;
  /** A refused input (reserved key in the remap) for the refusal sound. */
  onRefuse?(): void;
  initialTab?: SettingsTabId;
}

const PANEL_ID = 'settings-panel';
const STATUS_SECONDS = 3.5;

const PRESET_OPTIONS: readonly { value: QualityPreset; label: string }[] = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
];
const SHADOW_OPTIONS: readonly { value: ShadowQuality; label: string }[] = [
  { value: 'off', label: '끔' },
  { value: 'low', label: '낮음' },
  { value: 'high', label: '높음' },
];
const VEGETATION_OPTIONS: readonly { value: VegetationQuality; label: string }[] = [
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
];

/** Fixed keyboard / mouse inputs, shown under the remap list. */
const FIXED_KEYS_TEXT = '고정 키: Esc 일시정지 · F3 성능 표시 · 방향키 카메라 회전 · 휠 클릭 Lock-on · 오른쪽 Shift 질주';

const PAD_NAMES: Readonly<Record<string, string>> = {
  PadA: 'A', PadB: 'B', PadX: 'X', PadY: 'Y', PadLB: 'LB', PadRB: 'RB', PadLT: 'LT', PadRT: 'RT',
  PadBack: 'Back', PadStart: 'Start', PadR3: 'R3', PadUp: 'D-pad ↑', PadRight: 'D-pad →', PadDown: 'D-pad ↓', PadLeft: 'D-pad ←',
};

function actionName(action: InputAction): string {
  if (action === 'pause') return '일시정지';
  return (ACTION_LABELS as Readonly<Record<string, string>>)[action] ?? action;
}

/** The fixed standard gamepad layout as rows (Req 35.2). */
export function gamepadRows(): { button: string; action: string }[] {
  return [
    { button: '왼쪽 스틱', action: '이동' },
    { button: '오른쪽 스틱', action: '카메라' },
    ...GAMEPAD_LAYOUT.map(([code, actions]) => ({ button: PAD_NAMES[code] ?? code, action: actions.map(actionName).join(' · ') })),
  ];
}

function row(label: string, control: Node, note?: string): HTMLElement {
  return h('div', { class: 'settings-row' }, [
    h('span', { class: 'settings-row__label' }, [label]),
    h('div', { class: 'settings-row__control' }, [control]),
    ...(note === undefined ? [] : [h('p', { class: 'settings-row__note' }, [note])]),
  ]);
}

interface TabContent {
  readonly nodes: Node[];
  readonly focusables: HTMLElement[];
}

export class SettingsScreen implements Screen {
  readonly id = 'settings';
  readonly context = 'menu';
  private readonly o: SettingsScreenOptions;
  private readonly store: SettingsStore;
  private readonly root: HTMLElement;
  private readonly tabBar: TabsControl<SettingsTabId>;
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly flow = new RemapFlow();
  private tab: SettingsTabId;
  private bodyFocusables: HTMLElement[] = [];
  /** Refreshes the current tab's controls from a new Settings value. */
  private syncs: ((s: Readonly<Settings>) => void)[] = [];
  private readonly keyButtons = new Map<RemappableAction, HTMLButtonElement>();
  private unsubscribe: (() => void) | null = null;
  private listeners: AbortController | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last raw code that went down outside a remap, and the one that confirmed the focused item (still held). */
  private lastDown: InputCode | null = null;
  private confirmCode: InputCode | null = null;
  /** A mouse press the remap took: its click / auxclick / context menu must not act as well. */
  private swallowClickUntil = -Infinity;

  constructor(options: SettingsScreenOptions) {
    this.o = options;
    this.store = options.settings;
    this.tab = options.initialTab ?? 'audio';
    this.tabBar = tabs({
      label: '설정 분류',
      tabs: SETTINGS_TABS,
      selected: this.tab,
      panelId: PANEL_ID,
      onSelect: (id) => this.showTab(id),
    });
    this.body = h('div', { class: 'settings-body', id: PANEL_ID, role: 'tabpanel' });
    this.status = h('p', { class: 'settings-status', role: 'status', 'aria-live': 'polite' });
    this.closeButton = menuButton('닫기', () => this.close(), { className: 'settings-close' });
    this.root = h('div', { class: 'ui-screen ui-modal settings-screen' }, [
      h('section', { class: 'ui-panel settings-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' }, [
        h('div', { class: 'ui-panel__rule', 'aria-hidden': 'true' }),
        h('h2', { class: 'ui-panel__title settings-title', id: 'settings-title' }, ['설정']),
        this.tabBar.element,
        this.body,
        this.status,
        h('div', { class: 'settings-footer' }, [this.closeButton]),
      ]),
    ]);
  }

  /** The tab shown now. */
  get currentTab(): SettingsTabId {
    return this.tab;
  }

  /** The action waiting for a new key, or null. */
  get remapping(): RemappableAction | null {
    return this.flow.action;
  }

  mount(root: HTMLElement): void {
    root.append(this.root);
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribe((next) => this.sync(next));
    this.installPointerCapture();
    this.showTab(this.tab);
  }

  unmount(): void {
    this.flow.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners?.abort();
    this.listeners = null;
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.root.remove();
  }

  onInput(nav: NavInput): boolean {
    if (this.flow.active) return true; // a remap waits for a key; Esc / B reach it as raw input
    if (nav === 'cancel') {
      this.close();
      return true;
    }
    if (nav === 'confirm') this.confirmCode = this.lastDown;
    return false;
  }

  onRawInput(code: InputCode, phase: 'down' | 'up'): boolean {
    // Mouse buttons come from the capture-phase pointer listener (the queue only sees presses on the canvas).
    if (code.startsWith('Mouse')) return this.flow.active && phase === 'down';
    if (!this.flow.active) {
      if (phase === 'down') {
        this.lastDown = code;
        this.confirmCode = null;
      }
      return false;
    }
    this.handle(this.flow.input(code, phase, this.store.get().bindings));
    return phase === 'down';
  }

  focusables(): readonly HTMLElement[] {
    return [...this.tabBar.buttons, ...this.bodyFocusables, this.closeButton];
  }

  private close(): void {
    this.cancelRemap(false);
    this.o.onClose();
  }

  private set(patch: Partial<Settings>): void {
    this.store.set(patch);
  }

  private sync(next: Readonly<Settings>): void {
    for (const sync of this.syncs) sync(next);
  }

  private showTab(id: SettingsTabId): void {
    this.cancelRemap(false);
    this.tab = id;
    this.tabBar.select(id);
    this.body.setAttribute('aria-labelledby', this.tabBar.button(id).id);
    this.syncs = [];
    this.keyButtons.clear();
    const content = this.build(id, this.store.get());
    this.body.replaceChildren(...content.nodes);
    this.bodyFocusables = content.focusables;
    this.body.scrollTop = 0;
  }

  private build(id: SettingsTabId, s: Readonly<Settings>): TabContent {
    switch (id) {
      case 'audio':
        return this.buildAudio(s);
      case 'graphics':
        return this.buildGraphics(s);
      case 'controls':
        return this.buildControls(s);
      case 'accessibility':
        return this.buildAccessibility(s);
      case 'hints':
        return this.buildHints(s);
    }
  }

  private buildAudio(s: Readonly<Settings>): TabContent {
    const music = toggleSwitch({ label: '음악', value: s.musicOn, onChange: (v) => this.set({ musicOn: v }) });
    const musicVolume = slider({
      label: '음악 음량', ...SETTINGS_RANGES.musicVolume, step: 0.05, value: s.musicVolume, format: formatPercent,
      onChange: (v) => this.set({ musicVolume: v }),
    });
    const sfx = toggleSwitch({ label: '효과음', value: s.sfxOn, onChange: (v) => this.set({ sfxOn: v }) });
    const sfxVolume = slider({
      label: '효과음 음량', ...SETTINGS_RANGES.sfxVolume, step: 0.05, value: s.sfxVolume, format: formatPercent,
      onChange: (v) => this.set({ sfxVolume: v }),
    });
    this.syncs.push((n) => {
      music.set(n.musicOn);
      musicVolume.set(n.musicVolume);
      sfx.set(n.sfxOn);
      sfxVolume.set(n.sfxVolume);
    });
    return {
      nodes: [
        row('음악', music.element),
        row('음악 음량', musicVolume.element),
        row('효과음', sfx.element, '효과음을 끄면 환경음도 함께 꺼집니다.'),
        row('효과음 음량', sfxVolume.element),
      ],
      focusables: [music.element, musicVolume.element, sfx.element, sfxVolume.element],
    };
  }

  private buildGraphics(s: Readonly<Settings>): TabContent {
    const preset = segmented({
      label: '품질 프리셋',
      options: PRESET_OPTIONS,
      value: isCustomQuality(s) ? null : s.qualityPreset,
      // Picking a preset sets its four fields together, also the current one after "사용자 지정".
      onChange: (p) => this.set({ qualityPreset: p, ...QUALITY_PRESETS[p] }),
    });
    const custom = h('span', { class: 'settings-badge', hidden: !isCustomQuality(s) }, ['사용자 지정']);
    const renderScale = slider({
      label: '렌더 스케일', ...SETTINGS_RANGES.renderScale, step: 0.05, value: s.renderScale, format: formatPercent,
      onChange: (v) => this.set({ renderScale: v }),
    });
    const shadows = segmented({ label: '그림자 품질', options: SHADOW_OPTIONS, value: s.shadows, onChange: (v) => this.set({ shadows: v }) });
    const vegetation = segmented({
      label: '식생 밀도', options: VEGETATION_OPTIONS, value: s.vegetation, onChange: (v) => this.set({ vegetation: v }),
    });
    const post = toggleSwitch({ label: '후처리', value: s.postProcessing, onChange: (v) => this.set({ postProcessing: v }) });
    const perf = toggleSwitch({ label: '성능 표시', value: s.showPerfOverlay, onChange: (v) => this.set({ showPerfOverlay: v }) });
    this.syncs.push((n) => {
      const isCustom = isCustomQuality(n);
      preset.set(isCustom ? null : n.qualityPreset);
      custom.hidden = !isCustom;
      renderScale.set(n.renderScale);
      shadows.set(n.shadows);
      vegetation.set(n.vegetation);
      post.set(n.postProcessing);
      perf.set(n.showPerfOverlay);
    });
    return {
      nodes: [
        row('품질 프리셋', h('div', { class: 'settings-inline' }, [preset.element, custom])),
        row('렌더 스케일', renderScale.element),
        row('그림자 품질', shadows.element),
        row('식생 밀도', vegetation.element),
        row('후처리', post.element),
        row('성능 표시 (F3)', perf.element),
        h('p', { class: 'settings-note' }, ['그래픽 설정은 게임을 다시 시작하지 않아도 바로 적용됩니다.']),
      ],
      focusables: [...preset.buttons, renderScale.element, ...shadows.buttons, ...vegetation.buttons, post.element, perf.element],
    };
  }

  private buildControls(s: Readonly<Settings>): TabContent {
    const sensitivity = slider({
      label: '마우스 감도', ...SETTINGS_RANGES.mouseSensitivity, step: 0.1, value: s.mouseSensitivity,
      format: (v) => v.toFixed(1), onChange: (v) => this.set({ mouseSensitivity: v }),
    });
    const invert = toggleSwitch({ label: 'Y축 반전', value: s.invertY, onChange: (v) => this.set({ invertY: v }) });
    const keys = REMAPPABLE_ACTIONS.map((action) => this.keyButton(action, s.bindings));
    const defaults = menuButton('기본값으로', () => this.resetBindings(), { className: 'settings-defaults' });
    const pad = h('dl', { class: 'settings-pad' }, gamepadRows().flatMap((r) => [
      h('dt', { class: 'settings-pad__button' }, [r.button]),
      h('dd', { class: 'settings-pad__action' }, [r.action]),
    ]));
    this.syncs.push((n) => {
      sensitivity.set(n.mouseSensitivity);
      invert.set(n.invertY);
      this.drawKeys(n.bindings);
    });
    return {
      nodes: [
        row('마우스 감도', sensitivity.element, '마우스와 게임패드 오른쪽 스틱에 함께 적용됩니다.'),
        row('Y축 반전', invert.element),
        h('h3', { class: 'settings-heading' }, ['키보드 · 마우스']),
        h('div', { class: 'settings-keys' }, keys),
        h('p', { class: 'settings-note' }, [FIXED_KEYS_TEXT]),
        h('div', { class: 'settings-actions' }, [defaults]),
        h('h3', { class: 'settings-heading' }, ['게임패드 (표준 배치 · 고정)']),
        pad,
      ],
      focusables: [sensitivity.element, invert.element, ...keys, defaults],
    };
  }

  private buildAccessibility(s: Readonly<Settings>): TabContent {
    const shake = slider({
      label: '화면 흔들림', ...SETTINGS_RANGES.shake, step: 0.05, value: s.shake, format: formatPercent,
      onChange: (v) => this.set({ shake: v }),
    });
    const scale = slider({
      label: 'UI 배율', ...SETTINGS_RANGES.uiScale, step: 0.05, value: s.uiScale, format: formatPercent,
      onChange: (v) => this.set({ uiScale: v }),
    });
    this.syncs.push((n) => {
      shake.set(n.shake);
      scale.set(n.uiScale);
    });
    return {
      nodes: [
        row('화면 흔들림', shake.element, '0%면 카메라가 흔들리지 않습니다.'),
        row('UI 배율', scale.element),
      ],
      focusables: [shake.element, scale.element],
    };
  }

  private buildHints(s: Readonly<Settings>): TabContent {
    const defs = this.o.hints();
    if (defs.length === 0) {
      return { nodes: [h('p', { class: 'settings-empty' }, ['아직 완료한 조작 안내가 없습니다. 게임을 진행하면 여기에 모입니다.'])], focusables: [] };
    }
    const items = defs.map((def) => {
      const item = h('div', { class: 'settings-hint', tabindex: '0' }, [buildHintCard(def, s.bindings, 'tutorial-card settings-hint__card')]);
      followHover(item);
      return item;
    });
    this.syncs.push((n) => defs.forEach((def, i) => items[i].replaceChildren(buildHintCard(def, n.bindings, 'tutorial-card settings-hint__card'))));
    return {
      nodes: [
        h('p', { class: 'settings-note' }, ['완료한 조작 안내를 완료한 순서대로 현재 키와 함께 보여 줍니다.']),
        h('div', { class: 'settings-hints', role: 'list' }, items.map((item) => {
          item.setAttribute('role', 'listitem');
          return item;
        })),
      ],
      focusables: items,
    };
  }

  private keyButton(action: RemappableAction, bindings: Readonly<Bindings>): HTMLButtonElement {
    const code = h('kbd', { class: 'settings-key__code' }, [keyLabel(bindings[action])]);
    const btn = h('button', { type: 'button', class: 'settings-key' }, [h('span', { class: 'settings-key__label' }, [ACTION_LABELS[action]]), code]);
    btn.setAttribute('aria-label', `${ACTION_LABELS[action]}: ${keyLabel(bindings[action])}`);
    btn.addEventListener('click', () => this.beginRemap(action));
    followHover(btn);
    this.keyButtons.set(action, btn);
    return btn;
  }

  private drawKeys(bindings: Readonly<Bindings>): void {
    for (const [action, btn] of this.keyButtons) {
      const listening = this.flow.action === action;
      btn.classList.toggle('is-listening', listening);
      const text = listening ? REMAP_TEXT.prompt : keyLabel(bindings[action]);
      const code = btn.querySelector('.settings-key__code');
      if (code !== null && code.textContent !== text) code.textContent = text;
      btn.setAttribute('aria-label', `${ACTION_LABELS[action]}: ${text}`);
    }
  }

  private beginRemap(action: RemappableAction): void {
    const trigger = this.confirmCode; // Enter / A still held; null after a mouse click (already released)
    this.confirmCode = null;
    this.flow.begin(action, trigger);
    this.drawKeys(this.store.get().bindings);
    this.say(`${ACTION_LABELS[action]}: ${REMAP_TEXT.prompt} (${REMAP_TEXT.promptHint})`, 'info', true);
  }

  private cancelRemap(announce: boolean): void {
    if (!this.flow.active) return;
    const outcome = this.flow.cancel();
    this.drawKeys(this.store.get().bindings);
    if (announce && outcome.kind === 'cancelled') this.say(outcome.message);
    else this.say('');
  }

  private handle(outcome: RemapOutcome): void {
    switch (outcome.kind) {
      case 'ignored':
        return;
      case 'cancelled':
        this.drawKeys(this.store.get().bindings);
        this.say(outcome.message);
        return;
      case 'refused':
        this.o.onRefuse?.();
        this.say(`${outcome.message} · ${REMAP_TEXT.prompt}`, 'warn', true);
        return;
      case 'applied':
        this.set({ bindings: outcome.bindings }); // persisted; prompts and hint keys redraw from the new bindings
        this.drawKeys(this.store.get().bindings);
        this.say(outcome.message);
        return;
    }
  }

  private resetBindings(): void {
    this.cancelRemap(false);
    this.set({ bindings: { ...DEFAULT_BINDINGS } });
    this.drawKeys(this.store.get().bindings);
    this.say(REMAP_TEXT.defaults);
  }

  /** Shows `text` in the status line; not sticky: cleared after a few seconds. */
  private say(text: string, tone: 'info' | 'warn' = 'info', sticky = false): void {
    if (this.statusTimer !== null) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.status.textContent = text;
    this.status.classList.toggle('is-warn', tone === 'warn');
    if (!sticky && text !== '') {
      this.statusTimer = setTimeout(() => {
        this.statusTimer = null;
        if (!this.flow.active) this.status.textContent = '';
      }, STATUS_SECONDS * 1000);
    }
  }

  /**
   * While a remap waits, the first mouse button press anywhere is the new input (`Mouse` + button): taken in the
   * capture phase so it neither clicks a control nor reaches the canvas; its click and context menu are swallowed.
   */
  private installPointerCapture(): void {
    this.listeners?.abort();
    const controller = new AbortController();
    this.listeners = controller;
    const options = { capture: true, signal: controller.signal };
    window.addEventListener('pointerdown', (event: PointerEvent) => {
      if (!this.flow.active || event.pointerType !== 'mouse') return;
      event.preventDefault();
      event.stopPropagation();
      this.swallowClickUntil = event.timeStamp + 1000;
      this.handle(this.flow.input(`Mouse${event.button}`, 'down', this.store.get().bindings));
    }, options);
    const swallow = (event: Event): void => {
      if (event.timeStamp > this.swallowClickUntil) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type !== 'contextmenu') this.swallowClickUntil = -Infinity;
    };
    window.addEventListener('click', swallow, options);
    window.addEventListener('auxclick', swallow, options);
    window.addEventListener('contextmenu', swallow, options);
    // No browser context menu over the settings panel.
    this.root.addEventListener('contextmenu', (event) => event.preventDefault(), { signal: controller.signal });
  }
}

/** A new Settings screen (the Title "설정" button, the Pause "설정" item). */
export function createSettingsScreen(options: SettingsScreenOptions): SettingsScreen {
  return new SettingsScreen(options);
}

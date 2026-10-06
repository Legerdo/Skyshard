import './perfOverlay.css';

export { FpsMeter } from './fpsMeter';

/* F3 performance panel: fps, draw calls, triangles (Req 38.7). */

export interface PerfInfo {
  fps: number;
  drawCalls: number;
  triangles: number;
  frameMs?: number;
  extra?: Record<string, string | number>;
}

/** DOM writes at most 4 times per second. */
const WRITE_INTERVAL_MS = 250;
const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function formatValue(value: string | number): string {
  if (typeof value === 'string') return value;
  return Number.isInteger(value) ? intFormat.format(value) : value.toFixed(2);
}

type Metric = 'fps' | 'frame' | 'calls' | 'triangles';

export class PerfOverlay {
  private readonly root: HTMLElement;
  private readonly panel: HTMLDivElement;
  private readonly values: Record<Metric, HTMLSpanElement>;
  private readonly extra: HTMLDivElement;
  /** Last text written per element, so unchanged values skip the DOM. */
  private readonly written = new Map<HTMLElement, string>();
  private shown = false;
  private disposed = false;
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  private latest: PerfInfo | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.panel = document.createElement('div');
    this.panel.id = 'perf-overlay';
    this.panel.className = 'perf-overlay';
    this.values = {
      fps: this.addRow('fps'),
      frame: this.addRow('frame'),
      calls: this.addRow('draw call'),
      triangles: this.addRow('삼각형'),
    };
    this.extra = document.createElement('div');
    this.extra.className = 'perf-overlay__extra';
    this.panel.append(this.extra);
  }

  get visible(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.setVisible(!this.shown);
  }

  setVisible(v: boolean): void {
    if (this.disposed || v === this.shown) return;
    this.shown = v;
    if (!v) {
      this.panel.remove();
      return;
    }
    this.root.append(this.panel);
    this.lastWriteMs = Number.NEGATIVE_INFINITY;
    if (this.latest) this.update(this.latest);
  }

  /** Cheap to call every frame: only writes the DOM while visible, throttled to 4 Hz. */
  update(info: PerfInfo): void {
    this.latest = info;
    if (!this.shown) return;
    const now = performance.now();
    if (now - this.lastWriteMs < WRITE_INTERVAL_MS) return;
    this.lastWriteMs = now;
    this.write(info);
  }

  dispose(): void {
    this.disposed = true;
    this.shown = false;
    this.latest = null;
    this.panel.remove();
  }

  private addRow(label: string): HTMLSpanElement {
    const name = document.createElement('span');
    name.className = 'perf-overlay__label';
    name.textContent = label;
    const value = document.createElement('span');
    value.className = 'perf-overlay__value';
    value.textContent = '—';
    this.panel.append(name, value);
    return value;
  }

  private write(info: PerfInfo): void {
    this.setText(this.values.fps, info.fps.toFixed(1));
    this.setText(this.values.frame, info.frameMs === undefined ? '—' : `${info.frameMs.toFixed(1)} ms`);
    this.setText(this.values.calls, intFormat.format(info.drawCalls));
    this.setText(this.values.triangles, intFormat.format(info.triangles));
    const extra = info.extra
      ? Object.entries(info.extra).map(([key, value]) => `${key}: ${formatValue(value)}`).join('\n')
      : '';
    this.setText(this.extra, extra);
    // Raw values for automated budget checks (Playwright reads these).
    const { dataset } = this.panel;
    dataset.fps = info.fps.toFixed(1);
    dataset.drawCalls = String(info.drawCalls);
    dataset.triangles = String(info.triangles);
  }

  private setText(el: HTMLElement, text: string): void {
    if (this.written.get(el) === text) return;
    this.written.set(el, text);
    el.textContent = text;
  }
}

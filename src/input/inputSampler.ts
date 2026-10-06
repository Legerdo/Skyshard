// Frame → tick input hand-off (design "Tick 갱신 순서": 입력은 프레임마다 모았다가 틱 시작 시 InputSample로
// 고정한다). collect() runs once per render frame before that frame's ticks and queues the frame's raw
// events; beginTick() freezes the queue into InputState at the start of a tick. The first tick after a
// collect() gets the events and later ticks of the same frame get none, so an edge fires once even when
// a 30 fps frame runs two ticks, and a 144 fps frame that runs no tick keeps its events for the next one.
//
// Mouse movement skips the queue: InputState.addMouseLook adds it to the look accumulator at once, so
// the camera turns in the frame the mouse moved even when that frame runs no tick (design "Camera":
// 마우스 회전은 smoothing 없이 같은 frame에 1:1로 반영한다). Pure: no DOM.

import type { InputState, RawInput } from './inputState';

export class InputSampler {
  private readonly state: InputState;
  private pending: RawInput[] = [];

  constructor(state: InputState) {
    this.state = state;
  }

  /** Events waiting for the next tick. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Queues one render frame's raw events (BrowserInput.drain()), in arrival order. */
  collect(events: Iterable<RawInput>): void {
    for (const event of events) {
      if (event.kind === 'mouseMove') {
        this.state.addMouseLook(event.dx, event.dy);
      } else if (event.kind === 'axes' && this.pending.at(-1)?.kind === 'axes') {
        // An 'axes' event only overwrites the stick state, so back-to-back polls reduce to the latest.
        // This bounds the queue while frames run no tick (pause) with a gamepad connected.
        this.pending[this.pending.length - 1] = event;
      } else {
        this.pending.push(event);
      }
    }
  }

  /** Starts a sim tick of `dt` seconds with everything collected since the previous tick. */
  beginTick(dt: number): void {
    const events = this.pending;
    this.pending = [];
    this.state.beginTick(events, dt);
  }

  /**
   * Applies the collected events without advancing sim time, for frames that run no tick because a menu stops
   * the game. InputState keeps tracking which keys are held (the menu context reads every action as idle), so
   * when play resumes the key that closed the menu is ignored until released instead of arriving as a fresh
   * press in the first gameplay tick. Call it once per such frame: it also ends the previous frame's edges, so
   * `pressed` (e.g. F3 for the performance panel, which menus allow) is true for one frame only.
   */
  flush(): void {
    this.beginTick(0);
  }
}

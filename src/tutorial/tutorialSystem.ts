/*
 * Tutorial_System (design "Tutorial_System", Req 34.1–34.5): the simulation adapter over the pure queue of
 * src/logic/tutorial.ts. PlaySim ticks it at the start of each fixed tick, so the tick's InputState sample is read
 * before any system (or a dialogue opening) changes the input context.
 *
 * - Triggers: `start` from the ticked play time, `near` from the Active_Character's feet, `event` from the bus (with
 *   the hint's test), `signal` from 'tutorial:trigger' (a 'tutorial:trigger' for any known hint queues it). The
 *   built-in judges of src/tutorial/tutorialSignals.ts publish the signals until their owning systems do.
 * - Done: an `action` hint closes when one of its actions is pressed or held while it shows (camera hints also on
 *   mouse / stick look, fed by the camera's look input through `look`), or when its screen opens ('ui:screen' map /
 *   inventory / quest, which stop the game before a tick sees the key); an `event` hint when that bus event (or the
 *   controller's climb / glide start, read from the movement mode) arrives while it is current.
 * - The closed hint goes into GameState.tutorials in the same tick, so the next save carries it; it never queues
 *   again (Req 34.4, 34.5). 'hint:shown' is published when a hint appears.
 * - Suppression: while a cinematic plays or the input context is not `gameplay` (menu, map, dialogue, cinematic) the
 *   card is hidden and its 8 s timer stands still.
 */

import type { GameEventBus, GameEventName, GameEvents, UiScreenId } from '../core/gameEvents';
import type { Vec2, Vec3 } from '../core/types';
import type { InputAction, InputContext } from '../input/actions';
import {
  CAMERA_ACTIONS, CONTROLLER_DONE_EVENTS, TUTORIAL_ANCHORS, TUTORIAL_HINTS, type TutorialAction, type TutorialAnchor,
  type TutorialDoneEvent, type TutorialHintDef, type TutorialTrigger, type TutorialTriggerEvents,
} from '../data/tutorials';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import { emptyTutorialQueue, enqueueHint, hintSettled, HINT_SHOW_SECONDS, stepTutorial, type TutorialQueue } from '../logic/tutorial';
import { isClimbMode, isGlideMode, type ControllerEventType, type MoveMode } from '../player/core/types';
import { installEventSignals } from './tutorialSignals';

// ── Compile-time checks of the data layer's local vocabularies ──────────────

type Extends<A extends B, B> = A;
/** Every hint action is an InputAction. */
export type TutorialActionCheck = Extends<TutorialAction, InputAction>;
/** Every `doneWhen` event is a bus event or a ControllerEvent type. */
export type TutorialDoneEventCheck = Extends<TutorialDoneEvent, GameEventName | ControllerEventType>;
/** The trigger events exist and carry at least the fields the tests read. */
export type TutorialTriggerEventCheck = [
  Extends<keyof TutorialTriggerEvents, GameEventName>,
  Extends<GameEvents['enemy:alerted'], TutorialTriggerEvents['enemy:alerted']>,
  Extends<GameEvents['party:joined'], TutorialTriggerEvents['party:joined']>,
  Extends<GameEvents['area:entered'], TutorialTriggerEvents['area:entered']>,
  Extends<GameEvents['item:granted'], TutorialTriggerEvents['item:granted']>,
];

// ── Options ─────────────────────────────────────────────────────────────────

/** Mouse / stick look (rad, |yaw| + |pitch|) that completes a camera hint. */
export const LOOK_DONE_RAD = 0.35;
/** Vertical tolerance of `near` checks (m): an NPC or a known-height anchor. */
const NEAR_HEIGHT = 4;

/** The part of InputState the system reads (this tick's sample). */
export interface TutorialInput {
  readonly context: InputContext;
  pressed(action: InputAction): boolean;
  down(action: InputAction): boolean;
}

/** What the system reads from the world each tick. */
export interface TutorialWorld {
  /** Active_Character feet. */
  playerPos(): Readonly<Vec3>;
  /** Active_Character movement mode: entering a climb / glide mode is 'climbStarted' / 'glideStarted'. */
  playerMode(): MoveMode;
  /** A cinematic holds the screen. */
  cinematicPlaying(): boolean;
  /** Where a `near` target that is not a TUTORIAL_ANCHORS id stands (NPCs), or null when unknown. */
  locate(targetId: string): Readonly<Vec3> | null;
}

/**
 * Situation judges of `signal` hints, by hint id: checked every tick until the hint is queued or completed; a true
 * result publishes 'tutorial:trigger' once.
 */
export type TutorialProbes = Readonly<Partial<Record<string, () => boolean>>>;

export interface TutorialSystemOptions {
  bus: GameEventBus;
  /** GameState.tutorials is appended to; the rest is read by the trigger tests. */
  state: GameState;
  input: TutorialInput;
  world: TutorialWorld;
  probes?: TutorialProbes;
  /** Default TUTORIAL_HINTS. */
  defs?: readonly TutorialHintDef[];
}

/** Screens whose opening is the hint action that opens them (the menu stops the game before a tick sees the key). */
const SCREEN_ACTIONS: Partial<Record<UiScreenId, InputAction>> = { map: 'map', inventory: 'inventory', quest: 'quest' };
const CONTROLLER_EVENTS: ReadonlySet<string> = new Set(CONTROLLER_DONE_EVENTS);
const CAMERA: ReadonlySet<string> = new Set(CAMERA_ACTIONS);
const TIME_EPSILON = 1e-9;

type AnyTest = (payload: unknown, gs: DeepReadonly<GameState>) => boolean;

export class TutorialSystem {
  private readonly o: TutorialSystemOptions;
  private readonly defs: readonly TutorialHintDef[];
  private readonly byId: ReadonlyMap<string, TutorialHintDef>;
  private readonly order: readonly string[];
  private readonly probes: readonly (readonly [string, () => boolean])[];
  private queue: TutorialQueue = emptyTutorialQueue();
  /** Ticked play seconds (`start` triggers). */
  private elapsed = 0;
  /** `doneWhen` events delivered since the last tick. */
  private readonly fired = new Set<string>();
  /** Hint actions performed by opening their screen since the last tick. */
  private readonly screenActions = new Set<InputAction>();
  /** Signals already published by the probes. */
  private readonly signalled = new Set<string>();
  /** Look (rad) since the current hint showed. */
  private lookAmount = 0;
  private lastMode: MoveMode | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(options: TutorialSystemOptions) {
    this.o = options;
    this.defs = options.defs ?? TUTORIAL_HINTS;
    this.byId = new Map(this.defs.map((d) => [d.id, d]));
    this.order = this.defs.map((d) => d.id);
    this.probes = Object.entries(options.probes ?? {}).filter((e): e is [string, () => boolean] => e[1] !== undefined);
    const { bus } = options;

    // `event` triggers, one subscription per event name.
    const byEvent = new Map<keyof TutorialTriggerEvents, TutorialHintDef[]>();
    for (const def of this.defs) {
      if (def.trigger.kind !== 'event') continue;
      const list = byEvent.get(def.trigger.event) ?? [];
      list.push(def);
      byEvent.set(def.trigger.event, list);
    }
    for (const [event, list] of byEvent) {
      this.unsubscribe.push(
        bus.on(event, (payload) => {
          for (const def of list) {
            const test = (def.trigger as { readonly test?: AnyTest }).test;
            if (test === undefined || test(payload, options.state)) this.trigger(def.id);
          }
        }),
      );
    }
    // `signal` triggers (and explicit requests for any hint).
    this.unsubscribe.push(bus.on('tutorial:trigger', (p) => this.trigger(p.hintId)));
    // `doneWhen` bus events; the controller's events come from the movement mode in tick().
    const doneEvents = new Set<GameEventName>();
    for (const def of this.defs) {
      if (def.doneWhen.kind === 'event' && !CONTROLLER_EVENTS.has(def.doneWhen.event)) doneEvents.add(def.doneWhen.event as GameEventName);
    }
    for (const event of doneEvents) this.unsubscribe.push(bus.on(event, () => this.fired.add(event)));
    this.unsubscribe.push(
      bus.on('ui:screen', (p) => {
        const action = SCREEN_ACTIONS[p.screen];
        if (p.open && action !== undefined) this.screenActions.add(action);
      }),
    );
    // Built-in signal judges driven by events (first Telegraph, first Vista_Point).
    this.unsubscribe.push(...installEventSignals(bus, (id) => this.settled(id)));
  }

  /** The hint on the card now, or null (none, or hidden by a cinematic, menu or dialogue). */
  visibleHint(): TutorialHintDef | null {
    const id = this.queue.current;
    if (id === null || this.suppressed()) return null;
    return this.byId.get(id) ?? null;
  }

  /** The current hint's id, shown or hidden, or null. */
  get current(): string | null {
    return this.queue.current;
  }

  /** Waiting hint ids, in trigger order. */
  get pending(): readonly string[] {
    return this.queue.pending;
  }

  /** Seconds the current hint has left on screen (0 when none). */
  get remaining(): number {
    return this.queue.current === null ? 0 : Math.max(0, HINT_SHOW_SECONDS - this.queue.shownFor);
  }

  /** A cinematic, menu or dialogue is up: the card is hidden and its timer stands still. */
  suppressed(): boolean {
    return this.o.input.context !== 'gameplay' || this.o.world.cinematicPlaying();
  }

  /** Camera look of one render frame (rad, InputState.lookDelta); completes a camera hint once it adds up. */
  look(delta: Readonly<Vec2>): void {
    if (this.queue.current === null) return;
    const amount = Math.abs(delta.x) + Math.abs(delta.y);
    if (Number.isFinite(amount)) this.lookAmount += amount;
  }

  /** Queues `id` unless it is unknown, completed, waiting or current. */
  trigger(id: string): void {
    if (!this.byId.has(id)) return;
    this.queue = enqueueHint(this.queue, id, this.o.state.tutorials);
  }

  /** One fixed tick of `dt` s, at the start of the tick (the InputState holds this tick's sample). */
  tick(dt: number): void {
    const { state, world, bus } = this.o;
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
    // `start` and `near` triggers.
    for (const def of this.defs) {
      if (this.settled(def.id)) continue;
      if (this.met(def.trigger)) this.trigger(def.id);
    }
    // Signal probes: published once; the queue takes them in this tick's EventDispatch.
    for (const [id, probe] of this.probes) {
      if (this.signalled.has(id) || this.settled(id) || !probe()) continue;
      this.signalled.add(id);
      bus.emit('tutorial:trigger', { hintId: id });
    }
    // The controller's climb / glide start, from the movement mode.
    const mode = world.playerMode();
    if (this.lastMode !== null) {
      if (isClimbMode(mode) && !isClimbMode(this.lastMode)) this.fired.add('climbStarted');
      if (isGlideMode(mode) && !isGlideMode(this.lastMode)) this.fired.add('glideStarted');
    }
    this.lastMode = mode;

    const suppressed = this.suppressed();
    const current = this.queue.current === null ? null : (this.byId.get(this.queue.current) ?? null);
    const done = current !== null && this.doneNow(current, suppressed);
    const result = stepTutorial(this.queue, { dt, suppressed, done, completed: state.tutorials, order: this.order });
    this.queue = result.queue;
    if (result.completed !== null && !state.tutorials.includes(result.completed)) state.tutorials.push(result.completed);
    if (result.shown !== null) {
      this.lookAmount = 0;
      bus.emit('hint:shown', { hintId: result.shown });
    }
    this.fired.clear();
    this.screenActions.clear();
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private settled(id: string): boolean {
    return hintSettled(this.queue, id, this.o.state.tutorials);
  }

  /** Whether a `start` or `near` trigger holds now (event and signal triggers arrive through the bus). */
  private met(trigger: TutorialTrigger): boolean {
    switch (trigger.kind) {
      case 'start':
        return this.elapsed >= trigger.delay - TIME_EPSILON;
      case 'near':
        return this.near(trigger.targetId, trigger.radius);
      default:
        return false;
    }
  }

  private near(targetId: string, radius: number): boolean {
    const feet = this.o.world.playerPos();
    const anchor: TutorialAnchor | undefined = (TUTORIAL_ANCHORS as Readonly<Record<string, TutorialAnchor>>)[targetId];
    const at = anchor ?? this.o.world.locate(targetId);
    if (at === null) return false;
    if (Math.hypot(feet.x - at.x, feet.z - at.z) > radius) return false;
    const y = anchor !== undefined ? anchor.y : (at as Readonly<Vec3>).y;
    return y === undefined || Math.abs(feet.y - y) <= NEAR_HEIGHT;
  }

  /** The current hint's `doneWhen` this tick. Actions count only while it shows; events and screens always. */
  private doneNow(def: TutorialHintDef, suppressed: boolean): boolean {
    const w = def.doneWhen;
    if (w.kind === 'event') return this.fired.has(w.event);
    if (w.actions.some((a) => this.screenActions.has(a))) return true;
    if (suppressed) return false;
    const { input } = this.o;
    if (w.actions.some((a) => input.pressed(a) || input.down(a))) return true;
    return w.actions.some((a) => CAMERA.has(a)) && this.lookAmount >= LOOK_DONE_RAD;
  }
}

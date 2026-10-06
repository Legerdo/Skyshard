/**
 * Typed, tick-queued event bus (design.md "이벤트 버스"). Pure TypeScript: no DOM or three.js.
 *
 * - `emit` only enqueues. The fixed-tick EventDispatch step calls `dispatch()` once per tick, which delivers
 *   queued events in emit (FIFO) order; events emitted meanwhile join the end of the queue and are delivered
 *   by the same dispatch.
 * - One dispatch delivers at most `maxPerDispatch` events (default 1,024); the rest stay queued for the next
 *   dispatch and a warning is logged.
 * - Handler exceptions are isolated: logged once per (event type, handler) pair while the other handlers run.
 * - Handler lists are snapshotted per delivered event, so subscribing or unsubscribing during a dispatch takes
 *   effect from the next event.
 * - Payloads must be plain, JSON-serializable, read-only data; every handler receives the emitted object as is.
 */

export interface EventLogger {
  warn(message: string): void;
  error(message: string, error: unknown): void;
}

export interface EventBusOptions {
  /** Receives cap warnings and handler errors. Defaults to `console.warn` / `console.error`. */
  logger?: EventLogger;
  /** Events delivered per `dispatch()`, including ones emitted during it. Positive integer, default 1,024. */
  maxPerDispatch?: number;
}

const DEFAULT_MAX_PER_DISPATCH = 1024;

const consoleLogger: EventLogger = {
  warn: (message) => console.warn(message),
  error: (message, error) => console.error(message, error),
};

type PayloadHandler = (payload: unknown) => void;
type AnyHandler<M> = (type: keyof M, payload: unknown) => void;

/** One `on` / `onAny` registration; its identity tells repeated registrations of one function apart. */
interface Subscription<H> {
  readonly handler: H;
}

interface QueuedEvent<M> {
  readonly type: keyof M;
  readonly payload: unknown;
}

const NO_SUBSCRIPTIONS: readonly Subscription<PayloadHandler>[] = [];

export class EventBus<M extends { [K in keyof M]: unknown }> {
  private readonly logger: EventLogger;
  private readonly maxPerDispatch: number;
  /** Undelivered events start at `queue[head]`; delivered ones are dropped when a dispatch ends. */
  private readonly queue: QueuedEvent<M>[] = [];
  private head = 0;
  private dispatching = false;
  /** Copy-on-write lists: a delivery iterates the arrays it started with while changes build new ones. */
  private readonly handlers = new Map<keyof M, readonly Subscription<PayloadHandler>[]>();
  private anyHandlers: readonly Subscription<AnyHandler<M>>[] = [];
  /** Handlers whose error has already been logged, per event type. */
  private readonly loggedErrors = new Map<keyof M, WeakSet<object>>();

  constructor(options: EventBusOptions = {}) {
    const { logger = consoleLogger, maxPerDispatch = DEFAULT_MAX_PER_DISPATCH } = options;
    if (!Number.isInteger(maxPerDispatch) || maxPerDispatch < 1) {
      throw new RangeError(`EventBus: maxPerDispatch must be a positive integer, got ${maxPerDispatch}`);
    }
    this.logger = logger;
    this.maxPerDispatch = maxPerDispatch;
  }

  /** Queues an event; it is delivered by the next `dispatch()` or, if one is running, by that one. */
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    this.queue.push({ type, payload });
  }

  /**
   * Subscribes to one event type; handlers run in registration order. The returned function removes this
   * registration only and does nothing when called again.
   */
  on<K extends keyof M>(type: K, handler: (payload: M[K]) => void): () => void {
    // Sound: `deliver` passes a handler only payloads that were emitted under the same key.
    const subscription: Subscription<PayloadHandler> = { handler: handler as PayloadHandler };
    this.handlers.set(type, [...(this.handlers.get(type) ?? NO_SUBSCRIPTIONS), subscription]);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const rest = (this.handlers.get(type) ?? NO_SUBSCRIPTIONS).filter((s) => s !== subscription);
      if (rest.length > 0) this.handlers.set(type, rest);
      else this.handlers.delete(type);
    };
  }

  /** Subscribes to every event (harness and debug logging). Runs after each event's typed handlers. */
  onAny(handler: (type: keyof M, payload: unknown) => void): () => void {
    const subscription: Subscription<AnyHandler<M>> = { handler };
    this.anyHandlers = [...this.anyHandlers, subscription];
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.anyHandlers = this.anyHandlers.filter((s) => s !== subscription);
    };
  }

  /**
   * Delivers queued events in FIFO order, including events emitted meanwhile, up to `maxPerDispatch`.
   * Returns the number of events delivered. A re-entrant call from a handler does nothing and returns 0.
   */
  dispatch(): number {
    if (this.dispatching) return 0;
    this.dispatching = true;
    let delivered = 0;
    try {
      while (delivered < this.maxPerDispatch) {
        const event = this.queue[this.head];
        if (event === undefined) break;
        // Advance first: a `clear()` from a handler resets `head` and must not skip events emitted after it.
        this.head += 1;
        delivered += 1;
        this.deliver(event);
      }
    } finally {
      this.queue.splice(0, this.head);
      this.head = 0;
      this.dispatching = false;
    }
    if (this.queue.length > 0) {
      this.logger.warn(
        `EventBus: dispatch cap of ${this.maxPerDispatch} reached; ` +
          `${this.queue.length} event(s) carried over to the next dispatch`,
      );
    }
    return delivered;
  }

  /** Number of queued events not yet delivered. */
  pending(): number {
    return this.queue.length - this.head;
  }

  /** Drops every queued event, including the rest of a running dispatch. Subscriptions are kept. */
  clear(): void {
    this.queue.length = 0;
    this.head = 0;
  }

  private deliver({ type, payload }: QueuedEvent<M>): void {
    // Snapshot both lists before any handler runs.
    const typed = this.handlers.get(type) ?? NO_SUBSCRIPTIONS;
    const catchAll = this.anyHandlers;
    for (const { handler } of typed) {
      try {
        handler(payload);
      } catch (error) {
        this.reportError(type, handler, 'handler', error);
      }
    }
    for (const { handler } of catchAll) {
      try {
        handler(type, payload);
      } catch (error) {
        this.reportError(type, handler, 'onAny handler', error);
      }
    }
  }

  private reportError(type: keyof M, handler: object, kind: string, error: unknown): void {
    let logged = this.loggedErrors.get(type);
    if (logged === undefined) {
      logged = new WeakSet<object>();
      this.loggedErrors.set(type, logged);
    }
    if (logged.has(handler)) return;
    logged.add(handler);
    this.logger.error(`EventBus: ${kind} for "${String(type)}" threw (further errors from it are not logged)`, error);
  }
}

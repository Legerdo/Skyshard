import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type EventBusOptions, type EventLogger } from '../../../src/core/eventBus';

type TestEvents = {
  a: { readonly n: number };
  b: { readonly s: string };
  c: { readonly ok: boolean };
  tick: number;
};

interface FakeLogger extends EventLogger {
  readonly warnings: string[];
  readonly errors: { message: string; error: unknown }[];
}

function fakeLogger(): FakeLogger {
  const warnings: string[] = [];
  const errors: { message: string; error: unknown }[] = [];
  return {
    warnings,
    errors,
    warn(message) {
      warnings.push(message);
    },
    error(message, error) {
      errors.push({ message, error });
    },
  };
}

function setup(options: Omit<EventBusOptions, 'logger'> = {}): {
  bus: EventBus<TestEvents>;
  logger: FakeLogger;
} {
  const logger = fakeLogger();
  return { bus: new EventBus<TestEvents>({ ...options, logger }), logger };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EventBus delivery', () => {
  it('only queues on emit, then delivers FIFO across event types with handlers in registration order', () => {
    const { bus, logger } = setup();
    const seen: string[] = [];
    bus.on('a', (p) => seen.push(`a${p.n}`));
    bus.on('b', (p) => seen.push(`b:${p.s}`));
    bus.on('a', (p) => seen.push(`a${p.n}'`));
    bus.emit('a', { n: 1 });
    bus.emit('b', { s: 'x' });
    bus.emit('c', { ok: true });
    bus.emit('a', { n: 2 });
    bus.emit('b', { s: 'y' });

    expect(seen).toEqual([]);
    expect(bus.pending()).toBe(5);
    expect(bus.dispatch()).toBe(5);
    expect(seen).toEqual(['a1', "a1'", 'b:x', 'a2', "a2'", 'b:y']);
    expect(bus.pending()).toBe(0);
    expect(bus.dispatch()).toBe(0);
    expect(logger.warnings).toEqual([]);
    expect(logger.errors).toEqual([]);
  });

  it('delivers events emitted during dispatch in the same dispatch, after earlier events (a → b → c)', () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on('a', (p) => {
      seen.push(`a${p.n}`);
      bus.emit('b', { s: `from a${p.n}` });
    });
    bus.on('b', (p) => {
      seen.push(`b:${p.s}`);
      bus.emit('c', { ok: true });
    });
    bus.on('c', () => seen.push('c'));
    bus.on('tick', (t) => seen.push(`tick${t}`));
    bus.emit('a', { n: 1 });
    bus.emit('tick', 7);

    expect(bus.dispatch()).toBe(4);
    expect(seen).toEqual(['a1', 'tick7', 'b:from a1', 'c']);
    expect(bus.pending()).toBe(0);
  });

  it('types payloads per event and passes the emitted object to every handler as is', () => {
    const { bus } = setup();
    const payload: TestEvents['b'] = { s: 'x' };
    const received: TestEvents['b'][] = [];
    bus.on('b', (p) => received.push(p));
    bus.on('b', (p) => received.push(p));
    bus.emit('b', payload);
    bus.dispatch();
    expect(received).toHaveLength(2);
    expect(received.every((p) => p === payload)).toBe(true);

    // Compile-time checks only (verified by `tsc --noEmit`); never called.
    const typeChecks = (): void => {
      // @ts-expect-error the payload must match the event type
      bus.emit('a', { s: 'x' });
      // @ts-expect-error unknown event type
      bus.emit('missing', {});
      // @ts-expect-error a handler receives the payload type of its event
      bus.on('tick', (p: string) => p);
    };
    void typeChecks;
  });
});

describe('EventBus per-dispatch cap', () => {
  it('carries events beyond maxPerDispatch over to the next dispatch in order and warns once', () => {
    const { bus, logger } = setup({ maxPerDispatch: 5 });
    const seen: number[] = [];
    bus.on('tick', (t) => seen.push(t));
    for (let t = 1; t <= 8; t += 1) bus.emit('tick', t);

    expect(bus.dispatch()).toBe(5);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(bus.pending()).toBe(3);
    expect(logger.warnings).toEqual([expect.stringContaining('3 event(s) carried over')]);

    expect(bus.dispatch()).toBe(3);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(bus.pending()).toBe(0);
    expect(logger.warnings).toHaveLength(1);
  });

  it('does not warn when the queue drains exactly at the cap', () => {
    const { bus, logger } = setup({ maxPerDispatch: 5 });
    for (let t = 1; t <= 5; t += 1) bus.emit('tick', t);
    expect(bus.dispatch()).toBe(5);
    expect(bus.pending()).toBe(0);
    expect(logger.warnings).toEqual([]);
  });

  it('defaults to 1,024 deliveries per dispatch, counting events emitted during it', () => {
    const { bus, logger } = setup();
    let deliveries = 0;
    bus.on('tick', (t) => {
      deliveries += 1;
      bus.emit('tick', t + 1); // runaway chain
    });
    bus.emit('tick', 0);

    expect(bus.dispatch()).toBe(1024);
    expect(deliveries).toBe(1024);
    expect(bus.pending()).toBe(1);
    expect(logger.warnings).toHaveLength(1);
    expect(bus.dispatch()).toBe(1024);
    expect(logger.warnings).toHaveLength(2);
  });

  it('rejects a maxPerDispatch that is not a positive integer', () => {
    for (const maxPerDispatch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new EventBus<TestEvents>({ maxPerDispatch }), String(maxPerDispatch)).toThrow(RangeError);
    }
  });
});

describe('EventBus handler errors', () => {
  it('isolates a throwing handler and logs its error once per (event type, handler) pair', () => {
    const { bus, logger } = setup();
    const boom = new Error('boom');
    const thrower = (): void => {
      throw boom;
    };
    const seen: string[] = [];
    bus.on('a', thrower);
    bus.on('a', (p) => seen.push(`a${p.n}`));
    bus.emit('a', { n: 1 });
    bus.emit('a', { n: 2 });

    expect(bus.dispatch()).toBe(2);
    expect(seen).toEqual(['a1', 'a2']);
    expect(logger.errors).toEqual([{ message: expect.stringContaining('"a"'), error: boom }]);

    bus.emit('a', { n: 3 });
    bus.dispatch();
    expect(seen).toEqual(['a1', 'a2', 'a3']);
    expect(logger.errors).toHaveLength(1);

    bus.on('b', thrower);
    bus.emit('b', { s: 'x' });
    bus.dispatch();
    expect(logger.errors).toHaveLength(2);
    expect(logger.errors[1]).toEqual({ message: expect.stringContaining('"b"'), error: boom });
  });

  it('isolates a throwing onAny handler', () => {
    const { bus, logger } = setup();
    const seen: string[] = [];
    bus.onAny(() => {
      throw new Error('any');
    });
    bus.onAny((type) => seen.push(String(type)));
    bus.emit('a', { n: 1 });
    bus.emit('a', { n: 2 });
    bus.emit('b', { s: 'x' });

    expect(bus.dispatch()).toBe(3);
    expect(seen).toEqual(['a', 'a', 'b']);
    expect(logger.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('"a"'),
      expect.stringContaining('"b"'),
    ]);
  });

  it('falls back to console.warn / console.error without an injected logger', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bus = new EventBus<TestEvents>({ maxPerDispatch: 1 });
    const boom = new Error('boom');
    bus.on('tick', () => {
      throw boom;
    });
    bus.emit('tick', 1);
    bus.emit('tick', 2);

    expect(bus.dispatch()).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"tick"'), boom);
  });
});

describe('EventBus subscriptions during dispatch', () => {
  it("unsubscribing in a handler stops later events but not the current event's remaining handlers", () => {
    const { bus } = setup();
    const seen: string[] = [];
    let offSecond = (): void => undefined;
    bus.on('a', (p) => {
      seen.push(`first${p.n}`);
      offSecond();
    });
    offSecond = bus.on('a', (p) => seen.push(`second${p.n}`));
    const offSelf = bus.on('a', (p) => {
      seen.push(`self${p.n}`);
      offSelf();
    });
    bus.emit('a', { n: 1 });
    bus.emit('a', { n: 2 });

    expect(bus.dispatch()).toBe(2);
    expect(seen).toEqual(['first1', 'second1', 'self1', 'first2']);
  });

  it('unsubscribe is idempotent and removes only its own registration', () => {
    const { bus } = setup();
    const seen: number[] = [];
    const handler = (p: TestEvents['a']): void => {
      seen.push(p.n);
    };
    const offFirst = bus.on('a', handler);
    const offSecond = bus.on('a', handler);
    offFirst();
    offFirst();
    bus.emit('a', { n: 1 });
    bus.dispatch();
    expect(seen).toEqual([1]);

    offSecond();
    bus.emit('a', { n: 2 });
    expect(bus.dispatch()).toBe(1);
    expect(seen).toEqual([1]);
  });

  it('handlers subscribed during dispatch receive only subsequent events', () => {
    const { bus } = setup();
    const late: string[] = [];
    bus.on('a', (p) => {
      if (p.n !== 1) return;
      bus.on('a', (q) => late.push(`a${q.n}`));
      bus.onAny((type) => late.push(`any:${String(type)}`));
    });
    bus.emit('a', { n: 1 });
    bus.emit('a', { n: 2 });
    bus.emit('b', { s: 'x' });

    expect(bus.dispatch()).toBe(3);
    expect(late).toEqual(['a2', 'any:a', 'any:b']);
  });
});

describe('EventBus onAny', () => {
  it('receives every event in emit order, after the typed handlers', () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on('a', (p) => seen.push(`typed:a${p.n}`));
    const off = bus.onAny((type, payload) => seen.push(`any:${String(type)}:${JSON.stringify(payload)}`));
    bus.on('tick', (t) => seen.push(`typed:tick${t}`));
    bus.emit('a', { n: 1 });
    bus.emit('b', { s: 'x' });
    bus.emit('tick', 3);

    expect(bus.dispatch()).toBe(3);
    expect(seen).toEqual(['typed:a1', 'any:a:{"n":1}', 'any:b:{"s":"x"}', 'typed:tick3', 'any:tick:3']);

    off();
    bus.emit('c', { ok: true });
    expect(bus.dispatch()).toBe(1);
    expect(seen).toHaveLength(5);
  });
});

describe('EventBus dispatch guard and clear', () => {
  it('returns 0 from a re-entrant dispatch while the outer dispatch keeps delivering', () => {
    const { bus } = setup();
    const seen: string[] = [];
    const inner: number[] = [];
    bus.on('a', () => {
      inner.push(bus.dispatch());
      seen.push('a');
    });
    bus.on('b', (p) => seen.push(`b:${p.s}`));
    bus.emit('a', { n: 1 });
    bus.emit('b', { s: 'x' });

    expect(bus.dispatch()).toBe(2);
    expect(inner).toEqual([0]);
    expect(seen).toEqual(['a', 'b:x']);

    bus.emit('b', { s: 'y' });
    expect(bus.dispatch()).toBe(1);
    expect(seen).toEqual(['a', 'b:x', 'b:y']);
  });

  it('clear empties the queue, also from a handler mid-dispatch, and keeps subscriptions', () => {
    const { bus } = setup();
    const seen: string[] = [];
    bus.on('b', (p) => seen.push(`b:${p.s}`));
    bus.emit('b', { s: 'x' });
    bus.emit('tick', 1);
    bus.clear();
    expect(bus.pending()).toBe(0);
    expect(bus.dispatch()).toBe(0);
    expect(seen).toEqual([]);

    const offClear = bus.on('a', () => bus.clear());
    bus.emit('a', { n: 1 });
    bus.emit('b', { s: 'dropped' });
    expect(bus.dispatch()).toBe(1);
    expect(bus.pending()).toBe(0);
    expect(seen).toEqual([]);

    offClear();
    bus.emit('b', { s: 'kept' });
    expect(bus.dispatch()).toBe(1);
    expect(seen).toEqual(['b:kept']);
  });
});

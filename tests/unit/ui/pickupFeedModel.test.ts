import { describe, expect, it } from 'vitest';
import { PICKUP_LINE_SECONDS, PICKUP_MAX_LINES, PickupFeedModel } from '../../../src/ui/models/pickupFeedModel';

// HUD pickup feed queue (task 12.7; Req 30.6): 3 s per line, at most 5 at once, the rest wait in order.

describe('PickupFeedModel', () => {
  it('shows up to 5 lines for 3 s each and lets waiting lines in as rows free up', () => {
    expect([PICKUP_LINE_SECONDS, PICKUP_MAX_LINES]).toEqual([3, 5]);
    const feed = new PickupFeedModel();
    for (let i = 1; i <= 7; i++) feed.push({ name: `item ${i}`, icon: 'material', count: i });
    expect(feed.lines().map((l) => l.name)).toEqual(['item 1', 'item 2', 'item 3', 'item 4', 'item 5']);
    expect(feed.pending).toBe(2);
    feed.update(2.9);
    expect(feed.lines()).toHaveLength(5);
    feed.update(0.2);
    // The first five expired together; the two waiting lines come in.
    expect(feed.lines().map((l) => [l.name, l.age])).toEqual([['item 6', 0], ['item 7', 0]]);
    expect(feed.pending).toBe(0);
    feed.update(3);
    expect(feed.lines()).toEqual([]);
  });

  it('ignores empty grants and keeps keys unique', () => {
    const feed = new PickupFeedModel();
    feed.push({ name: 'Glim', icon: 'glim', count: 0 });
    feed.push({ name: '', icon: 'glim', count: 3 });
    feed.push({ name: 'Glim', icon: 'glim', count: 45 });
    feed.push({ name: '허브 경단', icon: 'consumable', count: 1 });
    const keys = feed.lines().map((l) => l.key);
    expect(feed.lines().map((l) => l.count)).toEqual([45, 1]);
    expect(new Set(keys).size).toBe(2);
  });
});

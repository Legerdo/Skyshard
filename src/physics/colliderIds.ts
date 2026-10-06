// Collider id source: collider ids must be unique across a CollisionWorld's static and dynamic sets, so every
// system that builds colliders for one world draws its ids from one shared source. Pure TypeScript.

export class ColliderIdSource {
  private nextId: number;

  /** Ids start at `first` (a positive integer, default 1) and count up. */
  constructor(first = 1) {
    if (!(Number.isSafeInteger(first) && first > 0)) throw new RangeError(`ColliderIdSource: first must be a positive integer, got ${first}`);
    this.nextId = first;
  }

  next(): number {
    return this.nextId++;
  }
}

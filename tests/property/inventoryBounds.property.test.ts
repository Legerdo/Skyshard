// Feature: skyshard-echoes-of-the-wild, Property 23: 인벤토리와 Glim 경계
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../src/core/gameEvents';
import type { ItemId } from '../../src/data/ids';
import { SHOP_STOCK, STARTING_ITEMS } from '../../src/data/items';
import { InventorySystem } from '../../src/inventory/inventorySystem';
import { addGlim, addItem, purchase, useItem, type Inventory } from '../../src/logic/inventory';
import { createNewGameState } from '../../src/logic/save/gameState';
import { shopRows } from '../../src/ui/models/shopModel';

const CAP = 10;
// Shop consumables, a consumable without a definition (default cap), a material and equipment.
const IDS: readonly ItemId[] = [
  'con_herbDumpling',
  'con_emberFeather',
  'con_unlisted',
  'mat_starmote',
  'chm_ember_ribbon',
  'chm_feather_bell',
  'wpn_talus_bulwark',
  'rlc_ember_core',
];

type Op =
  | { op: 'add'; id: ItemId; n: number }
  | { op: 'use'; id: ItemId }
  | { op: 'buy'; id: ItemId; price: number }
  | { op: 'glim'; amount: number };

/** arbInventoryOps: gains (negative = consumption), uses, purchases and Glim changes. */
const arbId = fc.constantFrom(...IDS);
const arbOps: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(
    fc.record({ op: fc.constant('add' as const), id: arbId, n: fc.integer({ min: -6, max: 12 }) }),
    fc.record({ op: fc.constant('use' as const), id: arbId }),
    fc.record({ op: fc.constant('buy' as const), id: arbId, price: fc.integer({ min: 0, max: 400 }) }),
    fc.record({ op: fc.constant('glim' as const), amount: fc.integer({ min: -500, max: 500 }) }),
  ),
  { minLength: 1, maxLength: 60, size: 'max' },
);

const count = (inv: Inventory, id: ItemId): number => inv.items[id] ?? 0;
const isEquipment = (id: ItemId): boolean => !id.startsWith('con_') && !id.startsWith('mat_');
const freeze = (inv: Inventory): Inventory =>
  Object.freeze({ ...inv, items: Object.freeze({ ...inv.items }), ownedEquipment: Object.freeze([...inv.ownedEquipment]) });

/** Broken invariant of a state, or null. */
function boundsViolation(inv: Inventory): string | null {
  if (!(inv.glim >= 0)) return `glim ${inv.glim} < 0`;
  for (const [id, n] of Object.entries(inv.items)) {
    if (n === undefined || !Number.isInteger(n) || n < 0) return `${id} count ${n}`;
    if (id.startsWith('con_') && n > CAP) return `${id} count ${n} > ${CAP}`;
  }
  return new Set(inv.ownedEquipment).size === inv.ownedEquipment.length ? null : 'duplicate equipment';
}

type Seen = Record<'bought' | 'owned' | 'cap' | 'glim', number>;

/** Applies one op to a frozen state (so mutation throws) and checks it against the model. */
function step(inv: Inventory, op: Op, seen: Seen): { next: Inventory; error: string | null } {
  if (op.op === 'glim') {
    const next = addGlim(inv, op.amount);
    return { next, error: next.glim === Math.max(0, inv.glim + op.amount) ? null : `addGlim(${op.amount})` };
  }
  if (op.op === 'add') {
    const next = addItem(inv, op.id, op.n);
    const want = isEquipment(op.id)
      ? Number(inv.ownedEquipment.includes(op.id) || op.n > 0)
      : op.id.startsWith('con_')
        ? Math.min(CAP, Math.max(0, count(inv, op.id) + op.n))
        : Math.max(0, count(inv, op.id) + op.n);
    const got = isEquipment(op.id) ? Number(next.ownedEquipment.includes(op.id)) : count(next, op.id);
    return { next, error: got === want ? null : `add ${op.id} ${op.n}: ${got} ≠ ${want}` };
  }
  if (op.op === 'use') {
    const res = useItem(inv, op.id);
    const can = op.id.startsWith('con_') && count(inv, op.id) >= 1;
    const ok = res.ok === can && count(res.inv, op.id) === count(inv, op.id) - (can ? 1 : 0);
    return { next: res.inv, error: ok ? null : `use ${op.id}` };
  }
  const before = JSON.stringify(inv);
  const res = purchase(inv, op.id, op.price);
  const missing = inv.glim < op.price ? op.price - inv.glim : undefined;
  const reason =
    isEquipment(op.id) && inv.ownedEquipment.includes(op.id)
      ? 'owned'
      : op.id.startsWith('con_') && count(inv, op.id) >= CAP
        ? 'cap'
        : missing !== undefined
          ? 'glim'
          : null;
  const label = `buy ${op.id} @${op.price} with ${inv.glim}`;
  if (!res.ok) {
    seen[res.reason]++;
    if (res.reason !== reason || res.missing !== missing) return { next: inv, error: `${label}: ${res.reason}/${res.missing}` };
    return { next: inv, error: JSON.stringify(inv) === before ? null : `${label}: refused but changed` };
  }
  seen.bought++;
  if (reason !== null) return { next: res.inv, error: `${label}: should be refused (${reason})` };
  const gained = isEquipment(op.id) ? res.inv.ownedEquipment.includes(op.id) : count(res.inv, op.id) === count(inv, op.id) + 1;
  return { next: res.inv, error: res.inv.glim === inv.glim - op.price && gained ? null : `${label}: wrong result` };
}

describe('Property 23: purchase against any Glim and price', () => {
  const arbInv = fc.record({
    glim: fc.integer({ min: 0, max: 5_000 }),
    herbs: fc.integer({ min: 0, max: 10 }),
    ownsRibbon: fc.boolean(),
  });

  it('succeeds only when glim ≥ price, leaving glim − price ≥ 0; short Glim gives ok false and missing = price − glim', () => {
    fc.assert(
      fc.property(arbInv, fc.constantFrom(...IDS), fc.integer({ min: 0, max: 5_000 }), ({ glim, herbs, ownsRibbon }, id, price) => {
        const inv = freeze({ glim, items: { con_herbDumpling: herbs }, ownedEquipment: ownsRibbon ? ['chm_ember_ribbon'] : [] });
        const before = JSON.stringify(inv);
        const res = purchase(inv, id, price);
        if (res.ok) {
          expect(glim).toBeGreaterThanOrEqual(price);
          expect(res.inv.glim).toBe(glim - price);
          expect(res.inv.glim).toBeGreaterThanOrEqual(0);
        } else {
          expect(JSON.stringify(inv)).toBe(before);
          if (glim < price) expect(res.missing).toBe(price - glim);
          else expect(res.missing).toBeUndefined();
        }
        if (glim < price) expect(res.ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("Pip's shop rows and the Inventory_System use the same judgement as purchase", () => {
    fc.assert(
      fc.property(arbInv, ({ glim, herbs, ownsRibbon }) => {
        const gs = createNewGameState(1);
        gs.inventory.glim = glim;
        gs.inventory.items.con_herbDumpling = herbs;
        gs.inventory.ownedEquipment = ownsRibbon ? ['chm_ember_ribbon'] : [];
        const rows = shopRows(gs);
        for (const [i, entry] of SHOP_STOCK.entries()) {
          const row = rows[i];
          const res = purchase({ ...gs.inventory, items: { ...gs.inventory.items } }, entry.id, entry.price);
          expect(row?.enabled).toBe(res.ok);
          expect(row?.reason ?? null).toBe(res.ok ? null : res.reason);
          expect(row?.missingGlim).toBe(res.ok ? 0 : (res.missing ?? 0));
        }
        // Applying one purchase through the Inventory_System matches the pure result.
        const bus = createGameEventBus();
        const system = new InventorySystem({ state: gs, bus });
        const entry = SHOP_STOCK[glim % SHOP_STOCK.length];
        if (entry === undefined) return;
        const pure = purchase({ ...gs.inventory, items: { ...gs.inventory.items } }, entry.id, entry.price);
        const before = structuredClone(gs.inventory);
        const applied = system.purchase(entry.id);
        expect(applied.ok).toBe(pure.ok);
        if (pure.ok) expect(gs.inventory).toEqual({ ...pure.inv, ownedEquipment: [...pure.inv.ownedEquipment] });
        else expect(gs.inventory).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});

describe('Property 23: inventory and Glim bounds', () => {
  it('keeps consumables in 0..10, materials ≥ 0 and Glim ≥ 0; purchase refuses owned → cap → glim without changes', () => {
    const seen: Seen = { bought: 0, owned: 0, cap: 0, glim: 0 };
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1500 }), arbOps, (glim, ops) => {
        let inv = freeze({ glim, items: { ...STARTING_ITEMS }, ownedEquipment: [] });
        let error: string | null = null;
        for (const op of ops) {
          const result = step(inv, op, seen);
          error = result.error ?? boundsViolation(result.next);
          if (error !== null) break;
          inv = freeze(result.next);
        }
        expect(error).toBeNull();
      }),
      { numRuns: 200 },
    );
    // Guard against a vacuous pass: every outcome must actually occur.
    expect(Math.min(seen.bought, seen.owned, seen.cap, seen.glim)).toBeGreaterThan(5);
  });
});

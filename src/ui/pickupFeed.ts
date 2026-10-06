import './pickupFeed.css';
import type { ItemId } from '../data/ids';
import { ITEM_BY_ID } from '../data/items';
import { PICKUP_LINE_SECONDS, PickupFeedModel, type PickupIconKind } from './models/pickupFeedModel';

/*
 * HUD pickup feed on the right side (task 12.7; Req 30.6, 28.13, 10.5): "잿불송곳니 ×1", "Glim +45", 3 s per line, at
 * most 5 lines, the rest queued (PickupFeedModel). Each line has a small shape icon by item kind, so the kind does not
 * rest on colour alone. Real time from the render loop; no input (role status, aria-live polite).
 */

const FADE = 0.25;

export class PickupFeed {
  private readonly root: HTMLDivElement;
  private readonly model = new PickupFeedModel();
  private readonly rows = new Map<number, HTMLDivElement>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pickup-feed';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    parent.append(this.root);
  }

  /** An item grant ('item:granted'). Unknown ids show the id itself. */
  item(itemId: ItemId, count: number): void {
    const def = ITEM_BY_ID.get(itemId);
    const icon: PickupIconKind = def?.kind ?? 'material';
    this.model.push({ name: def?.name ?? itemId, icon, count });
  }

  /** Glim received (Chest rewards, caches). */
  glim(amount: number): void {
    this.model.push({ name: 'Glim', icon: 'glim', count: Math.round(amount) });
  }

  update(realDt: number): void {
    this.model.update(realDt);
    const lines = this.model.lines();
    const keep = new Set(lines.map((l) => l.key));
    for (const [key, row] of this.rows) {
      if (keep.has(key)) continue;
      row.remove();
      this.rows.delete(key);
    }
    for (const l of lines) {
      let row = this.rows.get(l.key);
      if (row === undefined) {
        row = document.createElement('div');
        row.className = `pickup-feed__line pickup-feed__line--${l.icon}`;
        const mark = document.createElement('span');
        mark.className = 'pickup-feed__icon';
        mark.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span');
        name.className = 'pickup-feed__name';
        name.textContent = l.name;
        const count = document.createElement('span');
        count.className = 'pickup-feed__count';
        count.textContent = l.icon === 'glim' ? `+${l.count}` : `×${l.count}`;
        row.append(mark, name, count);
        this.root.append(row);
        this.rows.set(l.key, row);
      }
      const opacity = Math.max(0, Math.min(1, l.age / FADE, (PICKUP_LINE_SECONDS - l.age) / FADE));
      row.style.opacity = String(Math.round(opacity * 100) / 100);
    }
  }
}

// Debug_Tools operations (design "Debug_Tools", Req 41.1, 41.3, 41.4): the panel (./debugPanel, `?debug=1` only)
// queues `debug` UiCommands; PlaySim.apply hands each one to DebugTools.apply at the start of the next tick, which
// runs it through the owning systems' normal public methods (DebugHost): the Party_System's join, the
// Inventory_System's Glim grant, the World's Skyshard acquisition, the fast-travel move and world refresh, the Caelith
// fight's begin. The only state kept here is the two toggles the simulation and the panel read (`invincible`,
// `showAi`). The first applied operation sets GameState.debugUsed (saved) and calls `onFirstUse` (the session flag).
// Pure TypeScript: no three.js / DOM.

import type { DebugAction } from '../core/uiCommands';
import { PLAY_RADIUS } from '../data/worldLayout';

/** Glim one "Glim 지급" press adds. */
export const DEBUG_GLIM_GRANT = 1000;
/** Largest Glim grant one command may carry. */
const MAX_GLIM_GRANT = 1_000_000;

/** The normal public paths the operations go through. */
export interface DebugHost {
  /** GameState: `debugUsed` is set on the first operation. */
  readonly state: { debugUsed: boolean };
  /** Every companion not yet joined joins (Party_System join, 'party:joined' as usual). */
  joinAll(): void;
  /** Inventory_System Glim grant. */
  addGlim(amount: number): void;
  /** The next Skyshard through the World's acquisition ('skyshard:acquired'); false when all three are held. */
  grantSkyshard(): boolean;
  /** Fast travel's move and world refresh to the ground at (x, z); whether the character was moved. */
  travelTo(x: number, z: number): boolean;
  /** Into the Caelith arena and BossEncounter.begin from the first Phase; whether the character was moved. */
  bossDirect(): boolean;
}

export class DebugTools {
  /** Hits on the Active_Character are ignored (the receiver's invulnerability, as in the Burst cut-in). */
  invincible = false;
  /** The panel draws AI state, Telegraph time and HP above enemies within 60 m. */
  showAi = false;
  private readonly host: DebugHost;
  private readonly onFirstUse: (() => void) | undefined;
  private used = false;

  constructor(host: DebugHost, onFirstUse?: () => void) {
    this.host = host;
    this.onFirstUse = onFirstUse;
  }

  /** Applies one operation; returns whether the Active_Character was moved (the camera snaps). */
  apply(action: DebugAction): boolean {
    if (!isValid(action)) return false;
    this.markUsed();
    switch (action.op) {
      case 'invincible':
        this.invincible = action.on;
        return false;
      case 'showAi':
        this.showAi = action.on;
        return false;
      case 'joinAll':
        this.host.joinAll();
        return false;
      case 'grantGlim':
        this.host.addGlim(Math.floor(action.amount));
        return false;
      case 'grantSkyshard':
        this.host.grantSkyshard();
        return false;
      case 'teleport':
        return this.host.travelTo(action.x, action.z);
      case 'bossDirect':
        return this.host.bossDirect();
      default:
        return false;
    }
  }

  private markUsed(): void {
    this.host.state.debugUsed = true;
    if (this.used) return;
    this.used = true;
    this.onFirstUse?.();
  }
}

function isValid(action: DebugAction): boolean {
  switch (action.op) {
    case 'invincible':
    case 'showAi':
      return typeof action.on === 'boolean';
    case 'grantGlim':
      return Number.isFinite(action.amount) && action.amount >= 1 && action.amount <= MAX_GLIM_GRANT;
    case 'teleport':
      return Number.isFinite(action.x) && Number.isFinite(action.z) && Math.hypot(action.x, action.z) <= PLAY_RADIUS;
    case 'joinAll':
    case 'grantSkyshard':
    case 'bossDirect':
      return true;
    default:
      return false;
  }
}

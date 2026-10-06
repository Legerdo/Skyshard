// Camera impulses of strong hits (design "흔들림과 impulse"; Req 26.3, 26.4), from the one hit-feel table
// (logic/hitFeel). 'burst:cast' (0.5) and explosive 'reaction's (0.4) come from the bus; a Charged_Attack's final
// hit (0.35) from the Combat_System's onHit hook; an Element_Shield or Starshell break (0.4) from the VfxSystem that
// sees it. Positioned sources fade with their distance from the Active_Character (15 m → 30 m). Normal_Attack hits
// add nothing. The Hit_Stop itself is requested by the simulation (same table).

import type { HitResult } from '../combat/attackRuntime';
import type { GameEventBus } from '../core/gameEvents';
import { distance } from '../core/math';
import type { Vec3 } from '../core/types';
import { HIT_FEEL, hitFeelOfHit, reactionHitFeel, traumaAt } from '../logic/hitFeel';

export interface HitFeelCameraOptions {
  bus: GameEventBus;
  /** Camera_System.addTrauma (the Settings shake multiplier is applied there). */
  addTrauma(amount: number): void;
  /** The Active_Character's feet. */
  focus(): Readonly<Vec3>;
}

export class HitFeelCamera {
  private readonly o: HitFeelCameraOptions;
  private readonly unsubscribe: (() => void)[];

  constructor(options: HitFeelCameraOptions) {
    this.o = options;
    this.unsubscribe = [
      options.bus.on('burst:cast', () => this.add(HIT_FEEL.burstCast.trauma, null)),
      options.bus.on('reaction', (e) => this.add(reactionHitFeel(e.reaction).trauma, e.position)),
    ];
  }

  /** A party hit landed (PlayerCombat onHit). */
  hit(r: Readonly<HitResult>): void {
    this.add(hitFeelOfHit(r.hit.kind, r.hit.attackId, r.hit.hitIndex).trauma, r.receiver.hurtVolume().pos);
  }

  /** An Element_Shield (or the Starshell) broke at `pos`. */
  shieldBreak(pos: Readonly<Vec3>, starshell: boolean): void {
    this.add((starshell ? HIT_FEEL.starshellBreak : HIT_FEEL.shieldBreak).trauma, pos);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private add(trauma: number, at: Readonly<Vec3> | null): void {
    const amount = traumaAt(trauma, at === null ? 0 : distance(at, this.o.focus()));
    if (amount > 0) this.o.addTrauma(amount);
  }
}

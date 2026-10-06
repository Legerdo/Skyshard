/*
 * The Audio_System's Web Audio graph (design "오디오 그래프", "자동 재생 정책", task 16.1–16.4; Req 37.4–37.6):
 *
 *   track gains ─┐                      (music reverb ─┐)
 *                └─► musicBus ───────────────────────┴──► master 0.8 ─► limiter (−6 dB, ratio 12) ─► destination
 *   ui / world / ambient / voice ─► sfxBus ◄── sfx reverb ┘
 *
 * One AudioContext per page. `musicBus` and `sfxBus` carry the Settings on/off and volume (volume², 0.05 s linear
 * ramps), so Music OFF leaves the effects alone and SFX OFF leaves the music alone. Each bus has its own
 * ConvolverNode sharing one seeded 2 s impulse (RT60 ≈ 1.8 s); the reverb returns join in front of the bus gain, so
 * a muted bus mutes its tails too. A muted bus gets no new note nodes, while the sequencer keeps counting steps.
 *
 * Until the context runs (autoplay policy) every play call is a no-op; `playMusic` and `setAmbient` remember the
 * last request. Capture-phase `pointerdown` / `keydown` on the window call `unlock()`; a refused or still-suspended
 * resume keeps the listeners for the next input. Once running, the listeners go and the remembered track and bed
 * start; afterwards a hidden tab suspends the context and a visible one resumes it.
 *
 * Sound effects: `sfx(id)` plays the CC0 file of that id when one was decoded (task 16.4), else its recipe
 * (src/audio/sfxRecipes.ts). World sounds are spatialized from the listener (src/audio/spatial.ts), at most 32
 * voices sound at once (src/audio/voicePool.ts), loops (Updraft / Wind_Zone, glide wind, ambient beds) follow their
 * callers. Music: TrackPlayers (src/audio/sequencer.ts) booked by a 25 ms timer 0.12 s ahead of the audio clock.
 */

import { createRng, type Rng } from '../core/rng';
import type { Vec3 } from '../core/types';
import type { SfxId } from '../data/ids';
import { TRACKS, type MusicMode, type MusicTrackId, type PitchClass } from '../data/music';
import {
  AMBIENT_DEFS, AMBIENT_FADE_SECONDS, INTERMITTENT_MAX_SECONDS, INTERMITTENT_MIN_SECONDS, type AmbientId,
} from './ambient';
import { LOOKAHEAD_SECONDS, SCHEDULER_INTERVAL_MS, TrackPlayer, type SequencerHost } from './sequencer';
import { sfxRecipe, voiceBlipRecipe, type SfxRecipe } from './sfxRecipes';
import { renderRecipe } from './sfxSynth';
import { spatialize, type Listener } from './spatial';
import { createImpulseBuffer, createNoiseBuffer, dbToGain, type SynthKit } from './synthKit';
import { MAX_VOICES, pickVictim, type SfxGroup } from './voicePool';

// ── Constants ───────────────────────────────────────────────────────────────

/** Master gain (headroom for the limiter). */
export const MASTER_GAIN = 0.8;
/** Soft limiter (DynamicsCompressorNode). */
export const LIMITER = { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.25 } as const;
/** Bus on/off and volume ramps reach their target this fast (s); the Settings budget is 0.1 s (Req 37.5). */
export const BUS_RAMP_SECONDS = 0.05;
/** Shared reverb impulse: length and RT60 (s). */
export const REVERB_SECONDS = 2;
export const REVERB_RT60 = 1.8;
/** Default music crossfade (s). */
export const DEFAULT_MUSIC_FADE = 2;
/** Glide wind (Req 19.10): smoothing of gain and cutoff (s to ~95 %), fade-out at the end, cutoff range (Hz). */
export const GLIDE_SMOOTHING_SECONDS = 0.2;
export const GLIDE_FADE_OUT_SECONDS = 0.3;
export const GLIDE_CUTOFF_MIN = 500;
export const GLIDE_CUTOFF_MAX = 4000;
/** Updraft / Wind_Zone loops: fade in / out (s) and the smoothing of their 15 Hz position updates. */
const LOOP_FADE_SECONDS = 0.5;
const LOOP_SMOOTHING = 0.05;
/** A voice stopped to make room fades this fast (s). */
const VOICE_STEAL_FADE = 0.02;
/** Random pan range of the ambient intermittent sounds. */
const INTERMITTENT_PAN = 0.7;
/** Seconds of shared noise. */
const NOISE_SECONDS = 3;
/** Default seed of the engine's noise, impulse and variation streams. */
const DEFAULT_SEED = 0x5eed_a0d1;

// ── Options ─────────────────────────────────────────────────────────────────

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface AudioTimer {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface AudioEngineOptions {
  /** The page's one AudioContext (tests: a fake). */
  readonly ctx: AudioContext;
  /** Where the first-input unlock listens (the window, capture phase); null: the caller unlocks. */
  readonly inputTarget?: Listenable | null;
  /** The document: `visibilitychange` suspends / resumes once unlocked; null: none. */
  readonly visibility?: (Listenable & { readonly hidden: boolean }) | null;
  /** The 25 ms scheduler timer; null: the caller calls pump(). */
  readonly timer?: AudioTimer | null;
  readonly seed?: number;
  readonly warn?: (message: string) => void;
}

export interface SfxOptions {
  /** World position: distance gain and pan from the listener (world group only); beyond 60 m nothing plays. */
  readonly pos?: Readonly<Vec3> | null;
  /** Pitch factor (every frequency / the file's playback rate). */
  readonly pitch?: number;
  /** Gain factor. */
  readonly gain?: number;
  /** Audio time to start (default now). */
  readonly at?: number;
}

/** A positioned loop the caller keeps alive (Updraft / Wind_Zone air, Req 19.8). */
export interface LoopEmitter {
  readonly key: string;
  readonly id: SfxId;
  readonly pos: Readonly<Vec3>;
}

/** Plain snapshot for the F3 panel and the test harness. */
export interface AudioDebugState {
  readonly context: string;
  readonly unlocked: boolean;
  readonly music: { readonly on: boolean; readonly volume: number; readonly target: number };
  readonly sfx: { readonly on: boolean; readonly volume: number; readonly target: number };
  /** Task 24.3 (Req 37.4): the flat fields the browser scenarios read — music on/off and the buses' current gains. */
  readonly musicOn: boolean;
  readonly sfxOn: boolean;
  readonly musicBusGain: number;
  readonly sfxBusGain: number;
  /** The track now faded in (or asked for while suspended), null for none. */
  readonly track: MusicTrackId | null;
  /** Every live TrackPlayer, fading ones included. */
  readonly tracks: readonly { readonly id: MusicTrackId; readonly fadingOut: boolean; readonly step: number; readonly fromFile: boolean }[];
  readonly pendingMusic: MusicTrackId | null;
  readonly ambient: AmbientId | null;
  readonly voices: number;
  readonly voicesByGroup: Readonly<Record<SfxGroup, number>>;
  readonly loops: readonly string[];
  readonly glideWind: number;
  readonly buffers: number;
  /** Music notes made so far. */
  readonly notes: number;
}

// ── Voices ──────────────────────────────────────────────────────────────────

interface Voice {
  readonly id: string;
  readonly group: SfxGroup;
  /** Heard loudness (recipe × caller × spatial gain): the 32-voice cap stops the quietest world voice first. */
  loudness: number;
  /** Gain before the spatial factor (loops rescale it at 15 Hz). */
  readonly baseGain: number;
  readonly out: GainNode;
  readonly panner: StereoPannerNode | null;
  readonly sources: AudioScheduledSourceNode[];
  readonly nodes: AudioNode[];
  /** Audio time the voice is silent (Infinity for loops). */
  readonly end: number;
  readonly loop: boolean;
  stopped: boolean;
}

interface PlayOptions {
  readonly t?: number;
  readonly pitch?: number;
  readonly gain?: number;
  readonly pos?: Readonly<Vec3> | null;
  readonly pan?: number;
  /** Loops: linear fade-in (s) from 0. */
  readonly fadeIn?: number;
  /** A node the sound runs through before the voice gain (the glide wind's lowpass). */
  readonly via?: AudioNode;
}

interface GlideWind {
  readonly voice: Voice;
  readonly filter: BiquadFilterNode;
  level: number;
}

const GROUPS: readonly SfxGroup[] = ['ui', 'world', 'ambient', 'voice'];
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

// ── Engine ──────────────────────────────────────────────────────────────────

export class AudioEngine {
  readonly ctx: AudioContext;
  /** The graph's fixed nodes (tests and the debug panel read them). */
  readonly nodes: {
    readonly master: GainNode;
    readonly limiter: DynamicsCompressorNode;
    readonly musicBus: GainNode;
    readonly sfxBus: GainNode;
    readonly musicReverb: ConvolverNode;
    readonly sfxReverb: ConvolverNode;
    readonly groups: Readonly<Record<SfxGroup, GainNode>>;
  };
  private readonly kit: SynthKit;
  private readonly rng: Rng;
  private readonly host: SequencerHost;
  private readonly inputTarget: Listenable | null;
  private readonly visibility: (Listenable & { readonly hidden: boolean }) | null;
  private readonly timer: AudioTimer | null;
  private readonly timerHandle: unknown = null;
  private readonly warn: (message: string) => void;
  private readonly warned = new Set<string>();

  private musicOn = true;
  private musicVolume = 1;
  private sfxOn = true;
  private sfxVolume = 1;
  private unlockedOnce = false;
  private listening = false;
  private unlocking: Promise<void> | null = null;
  private disposed = false;

  private tracks: TrackPlayer[] = [];
  private current: TrackPlayer | null = null;
  private wantedMusic: { readonly track: MusicTrackId; readonly fadeSec: number } | null = null;
  /** Key / mode `'inherit'` tracks (combat) take: the last place track's. */
  private inheritKey: PitchClass = 'D';
  private inheritMode: MusicMode = 'major';

  private voices: Voice[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private listener: Listener | null = null;
  private wantedAmbient: AmbientId | null = null;
  private ambientBed: { readonly id: AmbientId; readonly voice: Voice | null } | null = null;
  private nextIntermittent = Infinity;
  private glide: GlideWind | null = null;
  private readonly loops = new Map<string, Voice>();

  private readonly onInput = (): void => {
    void this.unlock();
  };
  private readonly onVisibility = (): void => this.visibilityChanged();

  constructor(o: AudioEngineOptions) {
    this.ctx = o.ctx;
    this.warn = o.warn ?? ((m) => console.warn(m));
    const seed = o.seed ?? DEFAULT_SEED;
    this.rng = createRng(seed);
    const { ctx } = this;

    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    master.connect(limiter);
    limiter.connect(ctx.destination);

    const impulse = createImpulseBuffer(ctx, createRng(seed ^ 0x2e7e7b), REVERB_SECONDS, REVERB_RT60);
    const musicBus = ctx.createGain();
    musicBus.gain.value = this.musicTarget();
    musicBus.connect(master);
    const musicReverb = ctx.createConvolver();
    musicReverb.buffer = impulse;
    musicReverb.connect(musicBus);
    const sfxBus = ctx.createGain();
    sfxBus.gain.value = this.sfxTarget();
    sfxBus.connect(master);
    const sfxReverb = ctx.createConvolver();
    sfxReverb.buffer = impulse;
    sfxReverb.connect(sfxBus);
    const groups = {} as Record<SfxGroup, GainNode>;
    for (const g of GROUPS) {
      const node = ctx.createGain();
      node.gain.value = 1;
      node.connect(sfxBus);
      groups[g] = node;
    }
    this.nodes = { master, limiter, musicBus, sfxBus, musicReverb, sfxReverb, groups };

    this.kit = { ctx, noise: createNoiseBuffer(ctx, createRng(seed ^ 0x6e015e), NOISE_SECONDS), rng: createRng(seed ^ 0x7a71) };
    this.host = {
      kit: this.kit,
      bus: musicBus,
      reverb: musicReverb,
      audible: () => this.musicAudible,
    };

    this.inputTarget = o.inputTarget ?? null;
    this.visibility = o.visibility ?? null;
    this.timer = o.timer ?? null;
    this.visibility?.addEventListener('visibilitychange', this.onVisibility);
    if (this.running) this.becameRunning();
    else this.listenForInput();
    if (this.timer !== null) this.timerHandle = this.timer.set(() => this.pump(), SCHEDULER_INTERVAL_MS);
  }

  // ── Context state ─────────────────────────────────────────────────────────

  /** The context runs: sounds can play. */
  get running(): boolean {
    return !this.disposed && this.ctx.state === 'running';
  }

  /** Whether the context has run at least once (the first input unlocked it). */
  get unlocked(): boolean {
    return this.unlockedOnce;
  }

  /**
   * Resumes the context (Req 37.6). Once it runs, the unlock listeners go and the remembered track and bed start;
   * a refusal or a context still suspended (an Esc keydown is no user activation) keeps them for the next input.
   */
  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.unlocking !== null) return this.unlocking;
    const attempt = (async () => {
      if (this.ctx.state !== 'running') {
        try {
          await this.ctx.resume();
        } catch {
          // Refused: the next input tries again.
        }
      }
      if (this.disposed) return;
      if (this.ctx.state === 'running') this.becameRunning();
      else this.listenForInput();
    })();
    this.unlocking = attempt.finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  private becameRunning(): void {
    this.unlockedOnce = true;
    this.stopListening();
    this.flushPending();
  }

  private listenForInput(): void {
    if (this.listening || this.inputTarget === null) return;
    this.listening = true;
    this.inputTarget.addEventListener('pointerdown', this.onInput, true);
    this.inputTarget.addEventListener('keydown', this.onInput, true);
  }

  private stopListening(): void {
    if (!this.listening || this.inputTarget === null) return;
    this.listening = false;
    this.inputTarget.removeEventListener('pointerdown', this.onInput, true);
    this.inputTarget.removeEventListener('keydown', this.onInput, true);
  }

  /** A hidden tab suspends the unlocked context (throttled timers would break the booking); visible resumes it. */
  private visibilityChanged(): void {
    if (this.disposed || !this.unlockedOnce || this.visibility === null) return;
    if (this.visibility.hidden) {
      if (this.ctx.state === 'running') this.ctx.suspend().catch(() => undefined);
    } else {
      void this.unlock();
    }
  }

  /** Starts what was asked for while the context was not running. */
  private flushPending(): void {
    if (!this.running) return;
    if (this.wantedMusic !== null) this.startMusic(this.wantedMusic.track, this.wantedMusic.fadeSec);
    this.applyAmbient(AMBIENT_FADE_SECONDS);
    this.pump();
  }

  // ── Buses ─────────────────────────────────────────────────────────────────

  private musicTarget(): number {
    return this.musicOn ? clamp01(this.musicVolume) ** 2 : 0;
  }

  private sfxTarget(): number {
    return this.sfxOn ? clamp01(this.sfxVolume) ** 2 : 0;
  }

  /** Music makes notes (on and above 0). */
  private get musicAudible(): boolean {
    return this.musicTarget() > 0;
  }

  /** Effects make voices (on and above 0). */
  private get sfxAudible(): boolean {
    return this.sfxTarget() > 0;
  }

  /** Music on/off and volume (0–1): only the music bus moves, to volume² (or 0) within 0.05 s (Req 37.4, 37.5). */
  setMusic(on: boolean, volume: number): void {
    this.musicOn = on;
    this.musicVolume = clamp01(volume);
    this.rampBus(this.nodes.musicBus.gain, this.musicTarget());
  }

  /** Effects on/off and volume: only the sfx bus (ui, world, ambient, voice) moves. */
  setSfx(on: boolean, volume: number): void {
    const was = this.sfxAudible;
    this.sfxOn = on;
    this.sfxVolume = clamp01(volume);
    this.rampBus(this.nodes.sfxBus.gain, this.sfxTarget());
    // A bed asked for while the effects were off starts now.
    if (!was && this.sfxAudible && this.running) this.applyAmbient(AMBIENT_FADE_SECONDS);
  }

  private rampBus(param: AudioParam, target: number): void {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(target, t + BUS_RAMP_SECONDS);
  }

  // ── Music ─────────────────────────────────────────────────────────────────

  /**
   * Crossfades to `track` over `fadeSec` (the MusicDirector passes 1.5 / 2 / 3 s, Req 37.3). The same track
   * already playing is left alone; a same-bpm switch starts the new track at the old one's step. While the context
   * does not run only the request is kept.
   */
  playMusic(track: MusicTrackId, fadeSec: number = DEFAULT_MUSIC_FADE): void {
    if (this.disposed || TRACKS[track] === undefined) return;
    this.wantedMusic = { track, fadeSec };
    if (!this.running) return;
    this.startMusic(track, fadeSec);
  }

  /** Fades the music out (no track wanted). */
  stopMusic(fadeSec: number = DEFAULT_MUSIC_FADE): void {
    this.wantedMusic = null;
    if (!this.running || this.current === null) return;
    this.current.fadeOut(this.ctx.currentTime, fadeSec);
    this.current = null;
  }

  private startMusic(track: MusicTrackId, fadeSec: number): void {
    const now = this.ctx.currentTime;
    const fade = Number.isFinite(fadeSec) && fadeSec > 0 ? fadeSec : 0;
    const prev = this.current;
    if (prev !== null && prev.id === track && !prev.fadingOut) return;
    const def = TRACKS[track];
    const buffer = this.buffers.get(track) ?? null;
    // Switching back to a track still fading out: its gain turns around from where it is.
    const revived = buffer === null ? this.tracks.find((p) => p.id === track && p.fadingOut && !p.fromFile && !p.disposed) : undefined;
    let player: TrackPlayer;
    if (revived !== undefined) {
      player = revived;
    } else {
      const key = def.key === 'inherit' ? this.inheritKey : def.key;
      const mode = def.mode === 'inherit' ? this.inheritMode : def.mode;
      const continues = prev !== null && buffer === null && !prev.fromFile && !prev.finished && prev.def.bpm === def.bpm;
      player = new TrackPlayer(this.host, {
        def, key, mode, buffer,
        startTime: continues ? prev.startTime : now + 0.02,
        nextStep: continues ? prev.nextStep : 0,
      });
      this.tracks.push(player);
    }
    prev?.fadeOut(now, fade);
    player.fadeIn(now, fade);
    this.current = player;
    if (def.key !== 'inherit' && !track.startsWith('mus_boss_') && track !== 'mus_victory') {
      this.inheritKey = def.key;
      this.inheritMode = def.mode === 'inherit' ? this.inheritMode : def.mode;
    }
    player.schedule(now, now + LOOKAHEAD_SECONDS);
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  /** Where the listener (the render camera) is; world sounds are spatialized from it (Req 19.8). */
  setListener(listener: Listener): void {
    this.listener = { pos: { ...listener.pos }, forward: { ...listener.forward } };
  }

  /**
   * Plays sound `id`: its decoded CC0 file, else its recipe (Req 40.6). Nothing while the context does not run,
   * the effects are off, a world sound is beyond 60 m, or the 32 voices are full of louder world sounds.
   */
  sfx(id: SfxId, opts: SfxOptions = {}): boolean {
    if (!this.running || !this.sfxAudible) return false;
    return this.playId(id, { t: opts.at, pitch: opts.pitch, gain: opts.gain, pos: opts.pos ?? null }) !== null;
  }

  /** A dialogue window's voice blip at `hz` (3–4 syllables, ≤ 0.3 s, `voice` group, Req 37.7); `seed` varies it. */
  voiceBlip(hz: number, seed: number): boolean {
    if (!this.running || !this.sfxAudible || !(hz > 0)) return false;
    return this.playRecipe('sfx_voice_blip', voiceBlipRecipe(hz, createRng(seed)), null, {}) !== null;
  }

  private playId(id: string, o: PlayOptions): Voice | null {
    const recipe = sfxRecipe(id);
    const buffer = this.buffers.get(id) ?? null;
    if (recipe === null && buffer === null) {
      this.warnOnce(`audio: no recipe or file for ${id}`);
      return null;
    }
    return this.playRecipe(id, recipe ?? { group: 'world', layers: [] }, buffer, o);
  }

  private playRecipe(id: string, recipe: SfxRecipe, buffer: AudioBuffer | null, o: PlayOptions): Voice | null {
    const { ctx } = this;
    const now = ctx.currentTime;
    const loop = recipe.loop === true;
    let pitch = o.pitch !== undefined && o.pitch > 0 ? o.pitch : 1;
    let gain = (recipe.gain ?? 1) * (o.gain ?? 1);
    if (recipe.vary !== undefined) {
      pitch *= 1 + this.rng.range(-recipe.vary.pitch, recipe.vary.pitch);
      gain *= dbToGain(this.rng.range(-recipe.vary.gainDb, recipe.vary.gainDb));
    }
    let pan = o.pan ?? 0;
    let spatialGain = 1;
    const positioned = o.pos != null && recipe.group === 'world' && this.listener !== null;
    if (positioned && o.pos != null && this.listener !== null) {
      const s = spatialize(this.listener, o.pos);
      if (s === null) return null;
      spatialGain = s.gain;
      pan = s.pan;
    }
    const loudness = gain * spatialGain;
    if (!this.makeRoom(recipe.group, loudness, now)) return null;
    const t = Math.max(o.t ?? now, now);

    const out = ctx.createGain();
    if (o.fadeIn !== undefined && o.fadeIn > 0) {
      out.gain.value = 0;
      out.gain.setValueAtTime(0, t);
      out.gain.linearRampToValueAtTime(loudness, t + o.fadeIn);
    } else {
      out.gain.value = loudness;
    }
    const nodes: AudioNode[] = [out];
    let panner: StereoPannerNode | null = null;
    if (positioned || pan !== 0) {
      panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      out.connect(panner);
      panner.connect(this.nodes.groups[recipe.group]);
      nodes.push(panner);
    } else {
      out.connect(this.nodes.groups[recipe.group]);
    }
    const sendLevel = recipe.send ?? 0.1;
    if (sendLevel > 0) {
      const send = ctx.createGain();
      send.gain.value = sendLevel;
      (panner ?? out).connect(send);
      send.connect(this.nodes.sfxReverb);
      nodes.push(send);
    }
    let input: AudioNode = out;
    if (o.via !== undefined) {
      o.via.connect(out);
      nodes.push(o.via);
      input = o.via;
    }

    let sources: AudioScheduledSourceNode[];
    let end: number;
    if (buffer !== null) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = loop;
      src.playbackRate.value = pitch;
      src.connect(input);
      src.start(t);
      sources = [src];
      nodes.push(src);
      end = loop ? Infinity : t + buffer.duration / pitch;
    } else {
      const rendered = renderRecipe(this.kit, recipe, t, pitch, input);
      sources = rendered.sources;
      nodes.push(...rendered.nodes);
      end = loop ? Infinity : rendered.end + 0.05;
    }
    const voice: Voice = {
      id, group: recipe.group, loudness, baseGain: gain, out, panner, sources, nodes, end, loop, stopped: false,
    };
    // Every node goes once all of the voice's sources have ended.
    let left = sources.length;
    for (const s of sources) {
      s.onended = () => {
        left--;
        if (left <= 0) disconnectAll(nodes);
      };
    }
    this.voices.push(voice);
    return voice;
  }

  /** Room for one more voice: prune the ended ones, then stop the quietest world voice when 32 sound. */
  private makeRoom(group: SfxGroup, loudness: number, now: number): boolean {
    this.prune(now);
    if (this.voices.length < MAX_VOICES) return true;
    const victim = pickVictim(this.voices, { group, loudness });
    if (victim === 'incoming') return false;
    this.stopVoice(victim, VOICE_STEAL_FADE);
    return true;
  }

  private prune(now: number): void {
    if (this.voices.some((v) => v.end < now)) this.voices = this.voices.filter((v) => v.end >= now);
  }

  /** Fades `voice` out over `fade` s and stops its sources; it leaves the voice count at once. */
  private stopVoice(voice: Voice, fade: number): void {
    if (voice.stopped) return;
    voice.stopped = true;
    const now = this.ctx.currentTime;
    const g = voice.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of voice.sources) {
      try {
        s.stop(now + fade + 0.02);
      } catch {
        // Already stopped.
      }
    }
    this.voices = this.voices.filter((v) => v !== voice);
    for (const [key, v] of this.loops) if (v === voice) this.loops.delete(key);
    if (this.glide?.voice === voice) this.glide = null;
  }

  // ── Loops ─────────────────────────────────────────────────────────────────

  /**
   * Glide wind (Req 19.10): intensity 0–1 drives the wind loop's gain and lowpass cutoff (500 Hz → 4 kHz) with
   * 0.2 s smoothing; 0 fades it out over 0.3 s and stops it.
   */
  setGlideWind(intensity: number): void {
    if (!this.running) return;
    const i = clamp01(intensity);
    const now = this.ctx.currentTime;
    if (i <= 0) {
      const g = this.glide;
      if (g !== null) this.stopVoice(g.voice, GLIDE_FADE_OUT_SECONDS);
      return;
    }
    if (this.glide === null) {
      if (!this.sfxAudible) return;
      const recipe = sfxRecipe('sfx_glide_wind');
      if (recipe === null) return;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = GLIDE_CUTOFF_MIN;
      const voice = this.playRecipe('sfx_glide_wind', recipe, this.buffers.get('sfx_glide_wind') ?? null, { fadeIn: 0.001, gain: 0, via: filter });
      if (voice === null) return;
      this.glide = { voice, filter, level: 0 };
    }
    const g = this.glide;
    if (Math.abs(g.level - i) < 0.004) return;
    g.level = i;
    g.voice.loudness = i;
    const tc = GLIDE_SMOOTHING_SECONDS / 3;
    g.voice.out.gain.cancelScheduledValues(now);
    g.voice.out.gain.setTargetAtTime(i, now, tc);
    g.filter.frequency.cancelScheduledValues(now);
    g.filter.frequency.setTargetAtTime(GLIDE_CUTOFF_MIN * (GLIDE_CUTOFF_MAX / GLIDE_CUTOFF_MIN) ** i, now, tc);
  }

  /**
   * The positioned air loops this frame (the caller sends them about 15 times a second): new ones within 60 m
   * start, present ones follow their point, missing or distant ones fade out.
   */
  setLoops(emitters: readonly LoopEmitter[]): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    const seen = new Set<string>();
    for (const e of emitters) {
      seen.add(e.key);
      const s = this.listener === null ? null : spatialize(this.listener, e.pos);
      const voice = this.loops.get(e.key);
      if (voice !== undefined) {
        if (s === null) {
          this.stopVoice(voice, LOOP_FADE_SECONDS);
          continue;
        }
        voice.loudness = voice.baseGain * s.gain;
        voice.out.gain.cancelScheduledValues(now);
        voice.out.gain.setTargetAtTime(voice.loudness, now, LOOP_SMOOTHING);
        voice.panner?.pan.setTargetAtTime(s.pan, now, LOOP_SMOOTHING);
        continue;
      }
      if (s === null || !this.sfxAudible) continue;
      const started = this.playId(e.id, { pos: e.pos, fadeIn: LOOP_FADE_SECONDS });
      if (started !== null) this.loops.set(e.key, started);
    }
    for (const [key, voice] of [...this.loops]) if (!seen.has(key)) this.stopVoice(voice, LOOP_FADE_SECONDS);
  }

  /** The ambient bed of a Region or `'interior'`, 2 s crossfade; remembered while the context does not run. */
  setAmbient(id: AmbientId | null): void {
    if (this.disposed) return;
    this.wantedAmbient = id;
    if (!this.running) return;
    this.applyAmbient(AMBIENT_FADE_SECONDS);
  }

  private applyAmbient(fade: number): void {
    const id = this.wantedAmbient;
    const bed = this.ambientBed;
    if (bed !== null && bed.id === id && (bed.voice === null || !bed.voice.stopped)) return;
    if (bed?.voice != null) this.stopVoice(bed.voice, fade);
    this.ambientBed = null;
    this.nextIntermittent = Infinity;
    if (id === null || !this.sfxAudible) return;
    const def = AMBIENT_DEFS[id];
    const voice = this.playId(def.bed, { fadeIn: fade });
    this.ambientBed = { id, voice };
    this.nextIntermittent = this.ctx.currentTime + this.rng.range(INTERMITTENT_MIN_SECONDS, INTERMITTENT_MAX_SECONDS);
  }

  // ── Files (task 16.4) ─────────────────────────────────────────────────────

  /** Decodes one file's bytes on this context. */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data);
  }

  /** The decoded CC0 files by `sfx_*` / `mus_*` id; later `sfx` / `playMusic` calls prefer them. */
  setBuffers(buffers: ReadonlyMap<string, AudioBuffer>): void {
    this.buffers = new Map(buffers);
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  /**
   * One scheduler pass (the 25 ms timer): books every music step starting before now + 0.12 s, drops faded
   * tracks, books the ambient intermittent sounds at seeded 1–4 s intervals and forgets ended voices.
   */
  pump(): void {
    if (!this.running) return;
    const now = this.ctx.currentTime;
    const horizon = now + LOOKAHEAD_SECONDS;
    for (const p of this.tracks) p.schedule(now, horizon);
    if (this.tracks.some((p) => p.expired(now))) {
      this.tracks = this.tracks.filter((p) => {
        if (!p.expired(now)) return true;
        p.dispose();
        return false;
      });
    }
    const bed = this.ambientBed;
    if (bed !== null && this.sfxAudible) {
      if (this.nextIntermittent < now - 1) this.nextIntermittent = now + this.rng.range(INTERMITTENT_MIN_SECONDS, INTERMITTENT_MAX_SECONDS);
      while (this.nextIntermittent < horizon) {
        const def = AMBIENT_DEFS[bed.id];
        if (def.intermittent.length > 0) {
          const id = this.rng.pick(def.intermittent);
          this.playId(id, { t: this.nextIntermittent, gain: def.intermittentGain, pan: this.rng.range(-INTERMITTENT_PAN, INTERMITTENT_PAN) });
        }
        this.nextIntermittent += this.rng.range(INTERMITTENT_MIN_SECONDS, INTERMITTENT_MAX_SECONDS);
      }
    }
    this.prune(now);
  }

  // ── Debug, teardown ───────────────────────────────────────────────────────

  debugState(): AudioDebugState {
    const byGroup: Record<SfxGroup, number> = { ui: 0, world: 0, ambient: 0, voice: 0 };
    for (const v of this.voices) byGroup[v.group]++;
    return {
      context: this.disposed ? 'disposed' : this.ctx.state,
      unlocked: this.unlockedOnce,
      music: { on: this.musicOn, volume: this.musicVolume, target: this.musicTarget() },
      sfx: { on: this.sfxOn, volume: this.sfxVolume, target: this.sfxTarget() },
      musicOn: this.musicOn,
      sfxOn: this.sfxOn,
      musicBusGain: this.nodes.musicBus.gain.value,
      sfxBusGain: this.nodes.sfxBus.gain.value,
      track: this.current?.id ?? this.wantedMusic?.track ?? null,
      tracks: this.tracks.map((p) => ({ id: p.id, fadingOut: p.fadingOut, step: p.nextStep, fromFile: p.fromFile })),
      pendingMusic: this.running ? null : (this.wantedMusic?.track ?? null),
      ambient: this.ambientBed?.id ?? this.wantedAmbient,
      voices: this.voices.length,
      voicesByGroup: byGroup,
      loops: [...this.loops.keys()],
      glideWind: this.glide?.level ?? 0,
      buffers: this.buffers.size,
      notes: this.tracks.reduce((n, p) => n + p.notesMade, 0),
    };
  }

  /** Stops everything, removes the listeners and the timer, and closes the context. */
  dispose(): void {
    if (this.disposed) return;
    this.stopListening();
    this.visibility?.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer !== null) this.timer.clear(this.timerHandle);
    for (const v of [...this.voices]) this.stopVoice(v, 0);
    for (const p of this.tracks) p.dispose();
    this.tracks = [];
    this.current = null;
    this.disposed = true;
    disconnectAll([this.nodes.master, this.nodes.limiter]);
    this.ctx.close().catch(() => undefined);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warn(message);
  }
}

function disconnectAll(nodes: readonly AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

/**
 * The page's engine: one `AudioContext({ latencyHint: 'interactive' })`, the window's first-input unlock, the
 * document's visibility and a 25 ms timer. Null (with a warning) where Web Audio is missing: the game runs silent.
 */
export function createBrowserAudioEngine(warn: (message: string) => void = (m) => console.warn(m)): AudioEngine | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext; window?: Listenable; document?: Listenable & { hidden: boolean } };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (Ctor === undefined) {
    warn('Web Audio is not available: the game runs without sound.');
    return null;
  }
  try {
    const ctx = new Ctor({ latencyHint: 'interactive' });
    return new AudioEngine({
      ctx,
      inputTarget: g.window ?? null,
      visibility: g.document ?? null,
      timer: { set: (cb, ms) => setInterval(cb, ms), clear: (h) => clearInterval(h as number) },
      warn,
    });
  } catch (err) {
    warn(`Web Audio could not start (${String(err)}): the game runs without sound.`);
    return null;
  }
}

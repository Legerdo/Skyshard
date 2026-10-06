import { describe, expect, it } from 'vitest';
import {
  AudioEngine, BUS_RAMP_SECONDS, GLIDE_FADE_OUT_SECONDS, LIMITER, MASTER_GAIN, REVERB_SECONDS,
} from '../../../src/audio/audioEngine';
import { connectAudioSettings } from '../../../src/audio/audioSettings';
import { MAX_VOICES } from '../../../src/audio/voicePool';
import { TRACKS } from '../../../src/data/music';
import { SettingsStore } from '../../../src/settings/settings';
import {
  asContext, asNode, asParam, FakeAudioContext, FakeBuffer, FakeBufferSource, FakeTarget, flush,
  type FakeBiquad, type FakeCompressor, type FakeConvolver, type FakeGain, type FakeNode,
} from './fakeAudioContext';

interface Rig {
  readonly ctx: FakeAudioContext;
  readonly win: FakeTarget;
  readonly doc: FakeTarget;
  readonly engine: AudioEngine;
}

function rig(running = true): Rig {
  const ctx = new FakeAudioContext();
  if (running) ctx.state = 'running';
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const engine = new AudioEngine({ ctx: asContext(ctx), inputTarget: win, visibility: doc, timer: null, seed: 7, warn: () => undefined });
  return { ctx, win, doc, engine };
}

const LISTENER = { pos: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 } };

describe('AudioEngine graph (task 16.1)', () => {
  it('routes both buses through master 0.8 and the −6 dB ratio 12 limiter to the destination', () => {
    const { ctx, engine } = rig();
    const { master, limiter, musicBus, sfxBus, groups, musicReverb, sfxReverb } = engine.nodes;
    expect(asNode<FakeGain>(master).gain.value).toBeCloseTo(MASTER_GAIN);
    expect(asNode(master).outputs).toEqual([limiter]);
    const lim = asNode<FakeCompressor>(limiter);
    expect(lim.threshold.value).toBe(-6);
    expect(lim.ratio.value).toBe(12);
    expect(lim.knee.value).toBe(LIMITER.knee);
    expect(lim.outputs).toEqual([ctx.destination]);
    expect(asNode(musicBus).outputs).toEqual([master]);
    expect(asNode(sfxBus).outputs).toEqual([master]);
    for (const g of ['ui', 'world', 'ambient', 'voice'] as const) expect(asNode(groups[g]).outputs).toEqual([sfxBus]);
    // Each bus has its own reverb, returning in front of the bus gain, sharing one seeded 2 s stereo impulse.
    expect(asNode(musicReverb).outputs).toEqual([musicBus]);
    expect(asNode(sfxReverb).outputs).toEqual([sfxBus]);
    const a = asNode<FakeConvolver>(musicReverb).buffer;
    expect(a).not.toBeNull();
    expect(asNode<FakeConvolver>(sfxReverb).buffer).toBe(a);
    expect(a?.numberOfChannels).toBe(2);
    expect(a?.duration).toBeCloseTo(REVERB_SECONDS);
    const data = a?.getChannelData(0) ?? new Float32Array();
    const early = Math.max(...data.slice(0, 400).map(Math.abs));
    const late = Math.max(...data.slice(data.length - 400).map(Math.abs));
    expect(early).toBeGreaterThan(0.3);
    expect(late).toBeLessThan(early * 0.01); // ≈ −60 dB by RT60 1.8 s
  });

  it('setSfx leaves the music bus alone, setMusic leaves the sfx bus alone, each ramp lands within 0.05 s', () => {
    const { ctx, engine } = rig();
    const music = asParam(engine.nodes.musicBus.gain);
    const sfx = asParam(engine.nodes.sfxBus.gain);
    ctx.advance(1);
    const musicCalls = music.calls.length;
    engine.setSfx(false, 0.8);
    expect(music.calls.length).toBe(musicCalls);
    expect(sfx.valueAt(1 + BUS_RAMP_SECONDS)).toBe(0);
    expect(sfx.lastEventEnd() - 1).toBeLessThanOrEqual(0.05 + 1e-9);

    const sfxCalls = sfx.calls.length;
    ctx.advance(1);
    engine.setMusic(false, 0.7);
    expect(sfx.calls.length).toBe(sfxCalls);
    expect(music.valueAt(2 + 0.05)).toBe(0);

    ctx.advance(1);
    engine.setMusic(true, 0.5);
    expect(music.valueAt(3)).toBe(0);
    expect(music.valueAt(3.05)).toBeCloseTo(0.25); // volume²
    expect(music.lastEventEnd() - 3).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(music.valueAt(3.025)).toBeGreaterThan(0); // a ramp, not a jump
    expect(music.valueAt(3.025)).toBeLessThan(0.25);
    engine.setSfx(true, 1);
    expect(sfx.valueAt(3.05)).toBeCloseTo(1);
  });

  it('follows the Settings store: only the changed bus moves', () => {
    const { ctx, engine } = rig();
    const store = new SettingsStore();
    const off = connectAudioSettings(store, engine);
    const music = asParam(engine.nodes.musicBus.gain);
    const sfx = asParam(engine.nodes.sfxBus.gain);
    ctx.advance(0.5);
    expect(music.valueAt(0.5)).toBeCloseTo(0.7 ** 2);
    expect(sfx.valueAt(0.5)).toBeCloseTo(0.8 ** 2);
    const musicCalls = music.calls.length;
    store.set({ sfxVolume: 0.5 });
    expect(music.calls.length).toBe(musicCalls);
    expect(sfx.valueAt(0.5 + 0.05)).toBeCloseTo(0.25);
    store.set({ musicOn: false });
    expect(music.valueAt(0.55)).toBe(0);
    expect(engine.debugState().music.on).toBe(false);
    off();
  });
});

describe('autoplay policy and unlock (task 16.1)', () => {
  it('is silent while suspended, remembers the last playMusic / setAmbient and starts them once unlocked', async () => {
    const { ctx, win, engine } = rig(false);
    engine.setListener(LISTENER);
    const before = ctx.created.length;
    expect(engine.sfx('sfx_ui_confirm')).toBe(false);
    engine.setGlideWind(0.8);
    engine.playMusic('mus_verdant', 3);
    engine.playMusic('mus_title_village', 2);
    engine.setAmbient('ember');
    engine.setAmbient('verdant');
    engine.pump();
    expect(ctx.sources().length).toBe(0);
    expect(ctx.created.length).toBe(before);
    expect(engine.debugState().pendingMusic).toBe('mus_title_village');
    // Capture-phase listeners wait for the first input.
    expect(win.has('pointerdown')).toBe(true);
    expect(win.has('keydown')).toBe(true);
    win.dispatch('pointerdown');
    await flush();
    expect(ctx.state).toBe('running');
    expect(win.listeners).toHaveLength(0);
    const s = engine.debugState();
    expect(s.unlocked).toBe(true);
    expect(s.tracks.map((t) => t.id)).toEqual(['mus_title_village']);
    expect(s.ambient).toBe('verdant');
    expect(s.voicesByGroup.ambient).toBe(1);
  });

  it('keeps the listeners after a refused or ineffective resume and retries on the next input', async () => {
    const { ctx, win, engine } = rig(false);
    ctx.resumeBehavior = 'reject';
    win.dispatch('keydown');
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(win.has('keydown') && win.has('pointerdown')).toBe(true);
    ctx.resumeBehavior = 'stay'; // an Esc keydown: no user activation
    win.dispatch('keydown');
    await flush();
    expect(ctx.state).toBe('suspended');
    expect(win.has('keydown')).toBe(true);
    ctx.resumeBehavior = 'run';
    win.dispatch('pointerdown');
    await flush();
    expect(ctx.state).toBe('running');
    expect(ctx.resumeCalls).toBe(3);
    expect(win.listeners).toHaveLength(0);
    expect(engine.unlocked).toBe(true);
  });

  it('suspends with a hidden tab and resumes when it shows again (after unlocking only)', async () => {
    const { ctx, doc, engine } = rig(false);
    doc.hidden = true;
    doc.dispatch('visibilitychange');
    expect(ctx.suspendCalls).toBe(0); // not unlocked yet
    doc.hidden = false;
    await engine.unlock();
    expect(ctx.state).toBe('running');
    doc.hidden = true;
    doc.dispatch('visibilitychange');
    expect(ctx.state).toBe('suspended');
    engine.playMusic('mus_ember');
    expect(engine.debugState().pendingMusic).toBe('mus_ember');
    doc.hidden = false;
    doc.dispatch('visibilitychange');
    await flush();
    expect(ctx.state).toBe('running');
    expect(engine.debugState().track).toBe('mus_ember');
    expect(engine.debugState().tracks).toHaveLength(1);
  });
});

describe('music bus and the sequencer (tasks 16.1, 16.2)', () => {
  it('makes no note nodes while the music is off but keeps counting steps, then continues in place', () => {
    const { ctx, engine } = rig();
    engine.setSfx(false, 1); // only music nodes below
    engine.playMusic('mus_combat', 0);
    for (let i = 0; i < 20; i++) {
      ctx.advance(0.025);
      engine.pump();
    }
    const withMusic = ctx.count('oscillator') + ctx.count('bufferSource');
    expect(withMusic).toBeGreaterThan(0);
    engine.setMusic(false, 1);
    const stepBefore = engine.debugState().tracks[0]?.step ?? 0;
    for (let i = 0; i < 40; i++) {
      ctx.advance(0.025);
      engine.pump();
    }
    expect(ctx.count('oscillator') + ctx.count('bufferSource')).toBe(withMusic);
    const stepAfter = engine.debugState().tracks[0]?.step ?? 0;
    // 1 s at 132 bpm = 8.8 sixteenth steps.
    expect(stepAfter - stepBefore).toBeGreaterThanOrEqual(8);
    engine.setMusic(true, 1);
    ctx.advance(0.025);
    engine.pump();
    ctx.advance(0.1);
    engine.pump();
    expect(ctx.count('oscillator') + ctx.count('bufferSource')).toBeGreaterThan(withMusic);
  });

  it('books steps on the audio clock (track start + step × 60 / bpm / 4) up to 0.12 s ahead', () => {
    const { ctx, engine } = rig();
    engine.setSfx(false, 1);
    engine.playMusic('mus_combat', 0);
    for (let i = 0; i < 20; i++) {
      ctx.advance(0.025);
      engine.pump();
    }
    const stepDur = 60 / TRACKS.mus_combat.bpm / 4;
    const kickStarts = ctx.sources().filter((s) => s.kind === 'oscillator').map((s) => s.startTime ?? 0);
    expect(Math.max(...kickStarts)).toBeLessThan(0.5 + 0.12 + 1e-9);
    // Every note starts on a step boundary of the track (start 0.02 s after playMusic).
    for (const t of kickStarts) {
      const steps = (t - 0.02) / stepDur;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
    }
  });

  it('crossfades with equal-power curves and continues a same-bpm track at the current step', () => {
    const { ctx, engine } = rig();
    engine.setSfx(false, 1);
    engine.playMusic('mus_crater', 2);
    for (let i = 0; i < 40; i++) {
      ctx.advance(0.025);
      engine.pump();
    }
    const crater = engine.debugState().tracks[0];
    engine.playMusic('mus_sanctum', 3); // both 66 bpm
    const s = engine.debugState();
    expect(s.track).toBe('mus_sanctum');
    expect(s.tracks.map((t) => [t.id, t.fadingOut])).toEqual([['mus_crater', true], ['mus_sanctum', false]]);
    expect(s.tracks[1]?.step).toBeGreaterThanOrEqual(crater?.step ?? 0);
    // Same track again: nothing changes.
    engine.playMusic('mus_sanctum', 3);
    expect(engine.debugState().tracks).toHaveLength(2);
    // The faded track leaves after its fade and tails.
    for (let i = 0; i < 300; i++) {
      ctx.advance(0.025);
      engine.pump();
    }
    expect(engine.debugState().tracks.map((t) => t.id)).toEqual(['mus_sanctum']);
  });

  it('the track gains follow equal-power curves over the requested length', () => {
    const { ctx, engine } = rig();
    engine.playMusic('mus_verdant', 0);
    ctx.advance(1);
    const gains = (): FakeGain[] => asNode<FakeNode>(engine.nodes.musicBus).ctx.created
      .filter((n): n is FakeGain => n.kind === 'gain' && n.outputs.includes(asNode(engine.nodes.musicBus)));
    engine.playMusic('mus_combat', 1.5);
    const [oldOut, newOut] = gains();
    expect(oldOut).toBeDefined();
    expect(newOut).toBeDefined();
    if (oldOut === undefined || newOut === undefined) return;
    expect(oldOut.gain.valueAt(1)).toBeCloseTo(1);
    expect(newOut.gain.valueAt(1)).toBeCloseTo(0);
    const mid = 1 + 0.75;
    // Equal power: the squares sum to 1 halfway, not the levels.
    expect(oldOut.gain.valueAt(mid) ** 2 + newOut.gain.valueAt(mid) ** 2).toBeCloseTo(1, 1);
    expect(oldOut.gain.valueAt(2.5)).toBeCloseTo(0);
    expect(newOut.gain.valueAt(2.5)).toBeCloseTo(1);
  });
});

describe('effects: voices, spatialization, loops (task 16.3)', () => {
  it('spatializes world sounds and skips those beyond 60 m', () => {
    const { ctx, engine } = rig();
    engine.setListener(LISTENER);
    expect(engine.sfx('sfx_hit_generic', { pos: { x: 0, y: 0, z: -70 } })).toBe(false);
    expect(engine.sfx('sfx_hit_generic', { pos: { x: 6, y: 0, z: 0 } })).toBe(true);
    const panner = ctx.created.filter((n) => n.kind === 'panner').at(-1) as unknown as { pan: { value: number } } | undefined;
    expect(panner?.pan.value).toBeCloseTo(0.8); // straight to the right
  });

  it('never sounds more than 32 voices and stops the quietest world voice first', () => {
    const { ctx, engine } = rig();
    engine.setListener(LISTENER);
    // 32 world voices, the i-th at 3 + i m (gain 3 / d): the last is the quietest.
    for (let i = 0; i < MAX_VOICES; i++) expect(engine.sfx('sfx_boss_roar', { pos: { x: 0, y: 0, z: -(3 + i) } })).toBe(true);
    expect(engine.debugState().voices).toBe(MAX_VOICES);
    // A quieter world sound is dropped.
    expect(engine.sfx('sfx_boss_roar', { pos: { x: 0, y: 0, z: -50 } })).toBe(false);
    expect(engine.debugState().voices).toBe(MAX_VOICES);
    // A ui sound takes the quietest world voice's place.
    const stopsBefore = ctx.sources().filter((s) => (s.stopTime ?? Infinity) <= ctx.currentTime + 0.1).length;
    expect(engine.sfx('sfx_ui_confirm')).toBe(true);
    const s = engine.debugState();
    expect(s.voices).toBe(MAX_VOICES);
    expect(s.voicesByGroup.ui).toBe(1);
    expect(s.voicesByGroup.world).toBe(MAX_VOICES - 1);
    expect(ctx.sources().filter((x) => (x.stopTime ?? Infinity) <= ctx.currentTime + 0.1).length).toBeGreaterThan(stopsBefore);
    for (let i = 0; i < 20; i++) engine.sfx('sfx_ui_move');
    expect(engine.debugState().voices).toBeLessThanOrEqual(MAX_VOICES);
  });

  it('forgets ended one-shot voices', () => {
    const { ctx, engine } = rig();
    engine.sfx('sfx_ui_move');
    expect(engine.debugState().voices).toBe(1);
    ctx.advance(1);
    engine.pump();
    expect(engine.debugState().voices).toBe(0);
  });

  it('makes no effect nodes while the effects are off', () => {
    const { ctx, engine } = rig();
    engine.setSfx(false, 1);
    const before = ctx.created.length;
    expect(engine.sfx('sfx_ui_confirm')).toBe(false);
    expect(engine.voiceBlip(220, 1)).toBe(false);
    engine.setGlideWind(1);
    engine.setAmbient('azure');
    ctx.advance(5);
    engine.pump();
    expect(ctx.created.length).toBe(before);
    // Turning them on starts the remembered bed.
    engine.setSfx(true, 1);
    expect(engine.debugState().voicesByGroup.ambient).toBe(1);
  });

  it('glide wind: gain and cutoff follow the intensity; 0 fades out over 0.3 s and stops the loop', () => {
    const { ctx, engine } = rig();
    engine.setGlideWind(1);
    expect(engine.debugState().glideWind).toBe(1);
    // The engine's own lowpass is the filter whose cutoff follows setTargetAtTime.
    const filter = ctx.created.find((n) => n.kind === 'biquad' && (n as unknown as FakeBiquad).frequency.calls.includes('setTargetAtTime')) as unknown as FakeBiquad;
    expect(filter.frequency.valueAt(1)).toBeCloseTo(4000, -1);
    ctx.advance(1);
    engine.setGlideWind(0);
    expect(engine.debugState().glideWind).toBe(0);
    const stops = ctx.sources().map((s) => s.stopTime ?? Infinity).filter(Number.isFinite);
    expect(Math.max(...stops)).toBeCloseTo(1 + GLIDE_FADE_OUT_SECONDS + 0.02, 5);
  });

  it('ambient beds crossfade over 2 s and intermittent sounds come every 1–4 s', () => {
    const { ctx, engine } = rig();
    engine.setAmbient('verdant');
    engine.setAmbient('verdant');
    expect(engine.debugState().voicesByGroup.ambient).toBe(1);
    const count = (): number => engine.debugState().voicesByGroup.ambient;
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      ctx.advance(0.025);
      engine.pump();
      peak = Math.max(peak, count());
    }
    expect(peak).toBeGreaterThan(1); // birds and crickets over the bed
    engine.setAmbient('interior');
    expect(engine.debugState().ambient).toBe('interior');
  });

  it('voice blips sound in the voice group, 3–4 syllables within 0.3 s', () => {
    const { ctx, engine } = rig();
    expect(engine.voiceBlip(196, 42)).toBe(true);
    expect(engine.debugState().voicesByGroup.voice).toBe(1);
    const oscs = ctx.sources().filter((s) => s.kind === 'oscillator');
    expect(oscs.length).toBeGreaterThanOrEqual(3);
    expect(oscs.length).toBeLessThanOrEqual(4);
    expect(Math.max(...oscs.map((o) => o.stopTime ?? 0))).toBeLessThanOrEqual(0.3 + 0.03);
  });

  it('keeps the positioned air loops alive, updates them and stops the ones no longer sent', () => {
    const { engine } = rig();
    engine.setListener(LISTENER);
    engine.setLoops([
      { key: 'updraft:a', id: 'sfx_updraft_loop', pos: { x: 0, y: 0, z: -10 } },
      { key: 'windZone:b', id: 'sfx_wind_zone_loop', pos: { x: 0, y: 0, z: -80 } },
    ]);
    expect(engine.debugState().loops).toEqual(['updraft:a']);
    engine.setLoops([{ key: 'updraft:a', id: 'sfx_updraft_loop', pos: { x: 5, y: 0, z: -5 } }]);
    expect(engine.debugState().loops).toEqual(['updraft:a']);
    engine.setLoops([]);
    expect(engine.debugState().loops).toEqual([]);
  });
});

describe('CC0 files (task 16.4)', () => {
  it('plays a decoded file instead of the recipe, and a mus_* file instead of the sequencer', () => {
    const { ctx, engine } = rig();
    const jump = new FakeBuffer(1, 800, 8000);
    const song = new FakeBuffer(2, 8000, 8000);
    engine.setBuffers(new Map([['sfx_jump', jump as unknown as AudioBuffer], ['mus_victory', song as unknown as AudioBuffer]]));
    expect(engine.sfx('sfx_jump')).toBe(true);
    const sources = ctx.created.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource);
    expect(sources.some((s) => s.buffer === jump)).toBe(true);
    expect(ctx.count('oscillator')).toBe(0);
    engine.playMusic('mus_victory', 2);
    const played = ctx.created.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource).find((s) => s.buffer === song);
    expect(played?.loop).toBe(TRACKS.mus_victory.loop);
    expect(engine.debugState().tracks[0]?.fromFile).toBe(true);
    // Without a file the recipe plays.
    expect(engine.sfx('sfx_land')).toBe(true);
    expect(ctx.count('oscillator')).toBeGreaterThan(0);
  });

  it('dispose stops the timer and the listeners and closes the context', () => {
    const ctx = new FakeAudioContext();
    const win = new FakeTarget();
    const doc = new FakeTarget();
    let cleared = false;
    const engine = new AudioEngine({
      ctx: asContext(ctx), inputTarget: win, visibility: doc, warn: () => undefined,
      timer: { set: () => 1, clear: () => { cleared = true; } },
    });
    expect(win.listeners).toHaveLength(2);
    engine.dispose();
    expect(cleared).toBe(true);
    expect(win.listeners).toHaveLength(0);
    expect(doc.listeners).toHaveLength(0);
    expect(ctx.state).toBe('closed');
  });
});

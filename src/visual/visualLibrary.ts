/*
 * VisualLibrary: the boot-time owner of the Visual_Manifest (design.md "시각 모델 교체 구조").
 *
 * - Every entry goes through `resolveVisualSpec` once; each invalid entry logs its one warning (Req 43.7).
 * - Templates are loaded once per entity id and cached; instances come from `instantiate()`.
 * - `createView(id)` returns an EntityView showing the procedural model at once. When the entity's source is external
 *   and a provider for that kind is registered (task 19.8 adds glTF / FBX / VRM), the template loads in parallel and the
 *   view swaps to it when ready (`EntityView.swapVisual`, no gameplay pause, Req 43.8). A load error, a 15 s timeout or
 *   a kind without a provider logs one warning and the entity keeps its procedural model.
 */
import type { VisualEntityId } from '../data/ids';
import {
  resolveVisualManifest, VISUAL_MANIFEST, type ExternalSourceKind, type VisualSpec,
} from '../data/visualManifest';
import type { RigBuildOptions } from '../anim/rigTypes';
import { EntityView } from './entityView';
import { externalProviders } from './externalProviders';
import { ProceduralVisualProvider } from './proceduralProvider';
import type { VisualProvider, VisualTemplate } from './types';

/** External load time limit (design "실패와 대체"). */
export const VISUAL_LOAD_TIMEOUT_MS = 15_000;

export interface VisualLibraryOptions {
  /** Manifest to resolve (default the shipped VISUAL_MANIFEST); any value, checked entry by entry. */
  readonly manifest?: unknown;
  /** Providers of external kinds (task 19.8). */
  readonly providers?: Partial<Record<ExternalSourceKind, VisualProvider>>;
  /** Warning sink (default console.warn); each problem is reported once. */
  readonly warn?: (message: string) => void;
  readonly timeoutMs?: number;
  /** Rig build options of the procedural provider (Node tests pass `faceAtlas: false`). */
  readonly rig?: RigBuildOptions;
}

export class VisualLibrary {
  readonly procedural: ProceduralVisualProvider;
  private readonly specs: Record<VisualEntityId, VisualSpec>;
  private readonly providers: Partial<Record<ExternalSourceKind, VisualProvider>>;
  private readonly external = new Map<VisualEntityId, Promise<VisualTemplate | null>>();
  private readonly warned = new Set<string>();
  private readonly warnSink: (message: string) => void;
  private readonly timeoutMs: number;
  /** Warnings reported so far (resolution and load failures). */
  readonly warnings: string[] = [];

  constructor(options: VisualLibraryOptions = {}) {
    this.warnSink = options.warn ?? ((m) => console.warn(m));
    this.providers = { ...options.providers };
    this.timeoutMs = options.timeoutMs ?? VISUAL_LOAD_TIMEOUT_MS;
    this.procedural = new ProceduralVisualProvider(options.rig);
    const resolved = resolveVisualManifest(options.manifest ?? VISUAL_MANIFEST);
    this.specs = resolved.specs;
    for (const w of resolved.warnings) this.warn(w);
  }

  private warn(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.warnings.push(message);
    this.warnSink(message);
  }

  /** The resolved spec of an entity (procedural for invalid entries). */
  spec(id: VisualEntityId): VisualSpec {
    return this.specs[id];
  }

  /** Registers the provider of an external kind (task 19.8's adapters). */
  registerProvider(kind: ExternalSourceKind, provider: VisualProvider): void {
    this.providers[kind] = provider;
  }

  /**
   * The external template of `id` once loaded, or null (procedural source, no provider, error or timeout; the
   * failures warn once). Loaded once per id.
   */
  externalTemplate(id: VisualEntityId): Promise<VisualTemplate | null> {
    const cached = this.external.get(id);
    if (cached !== undefined) return cached;
    const spec = this.specs[id];
    let pending: Promise<VisualTemplate | null>;
    if (spec.source.kind === 'procedural') {
      pending = Promise.resolve(null);
    } else {
      const kind = spec.source.kind;
      const url = spec.source.url;
      const provider = this.providers[kind];
      if (provider === undefined) {
        this.warn(`visual ${id}: no loader for '${kind}' models yet (${url}); keeping the procedural model`);
        pending = Promise.resolve(null);
      } else {
        pending = withTimeout(provider.load(id, spec), this.timeoutMs).then(
          (template) => template,
          (error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            this.warn(`visual ${id}: could not load ${url} (${reason}); keeping the procedural model`);
            return null;
          },
        );
      }
    }
    this.external.set(id, pending);
    return pending;
  }

  /** A view with the procedural model now, swapped to the external model when (if) it loads. */
  createView(id: VisualEntityId): EntityView {
    const view = new EntityView(id, this.procedural.template(id).instantiate());
    if (this.specs[id].source.kind !== 'procedural') {
      void this.externalTemplate(id).then((template) => {
        if (template === null) return;
        try {
          view.swapVisual(template.instantiate());
        } catch (error) {
          this.warn(`visual ${id}: instantiating the loaded model failed (${error instanceof Error ? error.message : String(error)}); keeping the procedural model`);
        }
      });
    }
    return view;
  }

  dispose(): void {
    this.procedural.dispose();
    this.external.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

let shared: VisualLibrary | null = null;

/**
 * The page's library over the shipped manifest (templates survive sessions; instances belong to their session), with
 * the glTF / FBX / VRM adapters (task 19.8) registered lazily: their chunks load only for external entries.
 */
export function defaultVisualLibrary(): VisualLibrary {
  if (shared === null) shared = new VisualLibrary({ providers: externalProviders() });
  return shared;
}

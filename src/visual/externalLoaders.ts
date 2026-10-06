/*
 * External model adapters (design.md "Visual_Provider" table: gltf / fbx / vrm; Req 43.2, 43.7, 1.4). This module is
 * loaded by dynamic import only when the Visual_Manifest names an external model (./externalProviders), and the VRM
 * part (`@pixiv/three-vrm`, ./vrmAdapter) by a second dynamic import only for a `vrm` entry, so the default build never
 * requests either chunk.
 *
 * `load(id, spec)`: resolve the same-origin URL against BASE_URL → fetch with a 15 s limit (aborted on timeout) →
 * check the bytes are the kind's format (and a glTF's buffers / images stay on the origin) → parse (GLTFLoader,
 * FBXLoader, GLTFLoader + VRMLoaderPlugin) → build the template (bone check, normalisation, sockets, clips). Any
 * failure rejects with a short reason; the VisualLibrary logs it once and keeps the procedural model (Req 43.7).
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { VisualEntityId } from '../data/ids';
import type { ExternalSourceKind, VisualSpec } from '../data/visualManifest';
import { buildExternalTemplate, type ExternalTemplateOptions, type ExternalVisualTemplate, type LoadedModel } from './externalModel';
import { checkModelFormat, foreignGltfUris, gltfJsonOf, ModelLoadError, resolveModelUrl } from './modelFormat';
import type { VisualProvider } from './types';
import { VISUAL_LOAD_TIMEOUT_MS } from './visualLibrary';

export type ModelParser = (buffer: ArrayBuffer, path: string) => Promise<LoadedModel>;

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ExternalProviderOptions extends ExternalTemplateOptions {
  /** Fetch (default globalThis.fetch); receives the abort signal of the time limit. */
  readonly fetch?: (url: string, init: { signal: AbortSignal }) => Promise<FetchResponse>;
  /** Base of relative model URLs (default import.meta.env.BASE_URL). */
  readonly baseUrl?: string;
  /** Page origin the URL must stay on (default location.origin when there is a page). */
  readonly origin?: string;
  /** Whole-load time limit (default 15 s). */
  readonly timeoutMs?: number;
  /** Parser overrides per kind (tests). */
  readonly parsers?: Partial<Record<ExternalSourceKind, ModelParser>>;
}

/** glTF / GLB through GLTFLoader (embedded clips kept). */
export const parseGltf: ModelParser = async (buffer, path) => {
  const gltf = await new GLTFLoader().parseAsync(buffer, path);
  return { kind: 'gltf', scene: gltf.scene, animations: gltf.animations };
};

/** FBX through FBXLoader (Mixamo `mixamorig:` names are recognised by the bone detection; cm scale → normalisation). */
export const parseFbx: ModelParser = async (buffer, path) => {
  const group = new FBXLoader().parse(buffer, path);
  return { kind: 'fbx', scene: group, animations: group.animations };
};

/** VRM through GLTFLoader + VRMLoaderPlugin, imported on first use (its own chunk). */
export const parseVrm: ModelParser = async (buffer, path) => {
  const { parseVrmBuffer } = await import('./vrmAdapter');
  return parseVrmBuffer(buffer, path);
};

const DEFAULT_PARSERS: Readonly<Record<ExternalSourceKind, ModelParser>> = { gltf: parseGltf, fbx: parseFbx, vrm: parseVrm };

function pageOrigin(): string | undefined {
  const loc = (globalThis as { location?: { origin?: string } }).location;
  return typeof loc?.origin === 'string' ? loc.origin : undefined;
}

function defaultBase(): string {
  return import.meta.env.BASE_URL ?? '/';
}

/** The glTF / FBX / VRM provider (one instance serves every external entity; templates are cached by the library). */
export class ExternalVisualProvider implements VisualProvider {
  constructor(private readonly options: ExternalProviderOptions = {}) {}

  load(id: VisualEntityId, spec: VisualSpec): Promise<ExternalVisualTemplate> {
    const source = spec.source;
    if (source.kind === 'procedural') return Promise.reject(new ModelLoadError('not an external source'));
    const timeoutMs = this.options.timeoutMs ?? VISUAL_LOAD_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ModelLoadError(`timed out after ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
    });
    const work = (async () => {
      const url = resolveModelUrl(source.url, this.options.baseUrl ?? defaultBase(), this.options.origin ?? pageOrigin());
      const fetcher = this.options.fetch ?? ((u: string, init: { signal: AbortSignal }) => fetch(u, init));
      const response = await fetcher(url, { signal: controller.signal });
      if (!response.ok) throw new ModelLoadError(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (controller.signal.aborted) throw new ModelLoadError('aborted');
      return this.loadBuffer(id, spec, buffer, THREE.LoaderUtils.extractUrlBase(url));
    })();
    return Promise.race([work, limit]).finally(() => clearTimeout(timer));
  }

  /** Checks, parses and prepares a model from bytes (`path`: base URL of its resources). */
  async loadBuffer(id: VisualEntityId, spec: VisualSpec, buffer: ArrayBuffer, path = ''): Promise<ExternalVisualTemplate> {
    const kind = spec.source.kind;
    if (kind === 'procedural') throw new ModelLoadError('not an external source');
    const container = checkModelFormat(kind, buffer);
    if (container === 'glb' || container === 'gltf-json') {
      const foreign = foreignGltfUris(gltfJsonOf(buffer, container));
      if (foreign.length > 0) throw new ModelLoadError(`resources outside the page origin: ${foreign.slice(0, 3).join(', ')}`);
    }
    const parser = this.options.parsers?.[kind] ?? DEFAULT_PARSERS[kind];
    let loaded: LoadedModel;
    try {
      loaded = await parser(buffer, path);
    } catch (error) {
      if (error instanceof ModelLoadError) throw error;
      throw new ModelLoadError(`parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return buildExternalTemplate(id, spec, loaded, this.options);
  }
}

let shared: ExternalVisualProvider | null = null;

/** The page's provider (default options). */
export function sharedExternalProvider(): ExternalVisualProvider {
  if (shared === null) shared = new ExternalVisualProvider();
  return shared;
}

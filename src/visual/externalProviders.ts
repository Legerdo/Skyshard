/*
 * Lazy glTF / FBX / VRM providers for the VisualLibrary (design: "외부 provider의 로더 코드는 그 종류가 manifest에 있을
 * 때만 dynamic import로 불러온다"). This module is tiny and imports no loader: the first external load imports
 * ./externalLoaders (GLTFLoader, FBXLoader, the adapters), and a VRM load then imports ./vrmAdapter (@pixiv/three-vrm).
 * With the shipped all-procedural manifest neither chunk is ever requested.
 */
import type { VisualEntityId } from '../data/ids';
import type { ExternalSourceKind, VisualSpec } from '../data/visualManifest';
import type { VisualProvider, VisualTemplate } from './types';

type LoadersModule = typeof import('./externalLoaders');

let loaders: Promise<LoadersModule> | null = null;

/** One provider object serving every external kind through the shared adapter (imported on first use). */
export const lazyExternalProvider: VisualProvider = {
  async load(id: VisualEntityId, spec: VisualSpec): Promise<VisualTemplate> {
    loaders ??= import('./externalLoaders');
    const module = await loaders;
    return module.sharedExternalProvider().load(id, spec);
  },
};

/** The providers the game registers for `gltf`, `fbx` and `vrm`. */
export function externalProviders(): Record<ExternalSourceKind, VisualProvider> {
  return { gltf: lazyExternalProvider, fbx: lazyExternalProvider, vrm: lazyExternalProvider };
}

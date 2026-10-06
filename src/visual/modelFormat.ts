/*
 * External model file checks (design.md "실패와 대체": 지원하지 않는 형식, 다른 출처 URL; Req 1.4, 43.7). Pure: no three.js.
 *
 * - URLs: a manifest url is a same-origin relative path (resolveVisualSpec already refuses schemes and `//`); it is
 *   resolved against `import.meta.env.BASE_URL` (a leading '/' is kept as a root path), and when a page origin is
 *   known the resolved URL must stay on it.
 * - Formats: the bytes must match the kind — GLB (`glTF` magic, also .vrm) or glTF JSON for `gltf`, GLB for `vrm`,
 *   binary (`Kaydara FBX Binary`) or ASCII FBX for `fbx`. A glTF / VRM whose buffers or images point at another origin
 *   is refused as well.
 */
import type { ExternalSourceKind } from '../data/visualManifest';

export type ModelContainer = 'glb' | 'gltf-json' | 'fbx-binary' | 'fbx-ascii';

/** A load failure with a short reason (the library turns it into the entity's one warning). */
export class ModelLoadError extends Error {
  override readonly name = 'ModelLoadError';
}

/**
 * The fetch URL of a manifest url: `base` + url for relative paths, url as is for root paths. With `origin` (the page
 * origin) the result must resolve onto it; throws ModelLoadError otherwise.
 */
export function resolveModelUrl(url: string, base: string, origin?: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || /[\\\s]/.test(url)) {
    throw new ModelLoadError(`'${url}' is not a same-origin relative path`);
  }
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const resolved = url.startsWith('/') ? url : `${prefix}${url.replace(/^\.\//, '')}`;
  if (origin !== undefined && origin !== 'null') {
    let target: URL;
    try {
      target = new URL(resolved, `${origin}/`);
    } catch {
      throw new ModelLoadError(`'${url}' is not a valid URL`);
    }
    if (target.origin !== origin) throw new ModelLoadError(`'${url}' leaves the page origin`);
  }
  return resolved;
}

const ascii = (bytes: Uint8Array, from: number, length: number): string => {
  let s = '';
  for (let i = from; i < Math.min(bytes.length, from + length); i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

/** The container the bytes hold, or null when they are none of the supported ones. */
export function sniffModelContainer(data: ArrayBuffer | Uint8Array): ModelContainer | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'glTF') return 'glb';
  if (bytes.length >= 20 && ascii(bytes, 0, 18) === 'Kaydara FBX Binary') return 'fbx-binary';
  // Text: skip a UTF-8 BOM and leading whitespace.
  let i = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  if (bytes[i] === 0x7b) return 'gltf-json'; // '{'
  const head = ascii(bytes, i, 64);
  if (/^;\s*FBX/.test(head) || /^FBXHeaderExtension/.test(head)) return 'fbx-ascii';
  return null;
}

/** Containers each kind accepts. */
export const KIND_CONTAINERS: Readonly<Record<ExternalSourceKind, readonly ModelContainer[]>> = {
  gltf: ['glb', 'gltf-json'],
  vrm: ['glb'],
  fbx: ['fbx-binary', 'fbx-ascii'],
};

/** Checks that the bytes are a format of `kind`; returns the container or throws ModelLoadError. */
export function checkModelFormat(kind: ExternalSourceKind, data: ArrayBuffer | Uint8Array): ModelContainer {
  const container = sniffModelContainer(data);
  if (container === null) throw new ModelLoadError(`unsupported file format for '${kind}' (not ${KIND_CONTAINERS[kind].join(' / ')})`);
  if (!KIND_CONTAINERS[kind].includes(container)) {
    throw new ModelLoadError(`unsupported file format: a ${container} file is not a '${kind}' model`);
  }
  return container;
}

/** The glTF JSON of a GLB (first chunk) or a .gltf text, or null when unreadable. */
export function gltfJsonOf(data: ArrayBuffer | Uint8Array, container: ModelContainer): unknown {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    let text: string;
    if (container === 'glb') {
      if (bytes.length < 20) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const length = view.getUint32(12, true);
      const type = view.getUint32(16, true);
      if (type !== 0x4e4f534a || 20 + length > bytes.length) return null; // 'JSON'
      text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
    } else if (container === 'gltf-json') {
      text = new TextDecoder().decode(bytes);
    } else {
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** URIs of a glTF's buffers and images that point outside the page origin (schemes other than data:, or `//`). */
export function foreignGltfUris(json: unknown): string[] {
  if (typeof json !== 'object' || json === null) return [];
  const out: string[] = [];
  for (const key of ['buffers', 'images'] as const) {
    const list = (json as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const uri = typeof entry === 'object' && entry !== null ? (entry as { uri?: unknown }).uri : undefined;
      if (typeof uri !== 'string') continue;
      if (/^data:/i.test(uri)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith('//')) out.push(uri);
    }
  }
  return out;
}

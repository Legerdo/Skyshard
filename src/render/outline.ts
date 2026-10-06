/*
 * Inverted-hull outlines (design.md "렌더러와 재질", Req 39.1): a back-face-only copy of a mesh that shares its
 * geometry (and, for a SkinnedMesh, its Skeleton and bind matrix) and whose vertices the outline material pushes
 * 0.02–0.05 m along the skinned normal, in proportion to the camera distance. It is drawn ≈ 35 % as bright as the
 * base colour. Only characters (Active_Character and party), NPCs, enemies, Caelith and the weapons they hold get one;
 * terrain and props never do.
 *
 * The outline is added as a child with an identity transform, so it follows the body without extra updates; it casts
 * and receives no shadow. Every outline material shares one program (OUTLINE_PROGRAM_KEY), so adding outlined meshes
 * never adds shader programs.
 */
import * as THREE from 'three';
import { createOutlineMaterial, outlineColorFor } from './toonMaterial';

/** Who may carry an outline (design: characters, NPCs, enemies, Caelith and their held weapons only). */
export const OUTLINE_TARGETS = ['character', 'npc', 'enemy', 'caelith', 'weapon'] as const;
export type OutlineTarget = (typeof OUTLINE_TARGETS)[number];

const vertexColorOutline = new Map<OutlineTarget, THREE.MeshBasicMaterial>();

/**
 * The shared outline material of a target kind for vertex-coloured bodies (the vertex colour × 35 %). One instance per
 * kind, so outlined meshes batch like their bodies.
 */
export function sharedOutlineMaterial(target: OutlineTarget): THREE.MeshBasicMaterial {
  let material = vertexColorOutline.get(target);
  if (material === undefined) {
    material = createOutlineMaterial(undefined, { vertexColors: true });
    material.name = `outline:${target}`;
    vertexColorOutline.set(target, material);
  }
  return material;
}

export interface AttachOutlineOptions {
  /** Outline material; default: the target's shared vertex-colour outline, or a 35 % tint of `baseColor`. */
  material?: THREE.Material;
  /** Single-colour bodies: the albedo the outline darkens to ≈ 35 %. */
  baseColor?: THREE.ColorRepresentation;
}

/**
 * Adds an outline to `mesh` (a child sharing its geometry; for a SkinnedMesh an outline SkinnedMesh bound to the same
 * Skeleton and bind matrix) and returns it. Calling it again on the same mesh returns the existing outline.
 */
export function attachOutline(mesh: THREE.Mesh, target: OutlineTarget, options: AttachOutlineOptions = {}): THREE.Mesh {
  const existing = outlineOf(mesh);
  if (existing !== null) return existing;
  const material = options.material
    ?? (options.baseColor !== undefined ? createOutlineMaterial(outlineColorFor(options.baseColor)) : sharedOutlineMaterial(target));
  let outline: THREE.Mesh;
  if (mesh instanceof THREE.SkinnedMesh) {
    const skinned = new THREE.SkinnedMesh(mesh.geometry, material);
    skinned.bindMode = mesh.bindMode;
    skinned.bind(mesh.skeleton, mesh.bindMatrix);
    outline = skinned;
  } else {
    outline = new THREE.Mesh(mesh.geometry, material);
  }
  outline.name = `${mesh.name || 'mesh'}:outline`;
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.frustumCulled = mesh.frustumCulled;
  outline.renderOrder = mesh.renderOrder;
  outline.userData.outline = { target };
  mesh.userData.outlineMesh = outline;
  mesh.add(outline);
  return outline;
}

/** The outline attached to `mesh`, or null. */
export function outlineOf(mesh: THREE.Object3D): THREE.Mesh | null {
  const outline = (mesh.userData as { outlineMesh?: unknown }).outlineMesh;
  return outline instanceof THREE.Mesh ? outline : null;
}

/** Removes `mesh`'s outline (the shared geometry and Skeleton stay with the body). */
export function detachOutline(mesh: THREE.Mesh): void {
  const outline = outlineOf(mesh);
  if (outline === null) return;
  mesh.remove(outline);
  delete (mesh.userData as { outlineMesh?: unknown }).outlineMesh;
}

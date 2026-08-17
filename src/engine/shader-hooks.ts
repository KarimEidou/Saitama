/**
 * COMPOSABLE `onBeforeCompile` HOOKS
 *
 * `THREE.Material.onBeforeCompile` is a single slot, and at least three things
 * in this renderer want it:
 *
 *   • MaterialLib   — triplanar / instance variation / damage mask injection
 *   • CSM           — cascade uniforms (`CSM.setupMaterial()` ASSIGNS the slot,
 *                     silently destroying whatever was there)
 *   • ad-hoc systems — VFX dissolves, hologram effects, debug visualisers
 *
 * Whoever assigns last wins, which in practice means the shadow system quietly
 * deletes the terrain's triplanar mapping. This module makes the slot a list.
 *
 * ── THE CACHE-KEY TRAP ─────────────────────────────────────────────────────
 * three builds its program cache key from `material.defines` plus
 * `customProgramCacheKey()`. It does NOT look at what `onBeforeCompile`
 * actually did. A single shared composed callback therefore produces the SAME
 * cache key for two materials whose hooks differ — three hands back the wrong
 * cached program and the material renders with someone else's shader.
 *
 * So every hook carries a short `key`, and `customProgramCacheKey()` returns
 * the joined keys. Adding a hook without a distinguishing key is a bug.
 */

import type * as THREE from 'three';

/** A shader mutation applied at compile time. */
export type ShaderHook = (
  shader: THREE.WebGLProgramParametersWithUniforms,
  renderer: THREE.WebGLRenderer
) => void;

interface HookRecord {
  readonly key: string;
  readonly fn: ShaderHook;
}

interface HookedMaterialData {
  engineShaderHooks?: HookRecord[];
}

/** True when `material` already routes through the composed dispatcher. */
export function hasShaderHooks(material: THREE.Material): boolean {
  return Array.isArray((material.userData as HookedMaterialData).engineShaderHooks);
}

/**
 * Append a compile-time shader mutation.
 *
 * @param material Target material.
 * @param key      Short token distinguishing this hook's OUTPUT. Two materials
 *                 whose hooks produce different GLSL must produce different
 *                 keys, or they will share a cached program.
 * @param fn       The mutation. Runs in registration order.
 */
export function addShaderHook(material: THREE.Material, key: string, fn: ShaderHook): void {
  const data = material.userData as HookedMaterialData;
  let hooks = data.engineShaderHooks;

  if (!hooks) {
    hooks = [];
    data.engineShaderHooks = hooks;

    const list = hooks;
    material.onBeforeCompile = function composedOnBeforeCompile(shader, renderer): void {
      for (let i = 0; i < list.length; i++) list[i]!.fn(shader, renderer);
    };
    material.customProgramCacheKey = function composedCacheKey(): string {
      let out = 'engine:';
      for (let i = 0; i < list.length; i++) out += list[i]!.key + '|';
      return out;
    };
  }

  hooks.push({ key, fn });
  // Defines and the cache key changed: force a recompile if the material has
  // already been used this session.
  material.needsUpdate = true;
}

/**
 * Adopt a third-party `onBeforeCompile` that was assigned directly onto the
 * material (CSM does exactly this) and fold it into the hook chain, restoring
 * the composed dispatcher.
 *
 * Call the third-party setup FIRST, then this immediately afterwards:
 *
 *   csm.setupMaterial( material );
 *   adoptAssignedHook( material, `csm${cascades}`, previousComposed );
 */
export function adoptAssignedHook(
  material: THREE.Material,
  key: string,
  previousOnBeforeCompile: THREE.Material['onBeforeCompile'] | undefined
): void {
  const assigned = material.onBeforeCompile;
  if (previousOnBeforeCompile !== undefined) {
    material.onBeforeCompile = previousOnBeforeCompile;
  }
  addShaderHook(material, key, (shader, renderer) => {
    assigned.call(material, shader, renderer);
  });
}

/** Snapshot the current hook keys. Diagnostics only. */
export function shaderHookKeys(material: THREE.Material): string[] {
  const hooks = (material.userData as HookedMaterialData).engineShaderHooks;
  return hooks ? hooks.map((h) => h.key) : [];
}

/** Remove every hook whose key matches, e.g. when shadows are turned off. */
export function removeShaderHooks(material: THREE.Material, key: string): void {
  const hooks = (material.userData as HookedMaterialData).engineShaderHooks;
  if (!hooks) return;
  let removed = false;
  for (let i = hooks.length - 1; i >= 0; i--) {
    if (hooks[i]!.key === key) {
      hooks.splice(i, 1);
      removed = true;
    }
  }
  if (removed) material.needsUpdate = true;
}

import type { SandboxClientLike } from '@tangle-network/agent-provider-tangle'

/** Override selected client methods while preserving the complete SDK surface. */
export function withSandboxClientOverrides(
  source: SandboxClientLike,
  overrides: Partial<SandboxClientLike>,
): SandboxClientLike {
  const boundMethods = new Map<PropertyKey, unknown>()

  return new Proxy(source, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property, overrides)
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      const cached = boundMethods.get(property)
      if (cached !== undefined) return cached
      const bound = value.bind(target)
      boundMethods.set(property, bound)
      return bound
    },
  })
}

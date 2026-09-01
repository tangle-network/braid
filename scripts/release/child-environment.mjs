const CREDENTIAL_NAME =
  /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|BEARER|COOKIE|CREDENTIAL|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/iu
const PROCESS_INJECTION_NAME = /^(?:BASH_ENV|ENV|LD_PRELOAD|NODE_OPTIONS|NODE_PATH)$/u

const PROVIDER_GROUPS = Object.freeze([
  Object.freeze({
    commands: new Set(['pnpm test:live:bridge', 'pnpm test:live:bridge:release']),
    name: /^BRAID_(?:CLI_BRIDGE|LIVE_BRIDGE)(?:_|$)/u,
  }),
  Object.freeze({ commands: new Set(['pnpm test:eval']), name: /^BRAID_EVAL_/u }),
  Object.freeze({
    commands: new Set(['pnpm test:live:tangle', 'pnpm test:live:supervisor']),
    name: /^TANGLE_API_KEY$/u,
  }),
  // LIVE-11 accepts the shared Sandbox credential through this fallback.
  Object.freeze({
    commands: new Set(['pnpm test:live:tangle']),
    name: /^(?:BRAID_(?:LIVE_)?TANGLE|TANGLE)(?:_|$)/u,
  }),
  Object.freeze({
    commands: new Set(['pnpm test:live:supervisor']),
    name: /^BRAID_(?:LIVE_)?SUPERVISOR(?:_|$)/u,
  }),
  Object.freeze({
    commands: new Set(['pnpm test:live:analysis']),
    name: /^BRAID_(?:LIVE_)?ANALYSIS(?:_|$)/u,
  }),
  Object.freeze({
    commands: new Set(['pnpm test:upstream']),
    name: /^BRAID_UPSTREAM_/u,
  }),
])

function providerGroupForName(name) {
  return PROVIDER_GROUPS.find((group) => group.name.test(name))
}

/** Gives each release child only the provider values required by its exact command. */
export function releaseChildEnvironment(environment, command) {
  const scoped = {}
  for (const [name, value] of Object.entries(environment ?? {})) {
    const provider = providerGroupForName(name)
    if (provider) {
      if (provider.commands.has(command)) scoped[name] = value
      continue
    }
    if (CREDENTIAL_NAME.test(name) || PROCESS_INJECTION_NAME.test(name)) continue
    scoped[name] = value
  }
  return scoped
}

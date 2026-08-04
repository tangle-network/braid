export type ColorMode = 'truecolor' | '256' | '16' | 'none'

export type AppearanceEnvironment = Readonly<Record<string, string | undefined>>

export interface ResolvedAppearance {
  readonly color: ColorMode
  readonly highContrast: boolean
  readonly reducedMotion: boolean
}

export function resolveAppearance(
  options: Partial<ResolvedAppearance> = {},
  environment: AppearanceEnvironment = process.env,
): ResolvedAppearance {
  return Object.freeze({
    color: resolveColorMode(options.color, environment),
    highContrast: options.highContrast ?? false,
    reducedMotion: options.reducedMotion ?? false,
  })
}

export function resolveColorMode(
  requested: ColorMode | undefined,
  environment: AppearanceEnvironment = process.env,
): ColorMode {
  if (environment.NO_COLOR !== undefined) return 'none'
  if (requested === 'none') return 'none'
  if (requested === '16' || requested === '256') return requested
  if (requested === 'truecolor' || requested === undefined) return detectColorMode(environment)
  return 'none'
}

export function detectColorMode(environment: AppearanceEnvironment = process.env): ColorMode {
  if (environment.NO_COLOR !== undefined) return 'none'

  const forced = environment.FORCE_COLOR
  if (forced === '0') return 'none'
  if (forced === '1') return '16'
  if (forced === '2') return '256'
  if (forced === '3') return 'truecolor'

  const colorTerm = environment.COLORTERM?.toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'

  const term = environment.TERM?.toLowerCase() ?? ''
  if (term === 'dumb') return 'none'
  if (term.includes('truecolor') || term.includes('24bit') || term.includes('direct')) {
    return 'truecolor'
  }
  if (term.includes('256color')) return '256'

  return '16'
}

export function chalkLevel(mode: ColorMode): 0 | 1 | 2 | 3 {
  switch (mode) {
    case 'truecolor':
      return 3
    case '256':
      return 2
    case '16':
      return 1
    case 'none':
      return 0
  }
}

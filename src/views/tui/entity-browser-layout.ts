import { visibleWidth } from '@earendil-works/pi-tui'

export interface EntityBrowserFooterOptions {
  readonly mode: 'wide' | 'list' | 'detail'
  readonly width: number
  readonly rowCount: number
  readonly bodyRows: number
  readonly selectedIndex: number
  readonly pages: number
  readonly page: number
  readonly filterHint?: string
}

export function entityBrowserFooter(options: EntityBrowserFooterOptions): string {
  const filters = filterVariants(options.filterHint)
  if (options.mode === 'wide') {
    const page = options.pages > 1 ? `page ${options.page + 1}/${options.pages}` : undefined
    const keys =
      options.rowCount === 1
        ? ['PgUp/PgDn detail · ←/esc close', 'PgUp/PgDn · ←/esc close', '←/esc close']
        : options.width < 120
          ? ['↑↓ select · PgUp/PgDn detail · ←/esc close', '↑↓ · Pg · ←/esc close', '←/esc close']
          : [
              '↑↓ select · PgUp/PgDn detail · home/end jump · ←/esc close',
              '↑↓ select · PgUp/PgDn detail · ←/esc close',
              '↑↓ · Pg · ←/esc close',
              '←/esc close',
            ]
    return fitFooter(candidates(keys, page, filters), options.width)
  }
  if (options.mode === 'list') {
    const suffix =
      options.rowCount > options.bodyRows
        ? `${options.selectedIndex + 1}/${options.rowCount}`
        : undefined
    const keys =
      options.width < 52
        ? ['↑↓ move · → open · ←/esc close', '↑↓ · → open · ←/esc close', '←/esc close']
        : ['↑↓ move · enter/→ open · ←/esc close', '↑↓ move · → open · ←/esc close', '←/esc close']
    return fitFooter(candidates(keys, suffix, filters), options.width)
  }
  const page = `page ${options.page + 1}/${options.pages}`
  const keys =
    options.width < 52
      ? options.pages > 1
        ? ['↑↓ · Pg · ←/esc back', '←/esc back']
        : ['↑↓ item · ←/esc back', '↑↓ · ←/esc back', '←/esc back']
      : options.width < 64
        ? options.pages > 1
          ? ['↑↓ · PgUp/PgDn · ←/esc back', '↑↓ · Pg · ←/esc back', '←/esc back']
          : ['↑↓ previous/next · ←/esc back', '↑↓ · ←/esc back', '←/esc back']
        : [
            '↑↓ previous/next · PgUp/PgDn page · ←/esc back',
            '↑↓ previous/next · PgUp/PgDn · ←/esc back',
            '↑↓ · Pg · ←/esc back',
            '←/esc back',
          ]
  return fitFooter(candidates(keys, options.pages > 1 ? page : undefined, filters), options.width)
}

function filterVariants(filter: string | undefined): readonly (string | undefined)[] {
  if (filter === undefined || filter.length === 0) return [undefined]
  const compact = filter.replace(/^tab filter:/u, 'tab:')
  return compact === filter ? [filter, undefined] : [filter, compact, undefined]
}

function candidates(
  keys: readonly string[],
  page: string | undefined,
  filters: readonly (string | undefined)[],
): string[] {
  const contextual = filters.filter((filter): filter is string => filter !== undefined)
  return [
    ...(page === undefined
      ? []
      : contextual.flatMap((filter) => keys.map((key) => joinParts(key, page, filter)))),
    ...contextual.flatMap((filter) => keys.map((key) => joinParts(key, undefined, filter))),
    ...(page === undefined ? [] : keys.map((key) => joinParts(key, page))),
    ...keys,
  ]
}

function joinParts(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(' · ')
}

function fitFooter(values: readonly string[], width: number): string {
  const available = Math.max(1, width - 2)
  return values.find((value) => visibleWidth(value) <= available) ?? values.at(-1) ?? ''
}

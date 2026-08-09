export type LayoutMode = 'narrow' | 'standard' | 'wide'

export interface TerminalLayout {
  readonly mode: LayoutMode
  readonly columns: number
  readonly rows: number
  readonly transcriptWidth: number
  readonly activityWidth: number
  readonly gap: number
  readonly overlayFullScreen: boolean
}

export const NARROW_COLUMNS = 80
export const WIDE_COLUMNS = 120
export const ACTIVITY_WIDTH = 28
export const TRANSCRIPT_MINIMUM = 72
const MIN_OVERLAY_ROWS = 16

export function modeForColumns(columns: number): LayoutMode {
  const safeColumns = Math.max(1, Math.floor(columns))
  if (safeColumns < NARROW_COLUMNS) return 'narrow'
  if (safeColumns >= WIDE_COLUMNS) return 'wide'
  return 'standard'
}

export function layoutFor(columns: number, rows: number, activityVisible = true): TerminalLayout {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  const mode = modeForColumns(safeColumns)
  if (mode === 'narrow' || !activityVisible) {
    return {
      mode: mode === 'narrow' ? 'narrow' : 'standard',
      columns: safeColumns,
      rows: safeRows,
      transcriptWidth: safeColumns,
      activityWidth: 0,
      gap: 0,
      overlayFullScreen: mode === 'narrow' || safeRows < MIN_OVERLAY_ROWS,
    }
  }

  const transcriptWidth = safeColumns - ACTIVITY_WIDTH - 1
  if (mode === 'wide' && transcriptWidth >= TRANSCRIPT_MINIMUM) {
    return {
      mode: 'wide',
      columns: safeColumns,
      rows: safeRows,
      transcriptWidth,
      activityWidth: ACTIVITY_WIDTH,
      gap: 1,
      overlayFullScreen: safeRows < MIN_OVERLAY_ROWS,
    }
  }

  return {
    mode: 'standard',
    columns: safeColumns,
    rows: safeRows,
    transcriptWidth: safeColumns,
    activityWidth: 0,
    gap: 0,
    overlayFullScreen: safeRows < MIN_OVERLAY_ROWS,
  }
}

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

const ACTIVITY_WIDTH = 28
const TRANSCRIPT_MINIMUM = 72

export function layoutFor(columns: number, rows: number): TerminalLayout {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  if (safeColumns < 80) {
    return {
      mode: 'narrow',
      columns: safeColumns,
      rows: safeRows,
      transcriptWidth: safeColumns,
      activityWidth: 0,
      gap: 0,
      overlayFullScreen: true,
    }
  }

  const transcriptWidth = safeColumns - ACTIVITY_WIDTH - 1
  if (safeColumns >= 120 && transcriptWidth >= TRANSCRIPT_MINIMUM) {
    return {
      mode: 'wide',
      columns: safeColumns,
      rows: safeRows,
      transcriptWidth,
      activityWidth: ACTIVITY_WIDTH,
      gap: 1,
      overlayFullScreen: false,
    }
  }

  return {
    mode: 'standard',
    columns: safeColumns,
    rows: safeRows,
    transcriptWidth: safeColumns,
    activityWidth: 0,
    gap: 0,
    overlayFullScreen: false,
  }
}

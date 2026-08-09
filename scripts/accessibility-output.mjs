// biome-ignore lint/complexity/useRegexLiterals: terminal control sequences must remain readable as escaped text
const OSC_SEQUENCE = new RegExp(
  String.raw`(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)`,
  'u',
)

export function assertAccessibleTerminalOutput(output) {
  const starts = [output.indexOf('\u001b]'), output.indexOf('\u009d')].filter((index) => index >= 0)
  const start = starts.length === 0 ? -1 : Math.min(...starts)
  if (start === -1) return
  const sequence = OSC_SEQUENCE.exec(output.slice(start))?.[0] ?? 'incomplete OSC sequence'
  throw new Error(`accessibility proof emitted terminal metadata: ${JSON.stringify(sequence)}`)
}

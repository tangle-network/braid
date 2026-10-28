import { format } from 'node:util'

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const
const MAX_HELD_LINES = 200

/**
 * A library that writes to the console while the TUI owns the terminal corrupts the rendered frame;
 * Sandbox SDK 1.x warns on every stream reconnect. Hold that output and print it to stderr once the
 * terminal is restored. Returns the restore function.
 */
export function holdConsoleWhileRendering(): () => void {
  const original = Object.fromEntries(METHODS.map((name) => [name, console[name]]))
  const held: string[] = []
  for (const name of METHODS) {
    console[name] = (...values: unknown[]) => {
      held.push(format(...values))
      if (held.length > MAX_HELD_LINES) held.shift()
    }
  }
  return () => {
    for (const name of METHODS) console[name] = original[name] as (typeof console)[typeof name]
    for (const line of held.splice(0)) process.stderr.write(`${line}\n`)
  }
}

import { StreamingRedactor } from './capture.mjs'
import { managedSpawn, observeNaturalExit, terminateProcess } from './process.mjs'

export async function runCommand(command, args, options) {
  const startedAt = Date.now()
  const maxOutputBytes = options.maxOutputBytes ?? 256_000
  const child = await managedSpawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return await new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    const stdoutCapture = new StreamingRedactor(maxOutputBytes)
    const stderrCapture = new StreamingRedactor(maxOutputBytes)
    let timedOut = false
    let closeResult
    let spawnError
    let termination
    let settled = false
    let closeSeen = false
    let timer
    const finish = () => {
      if (settled || (timedOut && termination === undefined)) return
      if (!timedOut && !closeSeen && spawnError === undefined) return
      settled = true
      clearTimeout(timer)
      stdout = stdoutCapture.finish()
      stderr = stderrCapture.finish()
      resolveResult({
        command,
        args,
        code: closeResult?.code,
        signal: closeResult?.signal,
        error: spawnError,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        cleanupOk:
          termination?.exited === true &&
          termination.descendantsExited === true &&
          termination.descendantsVerified === true,
        termination: termination ?? { strategy: 'spawn-error', cleanupStatus: 'unsupported' },
      })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutCapture.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrCapture.push(chunk)
    })
    child.once('error', (error) => {
      if (settled) return
      spawnError = error.message
      closeSeen = true
      finish()
    })
    child.once('close', async (code, signal) => {
      if (settled) return
      closeResult = { code, signal }
      closeSeen = true
      if (!timedOut) {
        clearTimeout(timer)
        const natural = await observeNaturalExit(child)
        termination =
          natural.cleanupStatus === 'natural-exit' ? natural : await terminateProcess(child)
      }
      finish()
    })
    timer = setTimeout(
      async () => {
        if (settled) return
        timedOut = true
        termination = await terminateProcess(child)
        finish()
      },
      options.timeoutMs ?? 10 * 60_000,
    )
  })
}

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WINDOWS_JOB_HOST_SOURCE } from './windows-job-host-source.mjs'

const compileTimeoutMs = 30_000
const controlTimeoutMs = 7_000
const outputLimit = 16_384
const managedJobs = new WeakMap()

let jobHostPromise
let jobHostRoot

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`
  return next.length <= outputLimit ? next : next.slice(-outputLimit)
}

function compileJobHost(sourcePath, outputPath) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -Path $env:BRAID_JOB_HOST_SOURCE -OutputAssembly $env:BRAID_JOB_HOST_OUTPUT -OutputType ConsoleApplication',
      "if (-not (Test-Path -LiteralPath $env:BRAID_JOB_HOST_OUTPUT -PathType Leaf)) { throw 'job host output is missing' }",
    ].join('; ')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        env: {
          ...process.env,
          BRAID_JOB_HOST_OUTPUT: outputPath,
          BRAID_JOB_HOST_SOURCE: sourcePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (code === 0) finish()
      else
        finish(
          new Error(
            `Windows Job Object host compilation failed with code ${code}: ${stderr || stdout}`,
          ),
        )
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`Windows Job Object host compilation exceeded ${compileTimeoutMs}ms`))
    }, compileTimeoutMs)
  })
}

async function createJobHost() {
  const root = await mkdtemp(join(tmpdir(), 'braid-windows-job-host-'))
  jobHostRoot = root
  const sourcePath = join(root, 'BraidWindowsJobHost.cs')
  const outputPath = join(root, 'braid-windows-job-host.exe')
  try {
    await writeFile(sourcePath, WINDOWS_JOB_HOST_SOURCE, { mode: 0o600 })
    await compileJobHost(sourcePath, outputPath)
    return outputPath
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    jobHostRoot = undefined
    throw error
  }
}

async function jobHostExecutable() {
  jobHostPromise ??= createJobHost()
  return await jobHostPromise
}

process.once('exit', () => {
  if (jobHostRoot === undefined) return
  try {
    rmSync(jobHostRoot, { force: true, recursive: true })
  } catch {}
})

export async function spawnWindowsJob(command, args, options) {
  const executable = await jobHostExecutable()
  if (jobHostRoot === undefined) throw new Error('Windows Job Object host root is unavailable')
  const id = randomUUID()
  const jobName = `Local\\BraidJob-${id}`
  const markerPath = join(jobHostRoot, `${id}.drained`)
  const child = spawn(executable, ['--run', jobName, markerPath, command, ...args], {
    ...options,
    detached: false,
    windowsHide: options.windowsHide ?? true,
  })
  managedJobs.set(child, { drained: false, executable, jobName, markerPath })
  return child
}

export function releaseWindowsJob(child) {
  const job = managedJobs.get(child)
  if (job !== undefined) {
    try {
      rmSync(job.markerPath, { force: true })
    } catch {}
  }
  managedJobs.delete(child)
}

export function windowsJobStatus(child, rootExited) {
  const job = managedJobs.get(child)
  if (job === undefined)
    return {
      supported: false,
      gone: false,
      reason: 'The Windows process was not started in a Job Object',
    }
  if (!Number.isInteger(child.pid) || child.pid <= 0)
    return {
      supported: false,
      gone: false,
      reason: 'The Windows Job Object host process id is invalid',
    }
  if (!job.drained && existsSync(job.markerPath)) job.drained = true
  const gone = job.drained
  return {
    supported: true,
    gone,
    present: !gone,
    pids: gone || rootExited ? [] : [child.pid],
    roots: gone || rootExited ? [] : [child.pid],
    version: gone ? 1 : 0,
    kernelContained: true,
    mechanism: 'windows-job-object',
    reason:
      rootExited && !gone
        ? 'The Windows Job Object host exited without a drain receipt'
        : undefined,
  }
}

export function terminateWindowsJob(child) {
  const job = managedJobs.get(child)
  if (job === undefined)
    return Promise.resolve({
      method: 'windows-job-object-unavailable',
      sent: false,
      reason: 'The Windows process has no managed Job Object',
    })
  if (job.drained || existsSync(job.markerPath)) {
    job.drained = true
    return Promise.resolve({ method: 'windows-job-object', sent: false, alreadyDrained: true })
  }
  return new Promise((resolve) => {
    const controller = spawn(job.executable, ['--terminate', job.jobName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (result.sent) job.drained = true
      resolve(result)
    }
    controller.stderr.setEncoding('utf8')
    controller.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk)
    })
    controller.once('error', (error) =>
      finish({ method: 'windows-job-object', sent: false, error: error.message }),
    )
    controller.once('close', (code) =>
      finish({
        method: 'windows-job-object',
        sent: code === 0,
        code,
        error: code === 0 ? undefined : stderr.trim() || 'Job Object controller failed',
      }),
    )
    const timer = setTimeout(() => {
      try {
        controller.kill('SIGKILL')
      } catch {}
      finish({
        method: 'windows-job-object',
        sent: false,
        timedOut: true,
        timeoutMs: controlTimeoutMs,
      })
    }, controlTimeoutMs)
  })
}

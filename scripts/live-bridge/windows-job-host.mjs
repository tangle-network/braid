import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WINDOWS_JOB_HOST_SOURCE } from './windows-job-host-source.mjs'

const compileTimeoutMs = 30_000
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
  const child = spawn(executable, [command, ...args], {
    ...options,
    detached: false,
    windowsHide: options.windowsHide ?? true,
  })
  managedJobs.set(child, { executable })
  return child
}

export function releaseWindowsJob(child) {
  managedJobs.delete(child)
}

export function windowsJobStatus(child, rootExited) {
  if (!managedJobs.has(child))
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
  return {
    supported: true,
    gone: rootExited,
    present: !rootExited,
    pids: rootExited ? [] : [child.pid],
    roots: rootExited ? [] : [child.pid],
    version: rootExited ? 1 : 0,
    kernelContained: true,
    mechanism: 'windows-job-object',
  }
}

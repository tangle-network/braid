import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidState } from '../../domain/state.js'
import type { BraidApplication } from '../application.js'
import { ConnectionActionService } from '../connection-actions.js'
import type { LearningTask } from './learning-types.js'

const run = promisify(execFile)
const CHECK_OUTPUT_TAIL = 2_000

/** What a replay needs from the application that owns the user's connection. */
export interface ReplayHost {
  state(): BraidState
  replayApplication(profile: Readonly<AgentProfile>): BraidApplication
}

export interface TaskReplay {
  readonly taskId: string
  readonly family: string
  /** null when the run or the check could not finish: not the candidate's failure. */
  readonly pass: boolean | null
  readonly error: string | null
  readonly answer: string
  readonly runId: string | null
  readonly runner: string | null
  readonly model: string | null
  readonly trace: {
    readonly toolCalls: number | null
    readonly toolErrors: number | null
    readonly wallMs: number | null
    readonly costUsd: number | null
  }
  readonly tokens: { readonly input: number; readonly output: number; readonly known: boolean }
  readonly checkOutput: string
}

async function prepareWorkspace(task: LearningTask, directory: string): Promise<string> {
  const work = join(directory, 'work')
  if (task.workspace.kind === 'git') {
    await run(
      'git',
      ['-C', task.workspace.root, 'worktree', 'add', '--detach', work, task.workspace.commit],
      { timeout: 120_000 },
    )
  } else {
    await mkdir(work, { recursive: true, mode: 0o700 })
  }
  return work
}

async function removeWorkspace(task: LearningTask, directory: string): Promise<void> {
  if (task.workspace.kind === 'git') {
    await run(
      'git',
      ['-C', task.workspace.root, 'worktree', 'remove', '--force', join(directory, 'work')],
      { timeout: 120_000 },
    ).catch(() => undefined)
  }
  await rm(directory, { recursive: true, force: true })
}

async function selectParentConnection(host: ReplayHost, child: BraidApplication): Promise<void> {
  const parent = host.state()
  const connectionId = parent.selectedConnectionId
  if (connectionId === null) return
  await new ConnectionActionService({
    host: {
      state: () => child.state(),
      configuration: child.configuration,
      runtime: child.runtimeSelection,
    },
    connections: parent.connections,
  }).select({ operationId: `op-learn-connection-${randomUUID()}`, connectionId })
}

function runEvidence(state: BraidState, runId: string) {
  const record = state.runs.find((item) => item.id === runId)
  const messages = state.messages.filter(
    (message) => message.runId === runId && message.role === 'assistant',
  )
  const messageIds = new Set(messages.map((message) => message.id))
  const parts = state.messageParts.filter((part) => messageIds.has(part.messageId))
  const calls = parts.filter((part) => part.kind === 'tool-call')
  const failures = parts.filter(
    (part) => (part.kind === 'tool-call' || part.kind === 'tool-result') && part.status === 'failed',
  )
  const started = record === undefined ? Number.NaN : Date.parse(record.startedAt)
  const ended = record?.terminalAt === undefined ? Number.NaN : Date.parse(record.terminalAt)
  return {
    record,
    answer: messages.map((message) => message.text).join('\n'),
    runner: record?.receipt.requested.runner ?? record?.receipt.requested.profile.harness ?? null,
    trace: {
      toolCalls: calls.length,
      toolErrors: failures.length,
      wallMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null,
      costUsd:
        record === undefined || record.usdKnown === false ? null : (record.costUsd ?? null),
    },
    tokens: {
      input: record?.inputTokens ?? 0,
      output: record?.outputTokens ?? 0,
      known: record !== undefined && record.tokensKnown !== false,
    },
  }
}

/** Run the task's check in the replay directory. Exit 0 passes; a check that cannot start errors. */
async function runCheck(
  task: LearningTask,
  work: string,
  answerPath: string,
): Promise<{ readonly pass: boolean | null; readonly error: string | null; readonly output: string }> {
  const [command, ...args] = task.check.argv
  if (command === undefined) return { pass: null, error: 'the task has no check', output: '' }
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd: work,
      timeout: task.check.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, BRAID_REPLAY_ANSWER: answerPath, BRAID_REPLAY_DIR: work },
    })
    return { pass: true, error: null, output: `${stdout}${stderr}`.slice(-CHECK_OUTPUT_TAIL) }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      killed?: boolean
      code?: unknown
    }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-CHECK_OUTPUT_TAIL)
    if (failure.killed === true)
      return { pass: null, error: `the check ran past ${task.check.timeoutMs} ms`, output }
    if (typeof failure.code === 'number') return { pass: false, error: null, output }
    return { pass: null, error: `the check could not start: ${String(failure.code)}`, output }
  }
}

/**
 * Replay one held-out task under one profile: a fresh workspace at the task's
 * commit, a fresh in-memory Braid application over the user's own execution
 * and connection, then the task's check. The candidate never sees the check.
 */
export async function replayTask(input: {
  readonly host: ReplayHost
  readonly profile: Readonly<AgentProfile>
  readonly task: LearningTask
  readonly replayRoot: string
  readonly timeoutMs: number
}): Promise<TaskReplay> {
  const { task } = input
  const directory = await mkdtemp(join(input.replayRoot, 'replay-'))
  const failed = (error: string, partial: Partial<TaskReplay> = {}): TaskReplay => ({
    taskId: task.id,
    family: task.family,
    pass: null,
    error,
    answer: '',
    runId: null,
    runner: input.profile.harness ?? null,
    model: input.profile.model?.default ?? null,
    trace: { toolCalls: null, toolErrors: null, wallMs: null, costUsd: null },
    tokens: { input: 0, output: 0, known: false },
    checkOutput: '',
    ...partial,
  })
  let child: BraidApplication | undefined
  try {
    const work = await prepareWorkspace(task, directory).catch((error: unknown) => {
      throw new Error(
        `the workspace could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    child = input.host.replayApplication(input.profile)
    child.initialize(work)
    await selectParentConnection(input.host, child)
    const operationId = `op-learn-replay-${randomUUID()}`
    const receipt = child.send({ operationId, text: task.prompt })
    let timer: NodeJS.Timeout | undefined
    const finished = await Promise.race([
      receipt.completion.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), input.timeoutMs)
      }),
    ]).finally(() => clearTimeout(timer))
    if (!finished) {
      child.cancel({ operationId: `${operationId}-cancel`, runId: receipt.runId })
      return failed(`the run did not finish within ${input.timeoutMs} ms`, {
        runId: receipt.runId,
      })
    }
    const evidence = runEvidence(child.state(), receipt.runId)
    const runner = evidence.runner ?? input.profile.harness ?? null
    const model = evidence.record?.model ?? input.profile.model?.default ?? null
    if (evidence.record?.status !== 'completed')
      return failed(`the run ended ${evidence.record?.status ?? 'unknown'}`, {
        runId: receipt.runId,
        runner,
        model,
        trace: evidence.trace,
        tokens: evidence.tokens,
      })
    const answerPath = join(directory, 'answer.txt')
    await writeFile(answerPath, evidence.answer, { mode: 0o600 })
    const check = await runCheck(task, work, answerPath)
    return {
      taskId: task.id,
      family: task.family,
      pass: check.pass,
      error: check.error,
      answer: evidence.answer,
      runId: receipt.runId,
      runner,
      model,
      trace: evidence.trace,
      tokens: evidence.tokens,
      checkOutput: check.output,
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  } finally {
    await child?.close().catch(() => undefined)
    await removeWorkspace(task, directory)
  }
}

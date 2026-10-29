// Drives Braid's terminal the way a user does: waits, the activity browser, permission forms, and
// pasted prompts. The live proofs share it so each decides from what the terminal shows.
import { pause, typeText } from '../live-demo/terminal.mjs'
import { countProtectedWork, redactString } from '../proof-tools.mjs'
import { permissionFormAnswer } from './tangle-sandbox-braid-stress-support.mjs'
import { activityBrowserOpen, transcriptSurfaceReady } from './terminal-screen.mjs'

/** A proof failure that more polling cannot change; retryUntil rethrows it at once. */
class ProofRefusal extends Error {}

/** Polls until predicate returns a value, retrying through its errors except a ProofRefusal. */
export async function retryUntil(label, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let lastError
  for (;;) {
    try {
      countProtectedWork('polls')
      const value = await predicate()
      if (value) return value
    } catch (error) {
      if (error instanceof ProofRefusal) throw error
      lastError = error
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
      )
    }
    await pause(100)
  }
}

export async function waitForActivityBrowserDismissal(runtime, label, timeoutMs) {
  return retryUntil(
    `${label} activity browser dismissal`,
    () => transcriptSurfaceReady(runtime.screen()),
    timeoutMs,
  )
}

export async function sendCancellationAfterActivityBrowserDismissal(runtime, label, timeoutMs) {
  if (!transcriptSurfaceReady(runtime.screen())) {
    runtime.input('\u001b')
    await waitForActivityBrowserDismissal(runtime, label, timeoutMs)
  }
  runtime.input('\u0003')
}

export const ACTIVITY_DOWN = '\u001b[B'
export const ACTIVITY_UP = '\u001b[A'

/**
 * Open the activity browser as a user does, answering a permission form that opens over the
 * terminal first and pressing F2 again once it is gone: at 59aff2c a form appeared just after F2,
 * took the key, and the browser wait sat behind it for 300s.
 */
async function openActivityBrowser(runtime, label, timeoutMs) {
  await settlePermissions(runtime, timeoutMs)
  runtime.input('\u001bOQ')
  let pressedAt = performance.now()
  await retryUntil(
    `${label} activity browser`,
    async () => {
      if (/activity/iu.test(runtime.screen())) return true
      const frame = await runtime.captureState(timeoutMs)
      const answered = await answerPendingPermissions(runtime, frame, timeoutMs)
      if (answered || performance.now() - pressedAt > 3_000) {
        runtime.input('\u001bOQ')
        pressedAt = performance.now()
      }
      return false
    },
    timeoutMs,
  )
}

/**
 * Focus one run as a user does: F2, Tab (starts on the focused run, #169), one arrow, Enter. Braid
 * holds forms while the browser is open, so each try closes it (never a form: Escape denies it).
 */
export async function focusRunFromActivityBrowser(runtime, runId, direction, label, timeoutMs) {
  return retryUntil(
    `${label} focus`,
    async () => {
      await openActivityBrowser(runtime, label, timeoutMs)
      runtime.input('\t')
      await pause(100)
      runtime.input(`${direction}\r`)
      const focused = async () => {
        const frame = await runtime.captureState(timeoutMs)
        return frame.view.focusedRunId === runId ? frame : undefined
      }
      const frame = await retryUntil(`${label} focus try`, focused, 5_000).catch(() => undefined)
      for (let back = 0; back < 4 && activityBrowserOpen(runtime.screen()); back += 1) {
        runtime.input('\u001b')
        await runtime.waitForStable(500).catch(() => undefined)
      }
      return frame
    },
    timeoutMs,
  )
}

/**
 * Answer each permission a run raises through its terminal form, the way a user answers it, and
 * keep a receipt. A model may ask for a command the prompt did not name (LIVE-07: an exploratory
 * `ls` in branch A). At 48da449 the form took the composer and swallowed branch B's prompt; Braid
 * now holds a form that arrives during typing in the status line, so the proof opens it with alt+p.
 */
async function answerPendingPermissions(runtime, frame, timeoutMs) {
  const refused = runtime.permissions.find((receipt) => !receipt.answerable)
  if (refused !== undefined)
    throw new ProofRefusal(`The proof cannot answer a ${refused.kind} request`)
  // Keys typed while the activity browser is open go to the browser; answer once it closes.
  if (activityBrowserOpen(runtime.screen())) return false
  let answered = false
  // The form on screen is the head of the queue; answer in queue order so receipts match it.
  const queue = [...(frame?.view?.interactions ?? [])].sort(
    (left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0),
  )
  for (const interaction of queue) {
    const { interactionId } = interaction
    const recorded = runtime.permissions.find((receipt) => receipt.interactionId === interactionId)
    if (recorded?.accepted) continue
    const answer = permissionFormAnswer(interaction)
    const command = interaction.request?.subject?.input?.command
    // `accepted` turns true only once the form leaves the queue after the typed answer. A still
    // queued form whose earlier answer did not land is answered again on its existing receipt:
    // 0.3.5's run 5 left one unanswered after a poll error, and its run's cancel then voided it.
    const receipt = recorded ?? {
      runId: interaction.runId,
      interactionId,
      kind: interaction.kind,
      subject: interaction.subject?.title ?? null,
      ...(typeof command === 'string'
        ? { commandPreview: redactString(command).slice(0, 240) }
        : {}),
      answerable: answer !== undefined,
      accepted: false,
    }
    if (recorded === undefined) runtime.permissions.push(receipt)
    if (answer === undefined)
      throw new ProofRefusal(`The proof cannot answer a ${interaction.kind} request`)
    await runtime.waitForStable(1_000).catch(() => undefined)
    await openDeferredInteraction(runtime, timeoutMs)
    // Clear anything a racing prompt left in the form, then enter the answer in one paste.
    const clear = `${CURSOR_LINE_END}${DELETE_TO_LINE_START}`
    runtime.input(`${clear}${bracketedPaste(JSON.stringify(answer))}\r`)
    // The form closes before Braid journals the response, and it also leaves the queue when the
    // request expires: wait for the journal to settle it, and accept only a recorded response.
    const outcome = await retryUntil(
      'permission answer',
      async () => {
        const settled = permissionOutcome(await runtime.captureState(timeoutMs), interactionId)
        return settled === 'unsettled' ? undefined : settled
      },
      timeoutMs,
    )
    if (outcome !== 'responded')
      throw new ProofRefusal(`Braid did not accept the typed permission answer (${outcome})`)
    receipt.accepted = true
    answered = true
  }
  return answered
}

// A permission form's footer. The `waiting · alt+p` notice hides while Ctrl+C has quit armed
// (LIVE-07 cancel-b), so the proof opens a held form by Alt+P whenever no form is on screen.
const FORM_OPEN = /alt\+a automate/u

async function openDeferredInteraction(runtime, timeoutMs) {
  let pressedAt = 0
  await retryUntil(
    'the waiting interaction form',
    async () => {
      if (FORM_OPEN.test(runtime.screen())) return true
      if (performance.now() - pressedAt > 2_000) {
        runtime.input('\u001bp')
        pressedAt = performance.now()
      }
      return false
    },
    timeoutMs,
  )
  await runtime.waitForStable(1_000).catch(() => undefined)
}

/** How Braid's journal settled one permission: a recorded response, a cancellation, or neither. */
export function permissionOutcome(frame, interactionId) {
  let outcome = 'unsettled'
  for (const event of frame?.events ?? []) {
    const payload = event?.payload ?? {}
    const id = payload.interactionId ?? payload.value?.interactionId ?? payload.interaction?.id
    if (id !== interactionId) continue
    if (['run.interaction.response.requested', 'run.interaction.responded'].includes(event.kind))
      return 'responded'
    if (event.kind === 'run.interaction.cancelled')
      outcome = `cancelled: ${payload.interaction?.reason ?? 'unknown reason'}`
  }
  return outcome
}

export async function settlePermissions(runtime, timeoutMs) {
  await answerPendingPermissions(runtime, await runtime.captureState(timeoutMs), timeoutMs)
}

const CURSOR_LINE_END = '\u0005'
const DELETE_TO_LINE_START = '\u0015'

function bracketedPaste(value) {
  return `\u001b[200~${value}\u001b[201~`
}

/**
 * Send a prompt the way a user pastes it: one input event, so a permission form that opens while it
 * arrives cannot take its tail (LIVE-07 at 48da449 lost 547 of 870 typed characters to a form).
 */
export async function pasteAndSubmit(runtime, value, timeoutMs) {
  await settlePermissions(runtime, timeoutMs)
  // The paste and its Enter share one write, so no form can open between them.
  runtime.input(`${bracketedPaste(value)}\r`)
}

export async function typeAndSubmit(runtime, value, timeoutMs) {
  await settlePermissions(runtime, timeoutMs)
  await typeText(runtime, value, 2)
  runtime.input('\r')
}

export async function waitForFrame(runtime, label, predicate, timeoutMs) {
  return retryUntil(
    label,
    async () => {
      const frame = await runtime.captureState(timeoutMs)
      if (await answerPendingPermissions(runtime, frame, timeoutMs)) return undefined
      return predicate(frame) ? frame : undefined
    },
    timeoutMs,
  )
}

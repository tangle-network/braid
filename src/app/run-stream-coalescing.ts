import {
  type BraidRuntimeEvent,
  isRuntimeEventEnvelope,
  type RuntimeEventEnvelope,
} from '../domain/runtime-events.js'

type StreamItem = BraidRuntimeEvent | RuntimeEventEnvelope

/** Most provider events one merged event may stand for; the stream yields to the loop between groups. */
export const MAX_COALESCED_EVENTS = 256

interface PartUpdate {
  readonly type: 'message.part.updated'
  readonly part: { readonly id: string; readonly type: string; readonly messageID?: string }
  readonly delta: string
}

function payloadOf(item: StreamItem): BraidRuntimeEvent {
  return isRuntimeEventEnvelope(item) ? item.event : item
}

function isThinkingMarker(event: BraidRuntimeEvent): boolean {
  return (event as { readonly type: string }).type === 'model-processing'
}

function partUpdate(event: BraidRuntimeEvent): PartUpdate | undefined {
  const candidate = event as Partial<PartUpdate>
  if (candidate.type !== 'message.part.updated' || typeof candidate.delta !== 'string')
    return undefined
  const part = candidate.part
  if (part === undefined || (part.type !== 'reasoning' && part.type !== 'text')) return undefined
  return candidate as PartUpdate
}

function partKey(update: PartUpdate): string {
  return `${update.part.type}:${update.part.id}:${update.part.messageID ?? ''}`
}

/** A run of consecutive events that one durable event can stand for without losing text. */
class Group {
  readonly items: StreamItem[] = []
  #key: string | undefined

  accepts(item: StreamItem): boolean {
    if (this.items.length >= MAX_COALESCED_EVENTS) return false
    const event = payloadOf(item)
    const update = partUpdate(event)
    if (update === undefined && !isThinkingMarker(event)) return false
    if (update !== undefined && this.#key !== undefined && this.#key !== partKey(update))
      return false
    const previous = this.items.at(-1)
    if (previous === undefined) return true
    if (isRuntimeEventEnvelope(item) !== isRuntimeEventEnvelope(previous)) return false
    return (
      !isRuntimeEventEnvelope(item) ||
      (isRuntimeEventEnvelope(previous) &&
        item.runId === previous.runId &&
        item.sequence === previous.sequence + 1)
    )
  }

  add(item: StreamItem): void {
    const update = partUpdate(payloadOf(item))
    if (update !== undefined) this.#key ??= partKey(update)
    this.items.push(item)
  }

  /**
   * One thinking marker per group stays as it arrived; every other marker repeats it. The part
   * updates become one update with the last whole part and every delta in order, so the replayed
   * text is the text the provider streamed.
   */
  merged(): StreamItem[] {
    if (this.items.length <= 2) return [...this.items]
    const [first] = this.items
    const lead = first !== undefined && isThinkingMarker(payloadOf(first)) ? [first] : []
    const rest = this.items.slice(lead.length)
    const updates = rest.flatMap((item) => {
      const update = partUpdate(payloadOf(item))
      return update === undefined ? [] : [update]
    })
    const lastUpdate = updates.at(-1)
    const lastItem = rest.at(-1)
    const firstRest = rest[0]
    if (lastItem === undefined || firstRest === undefined) return lead
    const event =
      lastUpdate === undefined
        ? payloadOf(lastItem)
        : ({
            ...lastUpdate,
            delta: updates.map((update) => update.delta).join(''),
          } as BraidRuntimeEvent)
    if (!isRuntimeEventEnvelope(lastItem) || !isRuntimeEventEnvelope(firstRest))
      return [...lead, event]
    return [
      ...lead,
      {
        ...lastItem,
        event,
        ...(firstRest.sequence === lastItem.sequence ? {} : { coversFrom: firstRest.sequence }),
      },
    ]
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Merges the provider events that are already waiting when Braid reads the stream.
 *
 * A model that reasons for minutes sends one part update (carrying the whole text so far) and one
 * thinking marker per few characters. Committing each as its own durable event takes the process
 * thread for longer than the provider takes to send them, so keystrokes and other conversations
 * wait behind the backlog. Events that arrive one at a time pass through unchanged; a backlog
 * becomes few events, and the stream gives the event loop a turn between groups.
 */
export function coalesceReadyEvents<T extends StreamItem>(
  stream: AsyncIterable<T>,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const inner = stream[Symbol.asyncIterator]()
      const ready: T[] = []
      let carried: Promise<IteratorResult<T>> | undefined
      let held: T | undefined
      let finished = false
      let failure: { readonly error: unknown } | undefined
      const pull = (): Promise<IteratorResult<T>> => {
        const pending = carried ?? inner.next()
        carried = undefined
        return pending
      }
      return {
        async next(): Promise<IteratorResult<T>> {
          for (;;) {
            const item = ready.shift()
            if (item !== undefined) return { done: false, value: item }
            if (failure !== undefined) throw failure.error
            if (finished) return { done: true, value: undefined }
            let group = new Group()
            // One turn of the loop is shared by every wait in this group.
            const looped = turn().then(() => false)
            let turned = false
            for (;;) {
              let result: IteratorResult<T>
              try {
                if (held === undefined) result = await pull()
                else {
                  result = { done: false, value: held }
                  held = undefined
                }
              } catch (error) {
                failure = { error }
                break
              }
              if (result.done) {
                finished = true
                break
              }
              if (!group.accepts(result.value)) {
                if (group.items.length > 0) {
                  // The next group starts with this item, after the loop has had its turn.
                  held = result.value
                  break
                }
                ready.push(result.value)
                break
              }
              group.add(result.value)
              const peek = inner.next()
              carried = peek
              const waiting = await Promise.race([
                peek.then(
                  () => true,
                  () => true,
                ),
                looped,
              ])
              if (!waiting) {
                turned = true
                break
              }
            }
            ready.push(...(group.merged() as T[]))
            // A backlog read in one go must not hold timers and input behind the commits it feeds.
            if (!turned) await looped
          }
        },
        async return(): Promise<IteratorResult<T>> {
          finished = true
          ready.length = 0
          await inner.return?.()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

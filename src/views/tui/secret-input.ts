import {
  type Component,
  CURSOR_MARKER,
  decodeKittyPrintable,
  type Focusable,
  getKeybindings,
  visibleWidth,
} from '@earendil-works/pi-tui'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const PROMPT = '> '
const MASK = '•'
const INVERSE = '\u001b[7m'
const RESET = '\u001b[27m'
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

declare const ownedSecretBytes: unique symbol

/** Mutable UTF-8 bytes transferred to the submit callback, which owns the buffer. */
export type OwnedSecretBytes = Uint8Array & {
  readonly [ownedSecretBytes]: 'caller-owned'
}

export interface SecretInputOptions {
  readonly onSubmit?: (bytes: OwnedSecretBytes) => void
  readonly onCancel?: () => void
  readonly onEscape?: () => void
}

interface SecretUnit {
  readonly bytes: Uint8Array
  readonly whitespace: boolean
  readonly punctuation: boolean
}

/** A single-line secret field with mutable, zeroable input storage. */
export class MaskedSecretInput implements Component, Focusable {
  focused = false
  onSubmit: ((bytes: OwnedSecretBytes) => void) | undefined
  onEscape: (() => void) | undefined

  readonly #units: SecretUnit[] = []
  #cursor = 0
  #pasteMode = false
  #pasteEndProgress = 0
  #pendingHighSurrogate: number | undefined
  #closed = false

  constructor(options: SecretInputOptions = {}) {
    this.onSubmit = options.onSubmit
    this.onEscape = options.onEscape ?? options.onCancel
  }

  handleInput(data: string): void {
    if (this.#closed || data.length === 0) return

    const pasteStart = data.indexOf(PASTE_START)
    if (pasteStart >= 0) {
      if (pasteStart > 0) this.#handleKeyInput(data.slice(0, pasteStart))
      if (this.#closed) return
      this.#pasteMode = true
      this.#pasteEndProgress = 0
      this.#consumePaste(data.slice(pasteStart + PASTE_START.length))
      return
    }

    if (this.#pasteMode) {
      this.#consumePaste(data)
      return
    }

    this.#handleKeyInput(data)
  }

  dispose(): void {
    this.#close()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const columns = Math.max(0, Math.floor(width))
    if (columns === 0) return ['']
    if (columns <= PROMPT.length) return [PROMPT.slice(0, columns)]

    const available = columns - PROMPT.length
    const cursorWidth = this.focused ? 1 : 0
    const maskCapacity = Math.max(0, available - cursorWidth)
    const start = this.#windowStart(maskCapacity)
    const end = Math.min(this.#units.length, start + maskCapacity)
    const visibleCount = end - start
    const cursorOffset = Math.max(0, Math.min(this.#cursor - start, visibleCount))

    let content = MASK.repeat(cursorOffset)
    if (this.focused) {
      const atCursor = this.#cursor < end ? MASK : ' '
      content += `${CURSOR_MARKER}${INVERSE}${atCursor}${RESET}`
      content += MASK.repeat(Math.max(0, visibleCount - cursorOffset - 1))
    } else {
      content += MASK.repeat(visibleCount - cursorOffset)
    }

    const line = `${PROMPT}${content}`
    return [`${line}${' '.repeat(Math.max(0, columns - visibleWidth(line)))}`]
  }

  #handleKeyInput(data: string): void {
    const keybindings = getKeybindings()
    if (keybindings.matches(data, 'tui.select.cancel')) {
      this.#flushPendingHighSurrogate()
      this.#cancel()
      return
    }
    if (keybindings.matches(data, 'tui.input.submit') || data === '\n') {
      this.#flushPendingHighSurrogate()
      this.#submit()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteCharBackward')) {
      this.#flushPendingHighSurrogate()
      this.#deleteBackward()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteCharForward')) {
      this.#flushPendingHighSurrogate()
      this.#deleteForward()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteWordBackward')) {
      this.#flushPendingHighSurrogate()
      this.#deleteWordBackward()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteWordForward')) {
      this.#flushPendingHighSurrogate()
      this.#deleteWordForward()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteToLineStart')) {
      this.#flushPendingHighSurrogate()
      this.#deleteToLineStart()
      return
    }
    if (keybindings.matches(data, 'tui.editor.deleteToLineEnd')) {
      this.#flushPendingHighSurrogate()
      this.#deleteToLineEnd()
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorLeft')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = Math.max(0, this.#cursor - 1)
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorRight')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = Math.min(this.#units.length, this.#cursor + 1)
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorLineStart')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = 0
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorLineEnd')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = this.#units.length
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorWordLeft')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = this.#wordLeft(this.#cursor)
      return
    }
    if (keybindings.matches(data, 'tui.editor.cursorWordRight')) {
      this.#flushPendingHighSurrogate()
      this.#cursor = this.#wordRight(this.#cursor)
      return
    }

    const kittyPrintable = decodeKittyPrintable(data)
    if (kittyPrintable !== undefined) {
      this.#insertText(kittyPrintable)
      return
    }
    if (!containsControlCharacter(data)) this.#insertText(data)
  }

  #consumePaste(data: string): void {
    let index = 0
    while (index < data.length) {
      if (this.#pasteEndProgress > 0) {
        while (this.#pasteEndProgress > 0 && index < data.length) {
          if (data[index] === PASTE_END[this.#pasteEndProgress]) {
            this.#pasteEndProgress += 1
            index += 1
            if (this.#pasteEndProgress === PASTE_END.length) {
              this.#pasteMode = false
              this.#pasteEndProgress = 0
              if (index < data.length) this.handleInput(data.slice(index))
              return
            }
          } else {
            this.#pasteEndProgress = 0
          }
        }
        if (this.#pasteEndProgress > 0) return
      }

      const markerIndex = data.indexOf(PASTE_END.charAt(0), index)
      if (markerIndex < 0) {
        this.#insertText(data.slice(index))
        return
      }
      this.#insertText(data.slice(index, markerIndex))
      index = markerIndex + 1
      this.#pasteEndProgress = 1
    }
  }

  #insertText(text: string): void {
    for (let index = 0; index < text.length; ) {
      const codeUnit = text.charCodeAt(index)
      if (this.#pendingHighSurrogate !== undefined) {
        if (isLowSurrogate(codeUnit)) {
          const codePoint =
            0x10000 + ((this.#pendingHighSurrogate - 0xd800) << 10) + (codeUnit - 0xdc00)
          this.#pendingHighSurrogate = undefined
          this.#insertCodePoint(codePoint)
          index += 1
          continue
        }
        this.#flushPendingHighSurrogate()
      }

      if (isHighSurrogate(codeUnit)) {
        this.#pendingHighSurrogate = codeUnit
        index += 1
        continue
      }
      this.#insertCodePoint(isLowSurrogate(codeUnit) ? 0xfffd : codeUnit)
      index += 1
    }
  }

  #insertCodePoint(codePoint: number): void {
    if (codePoint === 13 || codePoint === 10) return
    if (codePoint === 9) {
      for (let index = 0; index < 4; index += 1) this.#insertUnit(' ')
      return
    }
    if (isControlCodePoint(codePoint)) return
    this.#insertUnit(String.fromCodePoint(codePoint))
  }

  #flushPendingHighSurrogate(): void {
    if (this.#pendingHighSurrogate === undefined) return
    this.#pendingHighSurrogate = undefined
    this.#insertCodePoint(0xfffd)
  }

  #insertUnit(segment: string): void {
    const bytes = TEXT_ENCODER.encode(segment)
    if (bytes.length === 0) return

    const previous = this.#units[this.#cursor - 1]
    if (previous !== undefined) {
      const previousText = TEXT_DECODER.decode(previous.bytes)
      const combinedText = `${previousText}${segment}`
      if ([...GRAPHEME_SEGMENTER.segment(combinedText)].length === 1) {
        const combinedBytes = new Uint8Array(previous.bytes.length + bytes.length)
        combinedBytes.set(previous.bytes)
        combinedBytes.set(bytes, previous.bytes.length)
        bytes.fill(0)
        previous.bytes.fill(0)
        this.#units[this.#cursor - 1] = makeSecretUnit(combinedText, combinedBytes)
        return
      }
    }

    this.#units.splice(this.#cursor, 0, makeSecretUnit(segment, bytes))
    this.#cursor += 1
  }

  #deleteBackward(): void {
    if (this.#cursor === 0) return
    this.#removeRange(this.#cursor - 1, 1)
    this.#cursor -= 1
  }

  #deleteForward(): void {
    if (this.#cursor >= this.#units.length) return
    this.#removeRange(this.#cursor, 1)
  }

  #deleteWordBackward(): void {
    const start = this.#wordLeft(this.#cursor)
    this.#removeRange(start, this.#cursor - start)
    this.#cursor = start
  }

  #deleteWordForward(): void {
    const end = this.#wordRight(this.#cursor)
    this.#removeRange(this.#cursor, end - this.#cursor)
  }

  #deleteToLineStart(): void {
    this.#removeRange(0, this.#cursor)
    this.#cursor = 0
  }

  #deleteToLineEnd(): void {
    this.#removeRange(this.#cursor, this.#units.length - this.#cursor)
  }

  #wordLeft(from: number): number {
    let cursor = from
    while (cursor > 0 && this.#units[cursor - 1]?.whitespace) cursor -= 1
    if (cursor === 0) return cursor
    if (this.#units[cursor - 1]?.punctuation) {
      while (cursor > 0 && this.#units[cursor - 1]?.punctuation) cursor -= 1
      return cursor
    }
    while (
      cursor > 0 &&
      !this.#units[cursor - 1]?.whitespace &&
      !this.#units[cursor - 1]?.punctuation
    )
      cursor -= 1
    return cursor
  }

  #wordRight(from: number): number {
    let cursor = from
    while (cursor < this.#units.length && this.#units[cursor]?.whitespace) cursor += 1
    if (cursor >= this.#units.length) return cursor
    if (this.#units[cursor]?.punctuation) {
      while (cursor < this.#units.length && this.#units[cursor]?.punctuation) cursor += 1
      return cursor
    }
    while (
      cursor < this.#units.length &&
      !this.#units[cursor]?.whitespace &&
      !this.#units[cursor]?.punctuation
    )
      cursor += 1
    return cursor
  }

  #removeRange(start: number, count: number): void {
    if (count <= 0) return
    const removed = this.#units.splice(start, count)
    for (const unit of removed) unit.bytes.fill(0)
  }

  #windowStart(capacity: number): number {
    if (this.#units.length <= capacity) return 0
    if (capacity === 0) return Math.min(this.#cursor, this.#units.length)
    const half = Math.floor(capacity / 2)
    if (this.#cursor < half) return 0
    if (this.#cursor > this.#units.length - half) return Math.max(0, this.#units.length - capacity)
    return Math.max(0, Math.min(this.#units.length - capacity, this.#cursor - half))
  }

  #submit(): void {
    if (this.#closed) return
    const callback = this.onSubmit
    if (callback === undefined) {
      this.#close()
      return
    }

    let bytes: Uint8Array | undefined
    try {
      bytes = copyBytes(this.#units)
    } finally {
      this.#close()
    }
    callback(bytes as OwnedSecretBytes)
  }

  #cancel(): void {
    if (this.#closed) return
    const callback = this.onEscape
    this.#close()
    callback?.()
  }

  #close(): void {
    for (const unit of this.#units) unit.bytes.fill(0)
    this.#units.length = 0
    this.#cursor = 0
    this.#pasteMode = false
    this.#pasteEndProgress = 0
    this.#pendingHighSurrogate = undefined
    this.#closed = true
    this.focused = false
  }
}

export { MaskedSecretInput as SecretInput }

function copyBytes(units: readonly SecretUnit[]): Uint8Array {
  let length = 0
  for (const unit of units) length += unit.bytes.length
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const unit of units) {
    bytes.set(unit.bytes, offset)
    offset += unit.bytes.length
  }
  return bytes
}

function makeSecretUnit(segment: string, bytes: Uint8Array): SecretUnit {
  return {
    bytes,
    whitespace: /^\p{White_Space}+$/u.test(segment),
    punctuation: /^[\p{P}\p{S}]+$/u.test(segment),
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 32 || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f)
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)
  })
}

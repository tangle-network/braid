import { Buffer } from 'node:buffer'

export const MAX_JSON_BYTES = 16 * 1024 * 1024
export const MAX_JSON_DEPTH = 64
export const MAX_JSON_NODES = 100_000
const MAX_JSON_STRING_BYTES = 4 * 1024 * 1024
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function fail(message) {
  throw new Error(message)
}

function safeKey(key, label) {
  if (DANGEROUS_KEYS.has(key)) fail(`${label} contains a prototype key`)
  if (Buffer.byteLength(key, 'utf8') > MAX_JSON_STRING_BYTES)
    fail(`${label} contains an oversized key`)
}

function inspectRecord(value, label) {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} has an unexpected prototype`)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} contains a symbol key`)
  for (const key of Object.getOwnPropertyNames(value)) {
    safeKey(key, label)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true)
      fail(`${label}.${key} is not an enumerable data property`)
  }
}

function inspectArray(value, label) {
  if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} has an unexpected prototype`)
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(key))
      fail(`${label} contains a non-index property`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (key !== 'length') {
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true)
        fail(`${label}[${key}] is not an enumerable data property`)
      if (Number(key) >= value.length) fail(`${label}[${key}] is outside the array`)
    }
  }
  if (value.length > MAX_JSON_NODES) fail(`${label} is too large`)
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(`${label} contains an array hole`)
  }
}

export function assertSafeJsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is not a JSON object`)
  inspectRecord(value, label)
}

export function assertSafeJsonValue(value, label = 'JSON value') {
  const seen = new WeakSet()
  let nodes = 0

  function visit(current, path, depth) {
    nodes += 1
    if (nodes > MAX_JSON_NODES) fail(`${label} exceeds the node limit`)
    if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds the depth limit`)
    if (current === null || typeof current === 'boolean') return
    if (typeof current === 'string') {
      if (Buffer.byteLength(current, 'utf8') > MAX_JSON_STRING_BYTES)
        fail(`${path} exceeds the string limit`)
      return
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(`${path} is not finite`)
      return
    }
    if (typeof current !== 'object') fail(`${path} is not a JSON value`)
    if (seen.has(current)) fail(`${path} contains a cycle or repeated object`)
    seen.add(current)
    if (Array.isArray(current)) {
      inspectArray(current, path)
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
        visit(descriptor.value, `${path}[${index}]`, depth + 1)
      }
    } else {
      inspectRecord(current, path)
      for (const key of Object.getOwnPropertyNames(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        visit(descriptor.value, `${path}.${key}`, depth + 1)
      }
    }
  }

  visit(value, label, 0)
}

class JsonShapeScanner {
  constructor(text, label) {
    this.text = text
    this.label = label
    this.index = 0
    this.nodes = 0
  }

  fail(message) {
    fail(`${this.label} ${message} at byte ${this.index}`)
  }

  skipWhitespace() {
    while (/[ \t\r\n]/u.test(this.text[this.index] ?? '')) this.index += 1
  }

  consume(expected) {
    if (this.text[this.index] !== expected) this.fail(`expected ${expected}`)
    this.index += 1
  }

  parseString() {
    const start = this.index
    this.consume('"')
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index)
      if (code < 0x20) this.fail('contains an unescaped control character')
      if (code === 0x22) {
        this.index += 1
        const raw = this.text.slice(start, this.index)
        if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_STRING_BYTES)
          this.fail('contains an oversized string')
        try {
          return JSON.parse(raw)
        } catch {
          this.fail('contains an invalid string escape')
        }
      }
      if (code === 0x5c) {
        this.index += 2
        continue
      }
      this.index += 1
    }
    this.fail('contains an unterminated string')
  }

  parseLiteral(literal) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal)
      this.fail(`expected ${literal}`)
    this.index += literal.length
  }

  parseNumber() {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)
    if (!match) this.fail('contains an invalid number')
    this.index += match[0].length
  }

  parseValue(depth) {
    this.nodes += 1
    if (this.nodes > MAX_JSON_NODES) this.fail('exceeds the node limit')
    if (depth > MAX_JSON_DEPTH) this.fail('exceeds the depth limit')
    this.skipWhitespace()
    const token = this.text[this.index]
    if (token === '"') {
      this.parseString()
      return
    }
    if (token === '{') {
      this.parseObject(depth + 1)
      return
    }
    if (token === '[') {
      this.parseArray(depth + 1)
      return
    }
    if (token === 't') {
      this.parseLiteral('true')
      return
    }
    if (token === 'f') {
      this.parseLiteral('false')
      return
    }
    if (token === 'n') {
      this.parseLiteral('null')
      return
    }
    this.parseNumber()
  }

  parseObject(depth) {
    this.consume('{')
    this.skipWhitespace()
    const keys = new Set()
    if (this.text[this.index] === '}') {
      this.index += 1
      return
    }
    while (true) {
      this.skipWhitespace()
      if (this.text[this.index] !== '"') this.fail('object key is not a string')
      const key = this.parseString()
      safeKey(key, this.label)
      if (keys.has(key)) this.fail('contains duplicate key')
      keys.add(key)
      this.skipWhitespace()
      this.consume(':')
      this.parseValue(depth)
      this.skipWhitespace()
      if (this.text[this.index] === '}') {
        this.index += 1
        return
      }
      this.consume(',')
    }
  }

  parseArray(depth) {
    this.consume('[')
    this.skipWhitespace()
    if (this.text[this.index] === ']') {
      this.index += 1
      return
    }
    while (true) {
      this.parseValue(depth)
      this.skipWhitespace()
      if (this.text[this.index] === ']') {
        this.index += 1
        return
      }
      this.consume(',')
    }
  }

  scan() {
    this.parseValue(0)
    this.skipWhitespace()
    if (this.index !== this.text.length) this.fail('has trailing data')
  }
}

export function parseJson(text, label, maxBytes = MAX_JSON_BYTES) {
  if (typeof text !== 'string') fail(`${label} is not text`)
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(`${label} exceeds the byte limit`)
  new JsonShapeScanner(text, label).scan()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  assertSafeJsonValue(value, label)
  return value
}

function compareKeys(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.keys(value)
    .sort(compareKeys)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`
}

export function canonicalJson(value) {
  assertSafeJsonValue(value, 'Canonical JSON')
  return canonicalize(value)
}

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { Chalk } from 'chalk'
import {
  type AppearanceEnvironment,
  type ColorMode,
  chalkLevel,
  resolveColorMode,
} from '../shared/appearance.js'

export interface BraidTheme {
  readonly color: ColorMode
  readonly highContrast: boolean
  readonly reducedMotion: boolean
  readonly terminalMetadata: boolean
  readonly brand: (text: string) => string
  readonly accent: (text: string) => string
  readonly text: (text: string) => string
  readonly muted: (text: string) => string
  readonly danger: (text: string) => string
  readonly warning: (text: string) => string
  readonly success: (text: string) => string
  readonly userBackground: (text: string) => string
  readonly progress: (text: string) => string
  readonly editor: EditorTheme
  readonly markdown: MarkdownTheme
  readonly select: SelectListTheme
}

export interface BraidThemeOptions {
  readonly colors?: boolean
  readonly color?: ColorMode
  readonly highContrast?: boolean
  readonly reducedMotion?: boolean
  readonly environment?: AppearanceEnvironment
}

export function createBraidTheme(options: boolean | BraidThemeOptions): BraidTheme {
  const resolved = typeof options === 'boolean' ? { colors: options } : options
  const color =
    resolved.colors === false
      ? 'none'
      : resolveColorMode(resolved.color, resolved.environment ?? process.env)
  const highContrast = resolved.highContrast ?? false
  const reducedMotion = resolved.reducedMotion ?? false
  const terminalMetadata = color !== 'none' && !reducedMotion
  const chalk = new Chalk({ level: chalkLevel(color) })
  const accent = (text: string) =>
    highContrast ? chalk.bold.white(text) : chalk.rgb(119, 166, 255)(text)
  const muted = (text: string) =>
    highContrast ? chalk.white(text) : chalk.rgb(135, 145, 165)(text)
  const text = (value: string) =>
    highContrast ? chalk.bold.white(value) : chalk.rgb(225, 230, 240)(value)
  const semanticMuted = highContrast ? (value: string) => chalk.white(value) : muted
  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: (text) => chalk.bold(accent(text)),
    description: semanticMuted,
    scrollInfo: semanticMuted,
    noMatch: semanticMuted,
  }
  return {
    color,
    highContrast,
    reducedMotion,
    terminalMetadata,
    brand: (text) => (highContrast ? chalk.bold.white(text) : chalk.bold.rgb(151, 190, 255)(text)),
    accent,
    text,
    muted: semanticMuted,
    danger: highContrast
      ? (value) => chalk.bold.underline.white(value)
      : (value) => chalk.rgb(255, 111, 120)(value),
    warning: highContrast
      ? (value) => chalk.bold.white(value)
      : (value) => chalk.rgb(255, 194, 92)(value),
    success: highContrast
      ? (value) => chalk.bold.white(value)
      : (value) => chalk.rgb(112, 211, 151)(value),
    userBackground: highContrast
      ? (value) => chalk.bgWhite.black(value)
      : (value) => chalk.bgRgb(34, 48, 70)(value),
    progress: (value) => (reducedMotion || value.endsWith('…') ? value : `${value}…`),
    editor: { borderColor: muted, selectList: select },
    markdown: {
      heading: (text) => chalk.bold(accent(text)),
      link: accent,
      linkUrl: muted,
      code: (text) => chalk.rgb(255, 205, 117)(text),
      codeBlock: (text) => chalk.rgb(189, 211, 255)(text),
      codeBlockBorder: muted,
      quote: (text) => chalk.italic(text),
      quoteBorder: muted,
      hr: muted,
      listBullet: accent,
      bold: (text) => chalk.bold(text),
      italic: (text) => chalk.italic(text),
      strikethrough: (text) => chalk.strikethrough(text),
      underline: (text) => chalk.underline(text),
    },
    select,
  }
}

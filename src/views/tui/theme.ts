import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'
import { Chalk } from 'chalk'

export interface BraidTheme {
  readonly brand: (text: string) => string
  readonly accent: (text: string) => string
  readonly text: (text: string) => string
  readonly muted: (text: string) => string
  readonly danger: (text: string) => string
  readonly warning: (text: string) => string
  readonly success: (text: string) => string
  readonly userBackground: (text: string) => string
  readonly editor: EditorTheme
  readonly markdown: MarkdownTheme
  readonly select: SelectListTheme
}

export function createBraidTheme(colors: boolean): BraidTheme {
  const chalk = new Chalk({ level: colors ? 3 : 0 })
  const accent = (text: string) => chalk.rgb(119, 166, 255)(text)
  const muted = (text: string) => chalk.rgb(135, 145, 165)(text)
  const select: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: (text) => chalk.bold(accent(text)),
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  }
  return {
    brand: (text) => chalk.bold.rgb(151, 190, 255)(text),
    accent,
    text: (text) => chalk.rgb(225, 230, 240)(text),
    muted,
    danger: (text) => chalk.rgb(255, 111, 120)(text),
    warning: (text) => chalk.rgb(255, 194, 92)(text),
    success: (text) => chalk.rgb(112, 211, 151)(text),
    userBackground: (text) => chalk.bgRgb(34, 48, 70)(text),
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

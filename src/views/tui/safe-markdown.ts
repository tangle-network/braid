import {
  Markdown,
  type Component,
  type DefaultTextStyle,
  type MarkdownOptions,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import { redactSensitiveUrls, sanitizeUrl } from '../shared/sanitize.js'

// biome-ignore lint/complexity/useRegexLiterals: a literal OSC parser is rejected as containing controls
const OSC_8 = new RegExp(
  String.raw`\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)`,
  'gu',
)

function safeTheme(theme: MarkdownTheme): MarkdownTheme {
  return {
    ...theme,
    linkUrl: (text) => {
      const match = /^\s*\((.*)\)\s*$/su.exec(text)
      const safe = match?.[1] ? sanitizeUrl(match[1]) : undefined
      return safe ? theme.linkUrl(` (${safe})`) : theme.linkUrl(' ([link removed])')
    },
  }
}

export function sanitizeRenderedMarkdown(input: string): string {
  const links = input.replace(OSC_8, (sequence, href: string) => {
    if (!href) return sequence
    const safe = sanitizeUrl(href)
    return safe ? `\u001b]8;;${safe}\u001b\\` : ''
  })
  return redactSensitiveUrls(links)
}

export class SafeMarkdown implements Component {
  readonly #markdown: Markdown

  constructor(
    text: string,
    paddingX: number,
    paddingY: number,
    theme: MarkdownTheme,
    defaultTextStyle?: DefaultTextStyle,
    options?: MarkdownOptions,
  ) {
    this.#markdown = new Markdown(
      text,
      paddingX,
      paddingY,
      safeTheme(theme),
      defaultTextStyle,
      options,
    )
  }

  setText(text: string): void {
    this.#markdown.setText(text)
  }

  invalidate(): void {
    this.#markdown.invalidate()
  }

  render(width: number): string[] {
    return this.#markdown.render(width).map(sanitizeRenderedMarkdown)
  }
}

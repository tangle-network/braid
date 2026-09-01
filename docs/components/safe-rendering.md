# Safe rendering and responsive layout

## Job

Safe rendering preserves terminal integrity, Unicode correctness, and primary meaning across trusted and untrusted content.

## Best simple implementation

Sanitize untrusted text before any Pi component receives it.

Suppress OSC control sequences by default.

Render Markdown through `SafeMarkdown` after stream-boundary sanitization.

Compute one layout mode from current terminal dimensions.

Use progressive disclosure instead of separate product behavior at each width.

## Component map

| Component | Responsibility |
| --- | --- |
| `SafeMarkdown` | Render bounded semantic Markdown after terminal sanitization. |

Layout, theme, terminal identity, usage, and focused-surface helpers serve every visible component.

## Sanitization boundary

Provider chunks first pass through the stateful stream sanitizer.

Semantic projection then removes or replaces unsafe terminal text.

The renderer handles only sanitized strings and structured view values.

Terminal titles use the stricter title sanitizer.

Secret values never enter this boundary.

## Layout modes

Narrow mode supports terminals below 80 columns.

Standard mode supports the primary 80-column workflow.

Wide mode starts at 120 columns and adds secondary evidence.

Row count also bounds composer growth, modal height, selector rows, and transcript viewport.

Components recompute layout after every resize without changing product state.

## Unicode and width

All clipping uses terminal cell width rather than JavaScript string length.

Wide glyphs, combining marks, emoji, and zero-width characters remain atomic.

The renderer never splits an ANSI sequence or a terminal cell.

Truncation markers consume their own measured width.

## Failure and safety

An incomplete escape candidate stays buffered until it becomes safe text or a suppressed control.

Oversized content is bounded before layout work.

Malformed Markdown renders as safe text.

Unknown color support falls back to semantic text without changing content.

## Performance

Sanitization processes each incoming character once with bounded carry state.

Layout helpers avoid scanning durable history.

Renderers cap visible rows and details before width fitting.

## Proof

Tests cover split control sequences, OSC, CSI, C1 controls, Unicode width, resize, paste, Markdown, long lines, and hostile provider output.

Captures compare semantic cells and raster output at the four required dimensions.

## Non-goals

Sanitization does not interpret provider-native protocol output.

Responsive layout does not hide a blocking status, missing value, or capability reason.

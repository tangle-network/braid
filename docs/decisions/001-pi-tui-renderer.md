# ADR 001: Use Pi TUI as the renderer, not Pi as the application

Status: accepted

Date: 2026-08-01

## Context

Braid needs a high-quality terminal editor, scrolling transcript, overlays, Unicode handling, responsive layout, and deterministic rendering tests.

Pi publishes the production rendering, editing, input, layout, overlay, and terminal-interface capabilities as the MIT-licensed `@earendil-works/pi-tui` package.

Its repository's deterministic terminal helper is test-only and is not exported by the published package.

Pi's complete coding-agent interface is polished, but its application coordinator directly owns Pi sessions, models, authentication, commands, and provider behavior.

Kimi Code contains stronger generalized approval and question presentation, but its terminal application is larger and coupled to Kimi SDK types.

OpenCode and Hermes Agent provide useful references but require broader stack adoption.

## Decision

Braid will pin and depend on `@earendil-works/pi-tui` for terminal primitives.

Braid will build a new thin application shell whose controllers consume Braid ports over Tangle packages.

Braid may selectively adapt application components from Pi and Kimi Code after replacing all source-specific domain types with Braid view models.

Braid will not fork a complete terminal application or vendor Pi TUI production code during the initial implementation.

Braid may adapt Pi's small test-only terminal helper with source and license attribution, or replace it with a supported upstream testing export if one becomes available.

## Consequences

Braid receives a mature terminal foundation without inheriting another agent loop.

Braid must implement its own application state, command registry, profile workflow, event reduction, persistence, and runtime adapters.

Selective adaptations require immutable source references, license notices, and local tests.

An upstream Pi TUI upgrade is explicit and can be tested independently from runtime changes.

If an essential primitive is missing, the preferred order is to contribute it upstream, maintain a narrow patch with a regression test, and vendor only as a last resort.

## Rejected alternatives

Forking Pi's entire interactive mode was rejected because it makes Pi session identity and model configuration the center of Braid.

Forking Kimi Code was rejected because decoupling 39,688 lines of terminal application is riskier than adapting its strongest dialogs.

Starting with OpenTUI was rejected because it adds a wider UI stack without eliminating Braid's application work.

Extending the runtime monitor was rejected because a diagnostic projection should not own the product experience.

## Verification

The decision remains valid only if the first vertical slice passes `VT-01` through `VT-06` in the delivery plan.

Failure of two essential Pi primitives or an unmaintainable patch burden triggers a written comparison against OpenTUI before the dependency is changed.

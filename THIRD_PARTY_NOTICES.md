# Third-party notices

Braid contains a test-only adaptation from Pi and a Windows release-proof process-control adaptation from Microsoft Aspire.

The implementation is expected to depend on and adapt behavior from the following MIT-licensed projects.

| Project | Planned use | Source inspected | License |
| --- | --- | --- | --- |
| [`@earendil-works/pi-tui`](https://github.com/earendil-works/pi/tree/master/packages/tui) | Runtime dependency for rendering, layout, input, and overlays; test-only adaptation of `test/virtual-terminal.ts` | `earendil-works/pi@a6f7317dfca61e357aee65faafe012a1be6c3734` | MIT |
| [Pi coding agent](https://github.com/earendil-works/pi/tree/master/packages/coding-agent) | Behavioral reference and possible selective adaptation of selectors, transcript components, and session-tree presentation | `earendil-works/pi@a6f7317dfca61e357aee65faafe012a1be6c3734` | MIT |
| [Kimi Code](https://github.com/MoonshotAI/kimi-code/tree/main/apps/kimi-code/src/tui) | Behavioral reference and possible selective adaptation of approval, question, queue, and modal coordination components | `MoonshotAI/kimi-code@e22479a62eed9c3b78a67b313f4332c2c0ba9670` | MIT |
| [OpenCode](https://github.com/anomalyco/opencode) | Architecture and interaction reference only | `anomalyco/opencode@32f278b48f1a495611165d8a9f1ace0b512933e2` | MIT |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/tree/main/ui-tui) | Client/runtime separation and workflow reference only | `NousResearch/hermes-agent@f88ed6c71768cdc7ea3bfa8cf62d16654792fd2a` | MIT |
| [Microsoft Aspire](https://github.com/dotnet/aspire) | Windows Job Object creation and cleanup pattern for portable release proof | `dotnet/aspire@be77aa36daf995fae0e72091141410c7082fcba3` | MIT |
| [`better-sqlite3-multiple-ciphers`](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | Pinned production SQLite binding with SQLCipher-compatible encryption | `better-sqlite3-multiple-ciphers@13.0.3` | MIT |
| [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) | Native macOS Keychain, Linux Secret Service, and Windows Credential Manager access without passing secrets through command arguments | `@napi-rs/keyring@1.3.0` | MIT |
| [Koffi](https://github.com/Koromix/koffi) | Prebuilt Node FFI for operating system `openat`, `mkdirat`, `linkat`, `renameat`, and `unlinkat` calls | `koffi@3.1.4` | MIT |

## Attribution rule

Before copied or substantially adapted code is committed, add one row below with the Braid path, source URL, immutable source commit, source path, license, and a short description of the adaptation.

| Braid path | Upstream source | Source commit | License | Adaptation |
| --- | --- | --- | --- | --- |
| `test/support/virtual-terminal.ts` | [`earendil-works/pi`, `packages/tui/test/virtual-terminal.ts`](https://github.com/earendil-works/pi/blob/a6f7317dfca61e357aee65faafe012a1be6c3734/packages/tui/test/virtual-terminal.ts) | `a6f7317dfca61e357aee65faafe012a1be6c3734` | MIT, Copyright (c) 2025 Mario Zechner | Changed imports to the published Pi TUI package and applied Braid formatting; production code does not include this file. |
| `scripts/live-bridge/windows-job-host-source.mjs` | [`dotnet/aspire`, `src/Aspire.Cli/Processes/WindowsConsoleProcessJob.cs` and `WindowsProcessInterop.cs`](https://github.com/dotnet/aspire/tree/be77aa36daf995fae0e72091141410c7082fcba3/src/Aspire.Cli/Processes) | `be77aa36daf995fae0e72091141410c7082fcba3` | MIT, Copyright (c) .NET Foundation and contributors | Adapted atomic Job Object attachment, kill-on-close containment, and active-process drain checks for Braid's Windows release proof. |

The original copyright and license notice must remain with every substantial copied portion.

A dependency declared in `package.json` does not require a file-level source header, but its license must remain represented in the generated release license inventory.

W5 adds the pinned `better-sqlite3-multiple-ciphers@13.0.3`, `@napi-rs/keyring@1.3.0`, and `koffi@3.1.4` production dependencies.

It contains no copied source from these packages.

Its coordinator, storage port, credential port, and release scripts use Braid code and Node.js platform APIs around that binding.

The generated `THIRD_PARTY_LICENSES.json` inventory must include both native bindings and all of their transitive production dependencies.

The release process must fail if a copied-source header has no matching notice row or if a production dependency has an unknown or disallowed license.

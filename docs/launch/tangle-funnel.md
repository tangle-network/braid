# How Braid leads to Tangle signups (draft, internal)

> Internal draft for Drew. It maps what Braid 0.3.0 actually uses from Tangle, where a user meets it, and where each launch asset asks for a signup.
> File references are for the team; none of them belong in public copy.

## The funnel in one line

A developer installs Braid for free and uses local runners through CLI Bridge.
They need a Tangle key the first time they choose **Tangle Inference** or **Tangle Sandbox**.
That choice is the conversion point, and Braid shows no signup link there today.

## Tangle features Braid uses

| Tangle feature | Code path | When the user sees it | Can the launch claim it? |
| --- | --- | --- | --- |
| Tangle Sandbox, ephemeral runs | `src/bin/production-setup-discovery.ts:83` offers the connection; endpoint `https://sandbox.tangle.tools` in `src/adapters/connections/production-connection-types.ts:29` | First-run setup lists **Tangle Sandbox** beside Local CLI Bridge and Tangle Inference. Each turn gets a fresh cloud environment that is deleted after the turn. | Yes from the 20-job production cohort on 2026-08-12. The protected 0.3.0 LIVE-07 row still needs a passing receipt. |
| Tangle Sandbox, retained runs with detach and reconnect | `src/app/production-composition.ts:299-326` selects the retained port; `src/adapters/runtime/tangle-sandbox-retention.ts` sets the idle timeout | `/detach`, then `braid --conversation <id>` and `/reconnect` after a restart | Yes, with proof dates. Needs a manual `config.json` edit, because setup cannot create a retained connection. |
| Native terminal inside the sandbox | `src/bin/native-interactive-actions.ts`, `src/adapters/runtime/tangle-retained-interactive-execution.ts` | `/interactive <prompt>` and `/attach` open the runner's own UI in the cloud session | LIVE-08 passed native terminal input after reconnect in protected run 35912417993. It did not test a question, permission, or plan response. |
| Tangle router for model calls | Endpoint `https://router.tangle.tools` in `src/adapters/connections/production-connection-endpoints.ts:11`; model ids such as `tangle-router/glm-5.3` in the profile | The model name in the status line; the **Tangle Inference** connection | Yes. |
| Router attribution of Braid usage | `src/adapters/connections/tangle-router-client.ts` (#64) adds `x-tangle-client: braid/<version>` to Tangle Inference turns, trace-analysis model calls, connection health checks, and the eval probe | Not visible to the user | Internal. The router can count requests with this header in aggregate. Do not link them to account or signup records without explicit consent. Sandbox runs do not send it; their model calls go through the sandbox. |
| Cost and usage disclosure | `src/views/shared/usage-projection.ts` sets cost status (`reported`, `estimated`, `observed-floor`, `unknown`); `src/views/tui/terminal-usage.ts` shows it | Footer shows `in N · out N · $X`; `/activity` shows `~$X` for estimates; unknown cost is left out, never shown as `$0` | Yes. The Runtime marks sandbox cost as an estimate when no billing receipt exists (#61). |
| Trace analysis on Tangle models | `src/adapters/analysis/runtime-model-owner.ts:733` sends analysis calls through the run's route | `/ask`, `/analyze`, `/compare` | Yes for the feature. The live analysis proof (LIVE-12, #45) is from 2026-09-02, before the current dependency set. |
| Confidential workspace forks | `src/app/confidential-workspace-fork.ts`, `src/app/conversation-branches.ts:396-401` | `/fork --workspace --confidential <JSON>` | **No.** Provider 1.6.0 reports no confidential placement, so Braid refuses every confidential fork. Market it only after a provider reports it and LIVE-10 proves attestation. |
| Workspace forks | `src/app/conversation-branch-effects.ts` | `/fork --workspace` | LIVE-09 passed on production in protected run 35912417993. Cite the approved full release evidence when it exists. |

## Phone and email: not in Braid

A case-insensitive search of `src/`, `docs/`, `scripts/`, `test/`, and `artifacts/` found no phone, SMS, Twilio, telephony, SMTP, email-provider, or IMAP code.
The only hits are git `user.email` test fixtures and the word "resend" in one document.
Braid does not showcase phone or email today, and no launch asset should suggest it does.

For Braid to showcase them, three pieces would need to exist:

1. A Tangle notification or messaging service with a public API.
2. A provider capability that reports it, so Braid can enable it only when present, like every other action.
3. A Braid surface that uses it, for example a message when a detached run is waiting for an approval.

The interaction path already exists; see `/approve` and `respond_interaction`.
Only the delivery channel is missing.

## Signup call to action for each asset

The signup URL is not decided. Every placement below uses `<signup URL>` until Drew picks it.
Tag every link with its asset, for example `?utm_source=braid&utm_medium=<asset>`.

| Asset | Placement | Wording |
| --- | --- | --- |
| Release notes | One line after Upgrade notes | "Tangle Sandbox and Tangle Inference need a Tangle key: `<signup URL>`." |
| README hero | Comment on the `BRAID_TANGLE_AUTH` line of the quickstart | "only for Tangle inference or Tangle Sandbox: get a key at `<signup URL>`" |
| Demo video | End card, beside the repository URL | "Cloud sandbox: `<signup URL>`" |
| Comparison page | None in the body. One footer link to the repository | A comparison with a signup button reads as a sales page, and the house rules forbid it. |
| Braid itself (product change, not in this PR) | The credential error at `src/bin/production-setup-credentials.ts:250` and the setup screen for Tangle connections | "…requires a credential; enter it in setup or set BRAID_TANGLE_AUTH. Get a key at `<signup URL>`." This is the one moment when the user already wants a key. |

## Measuring it

- **Braid installs:** npm downloads for `@tangle-network/braid`.
- **Braid traffic on Tangle:** aggregate router request counts with `x-tangle-client: braid/*`, without API keys or account identifiers. This is a request count, not a user count; sandbox traffic is outside it.
- **Signups from launch assets:** aggregate signup counts by `utm_source=braid`, split by `utm_medium`. Respect the signup site's own consent settings.

Report these as separate totals.
Do not join signup records to router requests under the current [product contract](../01-product-contract.md#product-quality-measures) and [security rules](../07-security-and-privacy.md#telemetry-and-privacy).
Braid excludes account identifiers from telemetry and requires explicit consent for opt-in usage or retention metrics.

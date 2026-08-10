# Semantic evaluation cost-bound autopsy

## Verdict

The failed evaluation used the wrong execution path.

Braid sent judge prompts through a coding CLI whose hidden context exceeded the reserved input and output budget.

The provider charged 2.283 times the reservation before `agent-eval` rejected settlement.

## Evidence

- Failed run: `/tmp/braid-semantic-eval-fze12E`.
- Reserved cost: `$0.0044426` from 6,231 input tokens and a 320-token completion allowance.
- Reported cost: `$0.010143` from 12,989 input tokens and 1,068 output tokens.
- The CLI ignored the requested completion limit and injected runner context that the reservation could not observe.

## Root cause

The release judge bypassed Runtime and used CLI Bridge as a coding runner.

That route could not bind one exact `AgentProfile`, one total completion limit, and one provider request body before spend.

This was a design defect, not random model variance.

## Permanent correction

The semantic judge now uses Runtime `profileChatClient` with one exact judge profile.

The profile routes directly to Tangle Router and sets `max_completion_tokens` to 2,048.

Runtime rejects a conflicting request limit before the provider call.

The release route requires an explicit API key and exact model discovery.

Focused tests assert the request body, headers, token accounting, and no-spend rejection path.

## Remaining proof

Run the paid pilot and complete semantic suite against the packed release candidate.

The result must settle within the reserved total completion bound and retain raw judge-call evidence.

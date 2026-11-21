# Braid 0.3.8 release notes

## Published Discovery Operator 1.4.0

- Braid bundles the same `discovery-operator` profile as the Disco device and
  controller release. The [source notice](../../THIRD_PARTY_NOTICES.md#published-discovery-operator)
  records the exact Disco revision and the source of each mounted skill.
- The operator is device-first: ordinary plays are authored, saved, preflighted
  and pressed on the requester's device (`disco workspace run --operation`, with
  receipt recovery through `disco workspace reconcile`), hosted and explicit
  publication stays opt-in, and spend authorization by exact play id and revision
  is unchanged.
- Private drafting and settled-play observation need no forge credential. The
  operator carries the trace-reading instructions used by the shipped Disco reader.
- Select it as before: `braid --profile discovery-operator`.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.8
```

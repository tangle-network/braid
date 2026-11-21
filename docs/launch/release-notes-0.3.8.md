# Braid 0.3.8 release notes

## Published Discovery Operator 1.4.0

- The bundled `discovery-operator` catalog profile is refreshed from the Disco
  master `3b916f123e21b654e824a0ae67f00fa95b4a5fba`
  (`profiles/operators/discovery-operator.json`, SHA-256
  `befea9ff388b68c3bf6a841de1e3f54de59fbe7ee38028ac6833073cf48b2d4f`).
- The operator is device-first: ordinary plays are authored, saved, preflighted
  and pressed on the requester's device (`disco workspace run --operation`, with
  receipt recovery through `disco workspace reconcile`), hosted and explicit
  publication stays opt-in, and spend authorization by exact play id and revision
  is unchanged.
- Private drafting and settled-play observation need no forge credential, and the
  mounted `inspect-agent-traces` skill is the released 3.0.1 interface
  (traces@`d43b1397f9b21a2222d11934a9afd24d293f27e9`).
- Select it as before: `braid --profile discovery-operator`.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.8
```

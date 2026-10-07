# Portable profile learning proof

The packed binary at `a33e7460de14c54758170d3085a0004026708088` completed the keyboard flow on Beelink2 at all four required terminal sizes. The [manifest](manifest.json) records its package digest and 39 checked artifact digests.

The flow finishes a task, records rejection with a correction, previews the learned profile, opens its exact changes, saves with Ctrl+S, and explicitly selects `learned.json`. The capture driver checks that no file exists before saving and that the final application profile contains the learned guidance after selection.

| Size | Preview | Changes | Saved |
| --- | --- | --- | --- |
| 40×12 | [PNG](40x12-preview.png) | [PNG](40x12-changes.png) | [PNG](40x12-saved.png) |
| 80×24 | [PNG](80x24-preview.png) | [PNG](80x24-changes.png) | [PNG](80x24-saved.png) |
| 120×40 | [PNG](120x40-preview.png) | [PNG](120x40-changes.png) | [PNG](120x40-saved.png) |
| 200×60 | [PNG](200x60-preview.png) | [PNG](200x60-changes.png) | [PNG](200x60-saved.png) |

[Keyboard recording](profile-learning-keyboard.gif) · [uncut recording](raw/profile-learning-keyboard.cast) · [capture driver](raw/capture.mjs)

PNGs render captured terminal cells; the GIF preserves original terminal output. The driver runs after `pnpm build`, accepts repository/output paths, and uses `agg` 1.9.0 at `/tmp/braid-feedback-tools/agg` plus `ffmpeg` 6.1.1. The execution fixture is deterministic. These captures establish the terminal workflow, not live model quality or cloud integration.

`test/profile-learning.test.ts` separately checks the JSONL boundary, secret-free export, preserved profile fields, replacement of previous feedback guidance, refusal to overwrite files, explicit relative-path selection, encrypted advice replay after changed state, conflicting requests, and the four keyboard sizes. The existing profile-save recovery suite also passed through every atomic-write interruption.

The [live advice attempt](live-advice-unavailable.md) remains unavailable because the existing Codex workspace route returned 401 before producing a source answer. It made no advice call and establishes no harness comparison or recommendation quality.

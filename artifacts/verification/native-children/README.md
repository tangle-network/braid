# Native child activity proof

The packed Braid binary passed keyboard inspection at 40×12, 80×24, 120×40, and 200×60 on Beelink2. Each run submitted an offline fixture turn, opened `/activity`, selected the worker filter, inspected a parent and nested child, paged through their details, and verified that Runtime worker controls are unavailable for native children.

- [80×24 activity](80x24-activity.png)
- [Parent details and observed usage](80x24-parent-usage.png)
- [Nested child details and parent identity](80x24-nested-detail.png)
- [Keyboard recording](80x24-native-children-keyboard.gif) and [original asciicast](native-children-keyboard.cast)
- [Capture manifest](capture-manifest.json) and [matching semantic snapshot](80x24-semantic.json)

The fixture sends canonical `ChildTaskEvent` values through the normal execution port. Both children finish before an earlier event is replayed. The captured projection retains two completed children, their parent relationship, and separate child usage. It creates no Runtime worker activity and leaves run totals at 10 input and 6 output tokens. Unknown child usage and cost remain marked as unreported.

This proves Braid's projection, terminal rendering, keyboard navigation, and control refusal with deterministic provider events. It does not prove that a live native runner emitted the events or that a cloud agent used native children.

## Reproduce

On a Beelink checkout with the repository's frozen dependencies, `agg`, ImageMagick, and DejaVu Sans Mono installed:

```sh
pnpm install --frozen-lockfile
pnpm run build
node scripts/capture-native-children.mjs
```

The script packs the build, installs the tarball in a temporary directory, runs that binary in `node-pty`, and records the terminal with `@xterm/headless`. Its PNGs and recording use the retained terminal output. Every manifest artifact was checked for existence and matching SHA-256 after transfer. All four sizes were visually reviewed, including paging at 40×12 and the split view at 120×40 and 200×60.

## Build identity

`source.commit` is implementation commit `bd5672e7e3d1f0adbc63aa271bfdbd0d9bc0336c`. The captured source also includes two capture-script corrections: assert the view's `complete` status spelling, and allow 300 ms for an isolated Escape key to settle before the next key. The source digest in the manifest identifies that complete captured tree. Application code and the packed binary were unchanged by those corrections.

The package is `@tangle-network/braid@0.3.4`, packed from this build. Its tarball SHA-256 is `5a881fed34d0038b67d5869dc8d8cca057e48cd8b016f38f54bab3bac0fda185`. The manifest records the source, binary, package, renderer, font, and artifact identities. This is local packed-package evidence, not an npm publication claim.

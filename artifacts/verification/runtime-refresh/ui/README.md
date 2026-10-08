# Runtime refresh terminal evidence

Captured on Beelink2 from a clean installation of the packed Braid candidate on 2026-10-07. This verifies Pi TUI 1.1.0 and the accessibility fix through real PTYs with a deterministic provider. It does not establish cloud-provider behavior.

[40×12](40x12.png) · [80×24](80x24.png) · [120×40](120x40.png) · [200×60](200x60.png) · [Keyboard recording](80x24-transcript-keyboard.gif)

The [manifest](manifest.json) records package and binary hashes, source hashes, renderer versions, keyboard actions, and selected artifact hashes. The complete capture produced 159 artifacts across 27 states. The packed PTY check also passed all four sizes, accessibility metadata suppression, Kitty input, Unicode and paste, remapping, autocomplete, and exit cleanup.

The capture candidate used Runtime 0.308.0, Interface 3.1.1, Tangle Provider 3.6.5, and Sandbox 0.60.22. Later SDK/provider approval fixes require their own consumer checks; these frames prove the terminal behavior of this recorded candidate.

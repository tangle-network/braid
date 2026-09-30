# Historical Braid 0.3.4 CLI proof media

This index documents the superseded source candidate `3b627e9199186ccfb523f07d8c52effe02e46281`.

Its installed archive SHA-256 is `f13e3bea3bbdda567cc125cde9cbbe1889625e0972fa2303da17210c47e102d9`.

It does not establish the current candidate's package or CLI behavior.

See the [current exact-candidate CLI proof](88a0fc/README.md) for source `88a0fcfc46977c8ed2b6c5d3f4da43688d8bf7fe` and archive SHA-256 `c76f4be3f1c00ca158d1e8b2bd4ac65e4be418f339601d1d544333b8c9763e06`.

The proof ran the exact installed 0.3.4 CLI with Node `v22.23.2`.

A local loopback fixture answered authenticated reads and returned HTTP 503 for writes.

No live provider request, cloud task, or cloud resource was created.

Each original `.cast` preserves the complete terminal flow and labeled process boundaries.

Each `-4x.cast` copy preserves event order and markers while dividing event times by four.

Play an original or fast copy with `asciinema play <recording.cast>`.

The casts omit key events, but rendered terminal output may show the synthetic task prompts.

Credential canaries were absent from terminal output, snapshots, request URLs and bodies, and non-Authorization headers.

The process PIDs, exit codes, request counts, state checks, marker times, and logs are in [media-manifest.json](media-manifest.json).

| Terminal size | Uncut original | 4x playback copy | CLI PIDs |
| --- | --- | --- | --- |
| 40x12 | [40x12-original.cast](40x12-original.cast) | [40x12-4x.cast](40x12-4x.cast) | 2355008, 2359249 |
| 80x24 | [80x24-original.cast](80x24-original.cast) | [80x24-4x.cast](80x24-4x.cast) | 2354676, 2359098 |
| 120x40 | [120x40-original.cast](120x40-original.cast) | [120x40-4x.cast](120x40-4x.cast) | 2354900, 2358716 |
| 200x60 | [200x60-original.cast](200x60-original.cast) | [200x60-4x.cast](200x60-4x.cast) | 2354723, 2358797 |

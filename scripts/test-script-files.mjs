#!/usr/bin/env node
// Runs repository script test files through node --test with the same canonical
// temporary root the main suite pins (scripts/test.mjs): durable storage refuses
// symlinked path prefixes, and macOS serves TMPDIR from the /var symlink.
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

const canonical = realpathSync(tmpdir())
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  env: { ...process.env, TMPDIR: canonical, TMP: canonical },
  stdio: 'inherit',
})
process.exit(result.status ?? 1)

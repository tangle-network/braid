import { fileURLToPath } from 'node:url'
import {
  findModuleSizeViolations,
  formatModuleSizeFailure,
  MODULE_SIZE_LIMIT,
} from './module-size.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const violations = await findModuleSizeViolations({ repository })

if (violations.length) {
  console.error(formatModuleSizeFailure(violations))
  process.exitCode = 1
} else {
  console.log(
    `Module size check passed: all handwritten modules are at most ${MODULE_SIZE_LIMIT} lines`,
  )
}

import { join } from 'node:path'
import { installPackedBraid } from '../packed-binary.mjs'

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0
}

export async function prepareEvalCandidate(repository, environment = process.env) {
  if (
    configured(environment.BRAID_EVAL_PACKAGE_ROOT) ||
    configured(environment.BRAID_EVAL_TARBALL_PATH)
  ) {
    return {
      environment,
      generated: false,
      cleanup: async () => undefined,
    }
  }

  const packed = await installPackedBraid(repository)
  return {
    environment: {
      ...environment,
      BRAID_EVAL_PACKAGE_ROOT: join(packed.installRoot, 'node_modules', '@tangle-network', 'braid'),
      BRAID_EVAL_TARBALL_PATH: packed.tarball,
    },
    generated: true,
    cleanup: packed.cleanup,
  }
}

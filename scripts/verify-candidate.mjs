import { verifyRelease } from './release/verification-flow.mjs'

await verifyRelease(undefined, { publicationRequired: false, writeOutputs: false })

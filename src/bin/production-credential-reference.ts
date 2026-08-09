import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { credentialRef } from '../ports/credentials.js'

export type ProductionCredentialMapping = 'default' | 'custom'

export const defaultProductionCredentialRefResolver: NonNullable<
  ProductionConnectionOptions['credentialRefResolver']
> = (ref) => credentialRef(`cred:v1:${ref}`)

export function productionCredentialMapping(
  resolver: ProductionConnectionOptions['credentialRefResolver'],
): ProductionCredentialMapping {
  return resolver === undefined || resolver === defaultProductionCredentialRefResolver
    ? 'default'
    : 'custom'
}

import type { StoragePort } from '../../ports/storage.js'
import { MemoryEffectsStorage } from './memory-effects.js'

export class MemoryStorage extends MemoryEffectsStorage implements StoragePort {}

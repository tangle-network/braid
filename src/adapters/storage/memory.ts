import { MemoryEffectsStorage } from './memory-effects.js'
import type { StoragePort } from '../../ports/storage.js'

export class MemoryStorage extends MemoryEffectsStorage implements StoragePort {}

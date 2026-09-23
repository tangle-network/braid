import type { BraidGraph } from '../domain/graph.js'
import type { ApplicationStateStore } from './application-state.js'
import { applicationGraph } from './graph-projection.js'

/** Projects graph state from the canonical journal and state store. */
export class ApplicationGraphService {
  constructor(private readonly state: ApplicationStateStore) {}

  graph(): BraidGraph {
    return applicationGraph(this.state.state(), this.state.events())
  }
}

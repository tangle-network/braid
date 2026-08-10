const AGENT_INTERFACE_ENTRY = import.meta.resolve('@tangle-network/agent-interface')
const AGENT_INTERFACE_DIRECTORY = new URL('.', AGENT_INTERFACE_ENTRY)
const MODULE_NAME = /^[a-z0-9-]+\.js$/u

if (AGENT_INTERFACE_DIRECTORY.protocol !== 'file:') {
  throw new Error('Agent Interface must resolve to an installed file package')
}

export function agentInterfaceModuleUrl(name: string): string {
  if (!MODULE_NAME.test(name)) throw new Error('Agent Interface module name is invalid')
  return new URL(name, AGENT_INTERFACE_DIRECTORY).href
}

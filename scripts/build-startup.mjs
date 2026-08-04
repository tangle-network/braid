import { build } from 'esbuild'

const root = new URL('../', import.meta.url).pathname

await build({
  absWorkingDir: root,
  entryPoints: {
    'startup/durable-runtime': 'src/startup/durable-runtime.ts',
    'startup/terminal-runtime': 'src/startup/terminal-runtime.ts',
  },
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22.19',
  conditions: ['node', 'import'],
  entryNames: '[dir]/[name]',
  chunkNames: 'startup/chunks/[name]-[hash]',
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'eof',
  treeShaking: true,
  external: [
    '@napi-rs/keyring',
    '@tangle-network/agent-eval',
    '@tangle-network/agent-provider-*',
    '@tangle-network/agent-runtime',
    '@tangle-network/agent-runtime/*',
    '@tangle-network/sandbox',
    'better-sqlite3-multiple-ciphers',
    'keytar',
  ],
})

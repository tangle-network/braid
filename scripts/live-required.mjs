const scope = process.argv[2] ?? 'live'
process.stderr.write(
  `${scope} requires protected live-provider credentials and environment evidence; no live claim is made by this branch\n`,
)
process.exitCode = 2

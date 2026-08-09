const scope = process.argv[2]

if (scope !== 'live') {
  process.stderr.write(`Unknown external check scope: ${scope ?? '(missing)'}\n`)
  process.exit(1)
}

process.stderr.write(
  'Live provider checks require the published provider adapters and credentials; they are not part of the W5 coordination track.\n',
)
process.exitCode = 2

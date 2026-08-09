export function npmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function pnpmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export function portableEvidencePath(path) {
  return String(path).replaceAll('\\', '/')
}

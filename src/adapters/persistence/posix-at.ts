import koffi from 'koffi'

interface PosixAtBindings {
  readonly linkAt: (
    sourceDirectory: number,
    source: string,
    targetDirectory: number,
    target: string,
    flags: number,
  ) => number
  readonly mkdirAt: (directory: number, path: string, mode: number) => number
  readonly openAt: (
    directory: number,
    path: string,
    flags: number,
    modeType: 'unsigned int',
    mode: number,
  ) => number
  readonly renameAt: (
    sourceDirectory: number,
    source: string,
    targetDirectory: number,
    target: string,
  ) => number
  readonly unlinkAt: (directory: number, path: string, flags: number) => number
}

let cachedBindings: PosixAtBindings | undefined

function bindings(): PosixAtBindings {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    const error = new Error(
      `Descriptor-relative filesystem operations are unavailable on ${process.platform}`,
    ) as NodeJS.ErrnoException
    error.code = 'ENOSYS'
    error.syscall = 'openat'
    throw error
  }
  if (cachedBindings !== undefined) return cachedBindings

  const libc = koffi.load(null)
  cachedBindings = {
    linkAt: libc.func(
      'int linkat(int sourceDirectory, const char *source, int targetDirectory, const char *target, int flags)',
    ) as PosixAtBindings['linkAt'],
    mkdirAt: libc.func(
      'int mkdirat(int directory, const char *path, unsigned int mode)',
    ) as PosixAtBindings['mkdirAt'],
    openAt: libc.func(
      'int openat(int directory, const char *path, int flags, ...)',
    ) as PosixAtBindings['openAt'],
    renameAt: libc.func(
      'int renameat(int sourceDirectory, const char *source, int targetDirectory, const char *target)',
    ) as PosixAtBindings['renameAt'],
    unlinkAt: libc.func(
      'int unlinkat(int directory, const char *path, int flags)',
    ) as PosixAtBindings['unlinkAt'],
  }
  return cachedBindings
}

function errnoCode(errno: number): string {
  for (const [name, value] of Object.entries(koffi.os.errno)) {
    if (value === errno && name.startsWith('E')) return name
  }
  return `ERRNO_${errno}`
}

function syscallError(syscall: string, path: string): NodeJS.ErrnoException {
  const errno = koffi.errno()
  const code = errnoCode(errno)
  const error = new Error(`${code}: ${syscall} '${path}'`) as NodeJS.ErrnoException
  error.code = code
  error.errno = errno
  error.path = path
  error.syscall = syscall
  return error
}

export function openAt(directory: number, path: string, flags: number, mode = 0): number {
  const result = bindings().openAt(directory, path, flags, 'unsigned int', mode)
  if (result < 0) throw syscallError('openat', path)
  return result
}

export function mkdirAt(directory: number, path: string, mode: number): void {
  if (bindings().mkdirAt(directory, path, mode) < 0) throw syscallError('mkdirat', path)
}

export function unlinkAt(directory: number, path: string): void {
  if (bindings().unlinkAt(directory, path, 0) < 0) throw syscallError('unlinkat', path)
}

export function renameAt(
  sourceDirectory: number,
  source: string,
  targetDirectory: number,
  target: string,
): void {
  if (bindings().renameAt(sourceDirectory, source, targetDirectory, target) < 0) {
    throw syscallError('renameat', target)
  }
}

export function linkAt(
  sourceDirectory: number,
  source: string,
  targetDirectory: number,
  target: string,
): void {
  if (bindings().linkAt(sourceDirectory, source, targetDirectory, target, 0) < 0) {
    throw syscallError('linkat', target)
  }
}

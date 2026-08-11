import koffi from 'koffi'

interface PosixAtBindings {
  readonly fcntl: (
    fileDescriptor: number,
    command: number,
    pointerType: 'void *',
    value: Buffer,
  ) => number
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
    fcntl: libc.func('int fcntl(int fileDescriptor, int command, ...)') as PosixAtBindings['fcntl'],
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

const DARWIN_F_GETPATH = 50
const DARWIN_MAX_PATH_LENGTH = 1024

export function descriptorPath(fileDescriptor: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fileDescriptor}`
  if (process.platform !== 'darwin') {
    const error = new Error(
      `Descriptor paths are unavailable on ${process.platform}`,
    ) as NodeJS.ErrnoException
    error.code = 'ENOSYS'
    error.syscall = 'fcntl'
    throw error
  }

  const output = Buffer.alloc(DARWIN_MAX_PATH_LENGTH)
  const result = bindings().fcntl(fileDescriptor, DARWIN_F_GETPATH, 'void *', output)
  if (result < 0) throw syscallError('fcntl', String(fileDescriptor))
  const terminator = output.indexOf(0)
  if (terminator <= 0) {
    const error = new Error('Darwin F_GETPATH returned an invalid path') as NodeJS.ErrnoException
    error.code = 'EIO'
    error.path = String(fileDescriptor)
    error.syscall = 'fcntl'
    throw error
  }
  return output.toString('utf8', 0, terminator)
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

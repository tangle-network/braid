/** Compares UTF-16 code units without locale or platform-dependent collation. */
export function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftCode = left.charCodeAt(index)
    const rightCode = right.charCodeAt(index)
    if (leftCode !== rightCode) return leftCode - rightCode
  }
  return left.length - right.length
}

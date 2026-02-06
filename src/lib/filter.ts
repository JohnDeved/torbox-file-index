import type { ContainerEntry, FileEntry } from '../torbox'

const MAX_FILTER_LEN = 256
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })
const ALLOWED_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'])

export type SortColumn = 'N' | 'S' | 'D'
export type SortOrder = 'A' | 'D'

export interface CompiledFilter {
  regex: RegExp
  matchAll: boolean
}

export interface FileFilterResult {
  files: FileEntry[]
  totalMatched: number
}

export interface ContainerFilterResult {
  containers: ContainerEntry[]
  totalMatched: number
}

function sanitizeFlags(flags: string): string {
  const out: string[] = []
  const seen = new Set<string>()
  for (const flag of flags) {
    if (!ALLOWED_REGEX_FLAGS.has(flag)) throw new Error(`Invalid regex flag: ${flag}`)
    if (flag === 'g' || flag === 'y') continue
    if (!seen.has(flag)) {
      seen.add(flag)
      out.push(flag)
    }
  }
  return out.join('')
}

export function compileFilter(pattern: string, flags: string): CompiledFilter {
  if (pattern.length > MAX_FILTER_LEN)
    throw new Error(`Filter too long (max ${MAX_FILTER_LEN} chars)`)
  const normalizedPattern = pattern.trim() || '.*'
  const regex = new RegExp(normalizedPattern, sanitizeFlags(flags))
  const matchAll =
    normalizedPattern === '.+' || normalizedPattern === '.*' || normalizedPattern === '^.*$'
  return { regex, matchAll }
}

function sortByName(a: string, b: string, order: SortOrder): number {
  const cmp = NAME_COLLATOR.compare(a, b)
  return order === 'D' ? -cmp : cmp
}

function sortByNumber(a: number, b: number, order: SortOrder): number {
  const cmp = a - b
  return order === 'D' ? -cmp : cmp
}

export function filterAndSortFiles(
  files: FileEntry[],
  compiled: CompiledFilter,
  limit: number,
  column: SortColumn,
  order: SortOrder
): FileFilterResult {
  const matched = files.filter(file => compiled.matchAll || compiled.regex.test(file.full_name))

  matched.sort((a, b) => {
    if (column === 'S') {
      const bySize = sortByNumber(a.size, b.size, order)
      if (bySize !== 0) return bySize
    } else {
      const byName = sortByName(a.display_name, b.display_name, order)
      if (byName !== 0) return byName
    }
    return sortByNumber(a.file_id, b.file_id, order)
  })

  return {
    files: matched.slice(0, limit),
    totalMatched: matched.length,
  }
}

export function filterAndSortContainers(
  containers: ContainerEntry[],
  compiled: CompiledFilter,
  limit: number,
  column: SortColumn,
  order: SortOrder
): ContainerFilterResult {
  const matched = containers.filter(container => {
    if (compiled.matchAll) return true
    if (compiled.regex.test(container.container_name)) return true
    return container.files.some(file => compiled.regex.test(file.full_name))
  })

  matched.sort((a, b) => {
    if (column === 'S') {
      const aSize = a.files.reduce((sum, file) => sum + file.size, 0)
      const bSize = b.files.reduce((sum, file) => sum + file.size, 0)
      const bySize = sortByNumber(aSize, bSize, order)
      if (bySize !== 0) return bySize
    } else {
      const byName = sortByName(a.container_name, b.container_name, order)
      if (byName !== 0) return byName
    }
    return sortByNumber(a.container_id, b.container_id, order)
  })

  return {
    containers: matched.slice(0, limit),
    totalMatched: matched.length,
  }
}

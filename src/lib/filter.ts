import type { ContainerEntry, FileEntry } from '../torbox'

const MAX_FILTER_LEN = 256
const MAX_FILTER_TERMS = 24
const MAX_TERM_LEN = 32
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

export type SortColumn = 'N' | 'S' | 'D'
export type SortOrder = 'A' | 'D'

export interface CompiledFilter {
  matchAll: boolean
  raw: string
  terms: string[]
}

export interface FileFilterResult {
  files: FileEntry[]
  totalMatched: number
}

export interface ContainerFilterResult {
  containers: ContainerEntry[]
  totalMatched: number
}

function normalizeTerm(term: string): string {
  let value = term.trim().toLowerCase()
  if (value.startsWith('*.')) value = value.slice(1)
  if (!value.startsWith('.')) value = `.${value}`
  return value
}

function splitTerms(pattern: string): string[] {
  const terms = pattern
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean)

  if (terms.length > MAX_FILTER_TERMS) {
    throw new Error(`Too many filter terms (max ${MAX_FILTER_TERMS})`)
  }

  for (const term of terms) {
    if (term.length > MAX_TERM_LEN) {
      throw new Error(`Filter term too long: ${term.slice(0, 12)}... (max ${MAX_TERM_LEN} chars)`)
    }
  }

  return terms
}

function nameMatchesAnyTerm(name: string, terms: string[]): boolean {
  const normalized = name.toLowerCase()
  return terms.some(term => normalized.endsWith(term))
}

export function compileFilter(pattern: string, _flags: string): CompiledFilter {
  if (pattern.length > MAX_FILTER_LEN)
    throw new Error(`Filter too long (max ${MAX_FILTER_LEN} chars)`)
  const normalizedPattern = pattern.trim() || '.*'
  const matchAll =
    normalizedPattern === '.+' || normalizedPattern === '.*' || normalizedPattern === '^.*$'
  if (matchAll) return { matchAll: true, raw: normalizedPattern, terms: [] }

  const terms = splitTerms(normalizedPattern).map(normalizeTerm)
  if (terms.length === 0) return { matchAll: true, raw: normalizedPattern, terms: [] }

  return { matchAll: false, raw: normalizedPattern, terms }
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
  const matched = files.filter(file => {
    if (compiled.matchAll) return true
    return nameMatchesAnyTerm(file.full_name, compiled.terms)
  })

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
    return container.files.some(file => nameMatchesAnyTerm(file.full_name, compiled.terms))
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

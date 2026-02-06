import { renderTemplate } from './template'

const NAME_WIDTH = 96

export interface ListingEntry {
  href?: string
  name: string
  size?: number
  description?: string
}

export interface RenderListingInput {
  title: string
  entries: ListingEntry[]
  displayedCount?: number
  filter: string
  totalMatched: number
  limit: number
  errors: string[]
  sortBaseQuery: string
  summaryNoun: string
}

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '  - '
  const units = [' ', 'K', 'M', 'G', 'T', 'P']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${String(value).padStart(3)} `
  const n = value < 10 ? value.toFixed(1) : Math.round(value).toString()
  return n.padStart(3) + units[unit]
}

function fmtSizeHuman(bytes: number): string {
  return fmtSize(bytes).trim() || '0'
}

function truncateName(name: string): string {
  if (name.length <= NAME_WIDTH) return name
  return `${name.slice(0, NAME_WIDTH - 3)}..>`
}

function sortHref(baseQuery: string, column: 'N' | 'S' | 'D', order: 'A' | 'D'): string {
  return `?C=${column}&O=${order}${baseQuery ? `&${baseQuery}` : ''}`
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildWarningsHtml(warnings: string[]): string {
  if (warnings.length === 0) return ''
  return `${warnings.map(warning => `<!-- ${esc(warning)} -->`).join('\n')}\n`
}

function buildRowsHtml(entries: ListingEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries
    .map(entry => {
      const display = truncateName(entry.name)
      const pad = ' '.repeat(Math.max(1, NAME_WIDTH - display.length))
      const size = fmtSize(entry.size)
      const description = esc(entry.description || '-')
      if (entry.href) {
        return `<a href="${esc(entry.href)}">${esc(display)}</a>${pad} ${size}  ${description}`
      }
      return `${esc(display)}${pad} ${size}  ${description}`
    })
    .join('\n')}\n`
}

export function renderListing(input: RenderListingInput): string {
  const truncated = input.totalMatched > input.limit
  const totalBytes = input.entries.reduce((sum, entry) => sum + (entry.size || 0), 0)
  const displayed = input.displayedCount ?? input.entries.length

  const warnings: string[] = []
  if (input.filter !== '.+') warnings.push(`filter: ${input.filter}`)
  if (truncated)
    warnings.push(`truncated: ${input.totalMatched} matched, showing first ${displayed}`)
  if (input.errors.length > 0) warnings.push(`source errors: ${input.errors.join('; ')}`)

  let summary = `${displayed} ${input.summaryNoun}, ${fmtSizeHuman(totalBytes)} total`
  if (truncated) summary += ` (truncated from ${input.totalMatched})`
  if (input.filter !== '.+') summary += ` | filter: ${input.filter}`
  if (input.errors.length > 0) summary += ` | errors: ${input.errors.join('; ')}`

  return renderTemplate({
    title: input.title,
    warningsHtml: buildWarningsHtml(warnings),
    nameSortHref: sortHref(input.sortBaseQuery, 'N', 'D'),
    sizeSortHref: sortHref(input.sortBaseQuery, 'S', 'A'),
    descSortHref: sortHref(input.sortBaseQuery, 'D', 'A'),
    nameHeader: `Name${' '.repeat(NAME_WIDTH - 4)}`,
    rowsHtml: buildRowsHtml(input.entries),
    summary,
  })
}

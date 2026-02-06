import { renderTemplate } from './template'

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

function truncateName(name: string): string {
  return name
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildRowsHtml(entries: ListingEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries
    .map(entry => {
      const display = truncateName(entry.name)
      if (entry.href) {
        return `<a href="${esc(entry.href)}">${esc(display)}</a>`
      }
      return `${esc(display)}`
    })
    .join('\n')}\n`
}

export function renderListing(input: RenderListingInput): string {
  return renderTemplate({
    title: input.title,
    rowsHtml: buildRowsHtml(input.entries),
  })
}

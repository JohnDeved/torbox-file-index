import {
  compileFilter,
  filterAndSortContainers,
  filterAndSortFiles,
  type SortColumn,
  type SortOrder,
} from './lib/filter'
import { renderListing, type ListingEntry } from './render'
import {
  buildDownloadUrl,
  fetchContainerById,
  fetchContainersBySource,
  type Source,
} from './torbox'

const DEFAULT_FILTER = '.+'
const DEFAULT_FLAGS = 'i'
const DEFAULT_LIMIT = 2000
const LOCAL_IPS = new Set(['::1', '127.0.0.1', '0.0.0.0'])
const SOURCES: Source[] = ['torrents', 'webdl', 'usenet']
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS_PER_IP = 240
const RATE_LIMIT_MAX_REQUESTS_PER_IP_KEY = 240
const RATE_LIMIT_MAX_UNIQUE_KEYS_PER_IP = 3
const RATE_LIMIT_STATE_SOFT_MAX = 10_000
const ipRateLimitState = new Map<string, { count: number; resetAt: number }>()
const keyRateLimitState = new Map<string, { count: number; resetAt: number }>()
const keyChurnState = new Map<string, { keys: Set<string>; resetAt: number }>()

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store, no-transform',
  'X-Robots-Tag': 'noindex, nofollow',
}

function normalizeFilterValue(raw: string): string {
  return raw.includes('.nsz') && !raw.includes('.nsp') ? `${raw},.nsp` : raw
}

function textResponse(status: number, msg: string): Response {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store, no-transform' },
  })
}

function getUserIp(request: Request): string | undefined {
  const raw = request.headers.get('cf-connecting-ip') || ''
  const first = raw.split(',')[0]?.trim()
  if (!first || LOCAL_IPS.has(first)) return undefined
  return first
}

function pruneCounterMap(map: Map<string, { count: number; resetAt: number }>, now: number): void {
  if (map.size <= RATE_LIMIT_STATE_SOFT_MAX) return
  for (const [key, value] of map) {
    if (now >= value.resetAt) map.delete(key)
  }
}

function pruneKeyChurnMap(now: number): void {
  if (keyChurnState.size <= RATE_LIMIT_STATE_SOFT_MAX) return
  for (const [key, value] of keyChurnState) {
    if (now >= value.resetAt) keyChurnState.delete(key)
  }
}

function consumeRateLimit(
  map: Map<string, { count: number; resetAt: number }>,
  bucket: string,
  maxRequests: number,
  now: number
): boolean {
  pruneCounterMap(map, now)
  const current = map.get(bucket)
  if (!current || now >= current.resetAt) {
    map.set(bucket, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  current.count += 1
  return current.count > maxRequests
}

function consumeKeyChurnLimit(ipBucket: string, keyValue: string, now: number): boolean {
  pruneKeyChurnMap(now)
  const current = keyChurnState.get(ipBucket)
  if (!current || now >= current.resetAt) {
    keyChurnState.set(ipBucket, {
      keys: new Set([keyValue]),
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    })
    return false
  }

  current.keys.add(keyValue)
  return current.keys.size > RATE_LIMIT_MAX_UNIQUE_KEYS_PER_IP
}

function isRateLimited(ip: string | undefined, key: string): boolean {
  const now = Date.now()
  const ipBucket = ip || 'unknown'
  const ipKeyBucket = `${ipBucket}|${key}`
  if (consumeRateLimit(ipRateLimitState, ipBucket, RATE_LIMIT_MAX_REQUESTS_PER_IP, now)) return true
  if (consumeRateLimit(keyRateLimitState, ipKeyBucket, RATE_LIMIT_MAX_REQUESTS_PER_IP_KEY, now))
    return true
  if (consumeKeyChurnLimit(ipBucket, key, now)) return true
  return false
}

interface Query {
  key: string
  filter: string
  flags: string
  limit: number
  sortC: SortColumn
  sortO: SortOrder
}

function parseQuery(): Query {
  return {
    key: '',
    filter: DEFAULT_FILTER,
    flags: DEFAULT_FLAGS,
    limit: DEFAULT_LIMIT,
    sortC: 'N',
    sortO: 'A',
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean)
}

function hasKeyInPath(pathname: string): boolean {
  const parts = splitPath(pathname)
  if (parts.length === 0) return false
  const first = parts[0] as Source
  return !SOURCES.includes(first)
}

type ParsedRoute =
  | { source?: Source; containerId?: number }
  | { download: true; source: Source; containerId: number; fileId: number }

const SOURCE_SHORT: Record<Source, 't' | 'w' | 'u'> = {
  torrents: 't',
  webdl: 'w',
  usenet: 'u',
}

const SHORT_SOURCE: Record<string, Source> = {
  t: 'torrents',
  w: 'webdl',
  u: 'usenet',
}

function splitFilterAndRouteParts(parts: string[]): { filter?: string; routeParts: string[] } {
  if (parts.length === 0) return { routeParts: parts }
  const first = parts[0] || ''
  if (first === 'f' || SOURCES.includes(first as Source) || /^([twu])-\d+$/.test(first)) {
    return { routeParts: parts }
  }
  if (!first.startsWith('.')) return { routeParts: parts }
  return { filter: normalizeFilterValue(decodeURIComponent(first)), routeParts: parts.slice(1) }
}

function parseContainerSlug(slug: string): { source: Source; containerId: number } | null {
  const m = /^([twu])-(\d+)$/.exec(slug)
  if (!m) return null
  const source = SHORT_SOURCE[m[1] || '']
  const containerId = Number.parseInt(m[2] || '', 10)
  if (!source || !Number.isInteger(containerId) || containerId < 1) return null
  return { source, containerId }
}

function parsePath(pathname: string, keyInPath: boolean): ParsedRoute | Response {
  const fullParts = splitPath(pathname)
  const pathParts = keyInPath ? fullParts.slice(1) : fullParts
  const parts = keyInPath ? splitFilterAndRouteParts(pathParts).routeParts : pathParts
  if (parts.length === 0) return {}

  if (parts[0] === 'f') {
    if (parts.length !== 4) return textResponse(404, 'Not found')
    const source = parts[1] as Source
    if (!SOURCES.includes(source)) return textResponse(404, 'Not found')
    const containerId = Number.parseInt(parts[2], 10)
    const idPart = parts[3] || ''
    const fileId = Number.parseInt(idPart.split('.', 1)[0] || '', 10)
    if (!Number.isInteger(containerId) || containerId < 1) return textResponse(404, 'Not found')
    if (!Number.isInteger(fileId) || fileId < 0) return textResponse(404, 'Not found')
    return { download: true, source, containerId, fileId }
  }

  const slugRoute = parseContainerSlug(parts[0] || '')
  if (slugRoute) {
    if (parts.length === 1) return slugRoute
    if (parts.length === 2) {
      const idPart = parts[1] || ''
      const fileId = Number.parseInt(idPart.split('.', 1)[0] || '', 10)
      if (!Number.isInteger(fileId) || fileId < 0) return textResponse(404, 'Not found')
      return { download: true, source: slugRoute.source, containerId: slugRoute.containerId, fileId }
    }
    return textResponse(404, 'Not found')
  }

  const source = parts[0] as Source
  if (!SOURCES.includes(source)) return textResponse(404, 'Not found')

  if (parts.length === 1) return { source }

  const containerId = Number.parseInt(parts[1], 10)
  if (!Number.isInteger(containerId) || containerId < 1) return textResponse(404, 'Not found')

  if (parts.length === 2) return { source, containerId }

  if (parts.length === 3) {
    const idPart = parts[2] || ''
    const fileId = Number.parseInt(idPart.split('.', 1)[0] || '', 10)
    if (!Number.isInteger(fileId) || fileId < 0) return textResponse(404, 'Not found')
    return { download: true, source, containerId, fileId }
  }

  return textResponse(404, 'Not found')
}

function parentEntry(parentPath: string): ListingEntry {
  return {
    href: parentPath,
    name: '../',
    size: undefined,
    description: 'parent directory',
  }
}

function fileRouteHref(fileId: number, name: string): string {
  const m = /\.([A-Za-z0-9]{2,8})$/.exec(name)
  const ext = m ? `.${m[1].toLowerCase()}` : ''
  return `${fileId}${ext}`
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'private, no-store, no-transform',
          Allow: 'GET, HEAD',
        },
      })
    }

    const query = parseQuery()

    const url = new URL(request.url)
    const keyInPath = hasKeyInPath(url.pathname)
    const routeParts = splitPath(url.pathname)
    const keyFromPath = keyInPath ? decodeURIComponent(routeParts[0] || '') : ''
    const tailParts = keyInPath ? routeParts.slice(1) : routeParts
    const { filter: pathFilter } = keyInPath
      ? splitFilterAndRouteParts(tailParts)
      : { filter: undefined as string | undefined }

    if (keyInPath && !url.pathname.endsWith('/')) {
      const { routeParts: routeOnly } = splitFilterAndRouteParts(tailParts)
      if (routeOnly[0] !== 'f') {
        return Response.redirect(`${url.origin}${url.pathname}/`, 302)
      }
    }

    const key = query.key || keyFromPath
    if (!key) return textResponse(400, 'Missing required parameter: key')

    const userIp = getUserIp(request)
    if (isRateLimited(userIp, key)) return textResponse(429, 'Too many requests')

    const route = parsePath(url.pathname, keyInPath)
    if (route instanceof Response) return route

    if ('download' in route) {
      const redirectUrl = buildDownloadUrl(route.source, key, route.containerId, route.fileId)
      return Response.redirect(redirectUrl, 302)
    }

    const effectiveFilter = pathFilter || query.filter

    let compiledFilter
    try {
      compiledFilter = compileFilter(effectiveFilter, query.flags)
    } catch (error) {
      return textResponse(
        400,
        `Invalid filter: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const sortBaseQuery = ''

    if (!route.source) {
      const settled = await Promise.allSettled(
        SOURCES.map(source => fetchContainersBySource(source, key))
      )
      const allContainers = [] as Awaited<ReturnType<typeof fetchContainersBySource>>
      const errors: string[] = []

      settled.forEach((result, idx) => {
        if (result.status === 'fulfilled') {
          allContainers.push(...result.value)
          return
        }
        errors.push(`${SOURCES[idx]}: unavailable`)
      })

      if (allContainers.length === 0 && errors.length > 0) {
        return textResponse(502, 'Upstream provider unavailable')
      }

      const { containers: filtered, totalMatched } = filterAndSortContainers(
        allContainers,
        compiledFilter,
        query.limit,
        query.sortC as SortColumn,
        query.sortO as SortOrder
      )
      const entries: ListingEntry[] = filtered.map(container => ({
        href: `${SOURCE_SHORT[container.source]}-${container.container_id}/`,
        name: `${container.container_name}/`,
        size: container.files.reduce((sum, file) => sum + file.size, 0),
        description: `${container.source} | ${container.files.length} file(s)`,
      }))

      const html = renderListing({
        title: 'Index of /',
        entries,
        displayedCount: filtered.length,
        filter: effectiveFilter,
        totalMatched,
        limit: query.limit,
        errors,
        sortBaseQuery,
        summaryNoun: 'folder(s)',
      })
      return new Response(html, { status: 200, headers: HEADERS })
    }

    if (!route.containerId) {
      let containers
      try {
        containers = await fetchContainersBySource(route.source, key)
      } catch {
        return textResponse(502, 'Upstream provider unavailable')
      }

      const { containers: filtered, totalMatched } = filterAndSortContainers(
        containers,
        compiledFilter,
        query.limit,
        query.sortC as SortColumn,
        query.sortO as SortOrder
      )
      const entries: ListingEntry[] = [
        parentEntry('../'),
        ...filtered.map(container => ({
          href: `${container.container_id}/`,
          name: `${container.container_name}/`,
          size: container.files.reduce((sum, file) => sum + file.size, 0),
          description: `${container.files.length} file(s)`,
        })),
      ]

      const html = renderListing({
        title: `Index of /${route.source}/`,
        entries,
        displayedCount: filtered.length,
        filter: effectiveFilter,
        totalMatched,
        limit: query.limit,
        errors: [],
        sortBaseQuery,
        summaryNoun: 'folder(s)',
      })
      return new Response(html, { status: 200, headers: HEADERS })
    }

    let container
    try {
      container = await fetchContainerById(
        route.source,
        key,
        route.containerId
      )
    } catch {
      return textResponse(502, 'Upstream provider unavailable')
    }

    if (!container) return textResponse(404, 'Container not found')

    const { files, totalMatched } = filterAndSortFiles(
      container.files,
      compiledFilter,
      query.limit,
      query.sortC as SortColumn,
      query.sortO as SortOrder
    )

    const entries: ListingEntry[] = [
      parentEntry('../'),
      ...files.map(file => ({
        href: fileRouteHref(file.file_id, file.display_name),
        name: file.display_name,
        size: file.size,
        description: 'file',
      })),
    ]

    const html = renderListing({
      title: `Index of /${route.source}/${container.container_id}/`,
      entries,
      displayedCount: files.length,
      filter: effectiveFilter,
      totalMatched,
      limit: query.limit,
      errors: [],
      sortBaseQuery,
      summaryNoun: 'file(s)',
    })

    return new Response(html, { status: 200, headers: HEADERS })
  },
} satisfies ExportedHandler

import * as v from 'valibot'
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
const MAX_LIMIT = 10000
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
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
}

const QuerySchema = v.object({
  key: v.pipe(v.string(), v.minLength(1, 'Missing required parameter: key')),
  filter: v.string(),
  flags: v.string(),
  limit: v.pipe(
    v.string(),
    v.transform(Number),
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_LIMIT)
  ),
  sortC: v.picklist(['N', 'S', 'D']),
  sortO: v.picklist(['A', 'D']),
})

type Query = v.InferOutput<typeof QuerySchema>

function textResponse(status: number, msg: string): Response {
  return new Response(msg, {
    status,
    headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'private, no-store' },
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

function parseQuery(request: Request): Query | Response {
  const params = new URL(request.url).searchParams
  const parsed = v.safeParse(QuerySchema, {
    key: params.get('key') ?? '',
    filter: params.get('filter') ?? DEFAULT_FILTER,
    flags: params.get('flags') ?? DEFAULT_FLAGS,
    limit: params.get('limit') ?? String(DEFAULT_LIMIT),
    sortC: (params.get('C') ?? 'N').toUpperCase(),
    sortO: (params.get('O') ?? 'A').toUpperCase(),
  })

  if (!parsed.success) {
    const firstIssue = parsed.issues[0]?.message ?? `Invalid limit (1-${MAX_LIMIT})`
    return textResponse(400, firstIssue)
  }

  return parsed.output
}

function buildBaseQuery(query: Query): URLSearchParams {
  const params = new URLSearchParams()
  params.set('key', query.key)
  if (query.filter !== DEFAULT_FILTER) params.set('filter', query.filter)
  if (query.flags !== DEFAULT_FLAGS) params.set('flags', query.flags)
  if (query.limit !== DEFAULT_LIMIT) params.set('limit', String(query.limit))
  return params
}

function withPath(path: string, queryString: string): string {
  return queryString ? `${path}?${queryString}` : path
}

function parsePath(pathname: string): { source?: Source; containerId?: number } | Response {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return {}

  const source = parts[0] as Source
  if (!SOURCES.includes(source)) return textResponse(404, 'Not found')

  if (parts.length === 1) return { source }

  const containerId = Number.parseInt(parts[1], 10)
  if (!Number.isInteger(containerId) || containerId < 1) return textResponse(404, 'Not found')

  if (parts.length > 2) return textResponse(404, 'Not found')

  return { source, containerId }
}

function parentEntry(parentPath: string, baseQuery: URLSearchParams): ListingEntry {
  return {
    href: withPath(parentPath, baseQuery.toString()),
    name: '../',
    size: undefined,
    description: 'parent directory',
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'private, no-store',
          Allow: 'GET, HEAD',
        },
      })
    }

    const query = parseQuery(request)
    if (query instanceof Response) return query

    const userIp = getUserIp(request)
    if (isRateLimited(userIp, query.key)) return textResponse(429, 'Too many requests')

    const route = parsePath(new URL(request.url).pathname)
    if (route instanceof Response) return route

    let compiledFilter
    try {
      compiledFilter = compileFilter(query.filter, query.flags)
    } catch (error) {
      return textResponse(
        400,
        `Invalid filter: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const baseQuery = buildBaseQuery(query)
    const sortBaseQuery = baseQuery.toString()

    if (!route.source) {
      const settled = await Promise.allSettled(
        SOURCES.map(source => fetchContainersBySource(source, query.key))
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
        href: withPath(`/${container.source}/${container.container_id}/`, baseQuery.toString()),
        name: `${container.container_name}/`,
        size: container.files.reduce((sum, file) => sum + file.size, 0),
        description: `${container.source} | ${container.files.length} file(s)`,
      }))

      const html = renderListing({
        title: 'Index of /',
        entries,
        displayedCount: filtered.length,
        filter: query.filter,
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
        containers = await fetchContainersBySource(route.source, query.key)
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
        parentEntry('/', baseQuery),
        ...filtered.map(container => ({
          href: withPath(`/${route.source}/${container.container_id}/`, baseQuery.toString()),
          name: `${container.container_name}/`,
          size: container.files.reduce((sum, file) => sum + file.size, 0),
          description: `${container.files.length} file(s)`,
        })),
      ]

      const html = renderListing({
        title: `Index of /${route.source}/`,
        entries,
        displayedCount: filtered.length,
        filter: query.filter,
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
        query.key,
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
      parentEntry('/', baseQuery),
      ...files.map(file => ({
        href: buildDownloadUrl(
          file.source,
          query.key,
          file.container_id,
          file.file_id
        ),
        name: file.display_name,
        size: file.size,
        description: 'file',
      })),
    ]

    const html = renderListing({
      title: `Index of /${route.source}/${container.container_id}/`,
      entries,
      displayedCount: files.length,
      filter: query.filter,
      totalMatched,
      limit: query.limit,
      errors: [],
      sortBaseQuery,
      summaryNoun: 'file(s)',
    })

    return new Response(html, { status: 200, headers: HEADERS })
  },
} satisfies ExportedHandler

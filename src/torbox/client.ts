import pRetry, { AbortError } from 'p-retry'
import type { ContainerEntry, Source, TorBoxItem, TorBoxResponse } from './types'

const API = 'https://api.torbox.app/v1/api'
const LIST_PAGE_SIZE = 1000
const FETCH_TIMEOUT_MS = 12000
const LIST_CACHE_TTL_MS = 15_000
const CACHE_SOFT_MAX = 2000

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const sourceListCache = new Map<string, CacheEntry<ContainerEntry[]>>()
const containerByIdCache = new Map<string, CacheEntry<ContainerEntry | null>>()

const SOURCE_CONFIG: Record<Source, { listPath: string; dlPath: string; idParam: string }> = {
  torrents: { listPath: 'torrents/mylist', dlPath: 'torrents/requestdl', idParam: 'torrent_id' },
  webdl: { listPath: 'webdl/mylist', dlPath: 'webdl/requestdl', idParam: 'web_id' },
  usenet: { listPath: 'usenet/mylist', dlPath: 'usenet/requestdl', idParam: 'usenet_id' },
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

export function buildDownloadUrl(
  source: Source,
  key: string,
  containerId: number,
  fileId: number
): string {
  const cfg = SOURCE_CONFIG[source]
  const params = new URLSearchParams({
    token: key,
    [cfg.idParam]: String(containerId),
    file_id: String(fileId),
    redirect: 'true',
  })
  return `${API}/${cfg.dlPath}?${params}`
}

function retryableStatus(status: number): boolean {
  return status >= 500
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key)
  if (!hit) return undefined
  if (Date.now() >= hit.expiresAt) {
    map.delete(key)
    return undefined
  }
  return hit.value
}

function trimCache<T>(map: Map<string, CacheEntry<T>>): void {
  if (map.size <= CACHE_SOFT_MAX) return
  const now = Date.now()
  for (const [key, value] of map) {
    if (now >= value.expiresAt) map.delete(key)
  }
  if (map.size <= CACHE_SOFT_MAX) return
  const overflow = map.size - CACHE_SOFT_MAX
  let removed = 0
  for (const key of map.keys()) {
    map.delete(key)
    removed += 1
    if (removed >= overflow) break
  }
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  trimCache(map)
  map.set(key, { value, expiresAt: Date.now() + LIST_CACHE_TTL_MS })
}

async function fetchJson(url: string, key: string): Promise<TorBoxResponse> {
  return pRetry(
    async () => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        const message = `HTTP ${response.status}`
        if (!retryableStatus(response.status)) throw new AbortError(message)
        throw new Error(message)
      }
      return (await response.json()) as TorBoxResponse
    },
    { retries: 2, factor: 2, minTimeout: 150, maxTimeout: 1000, randomize: true }
  )
}

function toItems(data: TorBoxResponse['data']): TorBoxItem[] {
  if (!data) return []
  return Array.isArray(data) ? data : [data]
}

function normalizeContainer(source: Source, item: TorBoxItem): ContainerEntry {
  return {
    source,
    container_id: item.id,
    container_name: item.name || `${source}-${item.id}`,
    files:
      item.files?.map(file => {
        const fullName = file.name || file.short_name || ''
        return {
          source,
          container_id: item.id,
          file_id: file.id,
          full_name: fullName,
          display_name: file.short_name || basename(fullName),
          size: file.size || 0,
        }
      }) || [],
  }
}

export async function fetchContainersBySource(
  source: Source,
  key: string
): Promise<ContainerEntry[]> {
  const cacheKey = `${source}:${key}`
  const cached = cacheGet(sourceListCache, cacheKey)
  if (cached) return cached

  const cfg = SOURCE_CONFIG[source]
  const containers: ContainerEntry[] = []

  let offset = 0
  while (true) {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(LIST_PAGE_SIZE),
    })
    const body = await fetchJson(`${API}/${cfg.listPath}?${params}`, key)
    if (!body.success) throw new Error(`${source}: ${body.detail || body.error || 'unknown error'}`)

    const items = toItems(body.data)
    for (const item of items) {
      if (item.download_present === false || !item.files?.length) continue
      containers.push(normalizeContainer(source, item))
    }

    if (items.length < LIST_PAGE_SIZE) break
    offset += LIST_PAGE_SIZE
  }

  cacheSet(sourceListCache, cacheKey, containers)
  return containers
}

export async function fetchContainerById(
  source: Source,
  key: string,
  containerId: number
): Promise<ContainerEntry | null> {
  const cacheKey = `${source}:${containerId}:${key}`
  const cached = cacheGet(containerByIdCache, cacheKey)
  if (cached !== undefined) return cached

  const cfg = SOURCE_CONFIG[source]
  const params = new URLSearchParams({
    id: String(containerId),
    limit: String(LIST_PAGE_SIZE),
  })
  const body = await fetchJson(`${API}/${cfg.listPath}?${params}`, key)
  if (!body.success) throw new Error(`${source}: ${body.detail || body.error || 'unknown error'}`)

  const item = toItems(body.data).find(x => x.id === containerId && x.download_present !== false)
  if (!item || !item.files?.length) {
    cacheSet(containerByIdCache, cacheKey, null)
    return null
  }

  const normalized = normalizeContainer(source, item)
  cacheSet(containerByIdCache, cacheKey, normalized)
  return normalized
}

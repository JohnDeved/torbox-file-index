import pRetry, { AbortError } from 'p-retry'
import type { ContainerEntry, Source, TorBoxItem, TorBoxResponse } from './types'

const API = 'https://api.torbox.app/v1/api'
const LIST_PAGE_SIZE = 1000
const FETCH_TIMEOUT_MS = 12000

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
  fileId: number,
  userIp?: string
): string {
  const cfg = SOURCE_CONFIG[source]
  const params = new URLSearchParams({
    token: key,
    [cfg.idParam]: String(containerId),
    file_id: String(fileId),
    redirect: 'true',
  })
  if (userIp) params.set('user_ip', userIp)
  return `${API}/${cfg.dlPath}?${params}`
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500
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
  key: string,
  bypassCache: boolean
): Promise<ContainerEntry[]> {
  const cfg = SOURCE_CONFIG[source]
  const containers: ContainerEntry[] = []

  let offset = 0
  while (true) {
    const params = new URLSearchParams({
      bypass_cache: String(bypassCache),
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

  return containers
}

export async function fetchContainerById(
  source: Source,
  key: string,
  bypassCache: boolean,
  containerId: number
): Promise<ContainerEntry | null> {
  const cfg = SOURCE_CONFIG[source]
  const params = new URLSearchParams({
    id: String(containerId),
    bypass_cache: String(bypassCache),
    limit: String(LIST_PAGE_SIZE),
  })
  const body = await fetchJson(`${API}/${cfg.listPath}?${params}`, key)
  if (!body.success) throw new Error(`${source}: ${body.detail || body.error || 'unknown error'}`)

  const item = toItems(body.data).find(x => x.id === containerId && x.download_present !== false)
  if (!item || !item.files?.length) return null
  return normalizeContainer(source, item)
}

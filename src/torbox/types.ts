export type Source = 'torrents' | 'webdl' | 'usenet'

export interface FileEntry {
  source: Source
  container_id: number
  file_id: number
  full_name: string
  display_name: string
  size: number
}

export interface TorBoxFile {
  id: number
  name: string
  short_name?: string
  size: number
}

export interface TorBoxItem {
  id: number
  name?: string
  files: TorBoxFile[]
  download_present?: boolean
}

export interface ContainerEntry {
  source: Source
  container_id: number
  container_name: string
  files: FileEntry[]
}

export interface TorBoxResponse {
  success: boolean
  error: string | null
  detail: string
  data: TorBoxItem[] | TorBoxItem | null
}

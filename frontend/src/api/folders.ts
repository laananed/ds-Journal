import type { Folder } from '../types/folder'
import type { ContentFile, FilePage } from '../types/file'

/** Folder 请求错误。`status === 409` 表示仍有文件引用（含回收箱记录），删除被拒绝。 */
export class FolderApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'FolderApiError'
    this.status = status
  }
}

/**
 * 解析后端根地址。
 *
 * 与 `api/journals.ts` 的 `getApiBaseUrl()` 保持同一口径：
 * 读取 `VITE_API_BASE_URL`，未配置时回退 `http://127.0.0.1:8000`，
 * 去掉末尾斜杠。这里刻意保留一份小函数，避免跨模块改动已验收的文件。
 */
function getApiBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured : 'http://127.0.0.1:8000'
  return raw.trim().replace(/\/+$/, '')
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `请求失败（HTTP ${response.status}）`
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('detail' in body)) return fallback
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0]
      if (typeof first === 'object' && first !== null && 'msg' in first) {
        const message = (first as { msg: unknown }).msg
        if (typeof message === 'string') return `请求内容不合法：${message}`
      }
    }
  } catch { /* 非 JSON 响应使用 HTTP 兜底消息。 */ }
  return fallback
}

/** Folder 列表是数组契约（id ASC），不是内容文件分页。 */
export async function listFolders(signal?: AbortSignal): Promise<Folder[]> {
  const response = await fetch(`${getApiBaseUrl()}/api/folders`, { signal })
  if (!response.ok) {
    throw new FolderApiError(response.status, `获取 Folder 列表失败（HTTP ${response.status}）`)
  }
  return await response.json() as Folder[]
}

export async function createFolder(name: string): Promise<Folder> {
  const response = await fetch(`${getApiBaseUrl()}/api/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw new FolderApiError(response.status, await readErrorMessage(response))
  return await response.json() as Folder
}

/** name 可省略；页面只在真实改名时提交 name，空更新不发请求。 */
export async function updateFolder(id: number, payload: { name?: string }): Promise<Folder> {
  const response = await fetch(`${getApiBaseUrl()}/api/folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new FolderApiError(response.status, await readErrorMessage(response))
  return await response.json() as Folder
}

/** 真空删除返回 204 空体，不能解析 JSON；409 = 仍有引用（含回收箱）。 */
export async function deleteFolder(id: number): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/folders/${id}`, { method: 'DELETE' })
  if (!response.ok) throw new FolderApiError(response.status, await readErrorMessage(response))
}

/** 三类有效文件的混合分页；Folder 不存在返回 404。 */
export async function listFolderFiles(
  folderId: number,
  page = 1,
  signal?: AbortSignal,
): Promise<FilePage<ContentFile>> {
  const url = new URL(`${getApiBaseUrl()}/api/folders/${folderId}/files`)
  url.searchParams.set('page', String(page))
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new FolderApiError(response.status, `获取 Folder 内容失败（HTTP ${response.status}）`)
  }
  return await response.json() as FilePage<ContentFile>
}

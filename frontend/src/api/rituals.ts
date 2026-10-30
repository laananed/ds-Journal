import type { BusinessDay, Rituals, RitualTemplates } from '../types/ritual'
import type { RitualCopyRequest, RitualKind, RitualMutation, RitualQuestion, RitualRestoreRequest } from '../types/ritual'
import { JournalApiError } from './journals'

function apiBase(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  return (typeof configured === 'string' && configured.trim() ? configured.trim() : 'http://127.0.0.1:8000').replace(/\/+$/, '')
}
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { signal })
  if (!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`)
  return await response.json() as T
}
export function getBusinessDay(signal?: AbortSignal): Promise<BusinessDay> {
  return read('/api/business-day', signal)
}
export function getRituals(day: string, signal?: AbortSignal): Promise<Rituals> {
  return read(`/api/rituals?journal_date=${encodeURIComponent(day)}`, signal)
}
export function getRitualTemplates(signal?: AbortSignal): Promise<RitualTemplates> {
  return read('/api/ritual-templates', signal)
}

async function write<T>(path: string, method: 'POST' | 'PATCH', payload: unknown, revision?: number): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (revision !== undefined) headers['If-Match'] = `"${revision}"`
  const response = await fetch(`${apiBase()}${path}`, { method, headers, body: JSON.stringify(payload) })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined
    throw new JournalApiError(response.status, `请求失败（HTTP ${response.status}）`, code)
  }
  return await response.json() as T
}

export function updateRitualTemplate(kind: RitualKind, expected_revision: number, questions: RitualQuestion[]): Promise<RitualTemplates['set']> {
  return write(`/api/ritual-templates/${kind}`, 'PATCH', { expected_revision, questions })
}
export function restoreRitualReplace(sourceId: number, sourceRevision: number, payload: RitualRestoreRequest): Promise<RitualMutation> {
  return write(`/api/rituals/${sourceId}/restore-replace`, 'POST', payload, sourceRevision)
}
export function copyRitualContent(sourceId: number, payload: RitualCopyRequest): Promise<RitualMutation> {
  return write(`/api/rituals/${sourceId}/copy-content`, 'POST', payload)
}

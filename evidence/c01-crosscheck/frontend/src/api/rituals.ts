import type { BusinessDay, Rituals, RitualTemplates } from '../types/ritual'

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

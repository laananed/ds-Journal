/**
 * 第二轮 UI（沉浸式编辑 + 清单）证据装置：合成 API 应答。
 *
 * 只在 CDP `Fetch` 域拦截 `127.0.0.1:8000/api/*`，不启动后端、不连数据库、
 * 不调用任何模型、不产生真实写入。所有正文都是合成数据。
 */

export const BUSINESS_DATE = '2026-11-02'

const doc = (text, id = '11111111-1111-4111-8111-111111111111') => ({
  type: 'doc',
  content: [{
    type: 'paragraph',
    attrs: { id },
    content: text === '' ? [] : [{ type: 'text', text }],
  }],
})

export function emptyDocument() {
  return { type: 'doc', content: [{ type: 'paragraph', attrs: { id: '22222222-2222-4222-8222-222222222222' } }] }
}

export function journal(id, kind, title, body, date = BUSINESS_DATE, revision = 3) {
  return {
    type: 'journal', id, title, display_title: title === '' ? `${kind} ${date}` : title,
    content: body, revision, folder_id: null,
    created_at: `${date}T23:10:00.000000+08:00`,
    updated_at: `${date}T23:20:00.000000+08:00`,
    deleted_at: null, journal_date: date, journal_kind: kind,
    content_doc: doc(body), document_schema_version: 1, document_format: 'tiptap',
  }
}

export const businessDay = {
  timezone: 'Asia/Shanghai',
  day_start_hour: 4,
  server_time: '2026-11-02T12:30:00.123456+08:00',
  business_date: BUSINESS_DATE,
}

const emptyPage = { items: [], page: 1, page_size: 20, total: 0, has_next: false }

export function textOf(node) {
  if (node === null || typeof node !== 'object') return ''
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(textOf).join('')
}

/** 场景可变世界；由 harness 在加载页面前替换。 */
export const world = { set: null, end: null, writing: [] }
export const write = { mode: 'ok' } // 'ok' | 'fail500' | 'hold'
export const held = []
export const apiLog = []

const aiSettings = {
  custom_prompt: '', web_enabled: false, revision: 1, model: 'mock-model',
  model_configured: false, search_configured: false, effective_web_enabled: false,
  auto_go_deeper: false, auto_minds_comments: false, mind_preset_ids: [],
}

export function resolveApi(url, method, postData) {
  const path = new URL(url).pathname
  if (method === 'OPTIONS') return [204, null]

  if (method === 'POST' && path === '/api/journals') {
    let body = {}
    try { body = JSON.parse(postData ?? '{}') } catch { body = {} }
    const draft = body?.draft ?? {}
    const created = journal(501, draft?.journal_kind ?? 'writing', draft?.title ?? '',
      textOf(draft?.content_doc), draft?.journal_date ?? BUSINESS_DATE, 1)
    created.content_doc = draft?.content_doc ?? emptyDocument()
    world.writing = [created, ...world.writing]
    return [201, created]
  }
  if (method === 'PATCH' && path.startsWith('/api/journals/')) {
    let body = {}
    try { body = JSON.parse(postData ?? '{}') } catch { body = {} }
    const id = Number(path.split('/').pop())
    const existing = world.writing.find((item) => item.id === id)
    const base = existing ?? journal(id, 'writing', '', '', BUSINESS_DATE, 1)
    const draft = body?.draft ?? {}
    return [200, {
      ...base,
      title: draft?.title ?? base.title,
      content: textOf(draft?.content_doc ?? base.content_doc),
      content_doc: draft?.content_doc ?? base.content_doc,
      revision: base.revision + 1,
    }]
  }
  if (method !== 'GET') return [200, {}]

  if (path === '/api/business-day') return [200, businessDay]
  if (path === '/api/rituals') return [200, { journal_date: BUSINESS_DATE, set: world.set, end: world.end }]
  if (path === '/api/ritual-templates') {
    return [200, { set: { questions: [], revision: 1 }, end: { questions: [], revision: 1 } }]
  }
  if (path === '/api/journals') {
    const items = world.writing
    return [200, { items, page: 1, page_size: 20, total: items.length, has_next: false }]
  }
  if (path.startsWith('/api/journals/')) {
    const id = Number(path.split('/').pop())
    const found = world.writing.find((item) => item.id === id) ?? [world.set, world.end].find((item) => item?.id === id)
    return found ? [200, found] : [404, { detail: 'not found' }]
  }
  if (path === '/api/ai/settings') return [200, aiSettings]
  if (path === '/api/trash') return [200, emptyPage]
  if (path === '/api/search') return [200, emptyPage]
  if (path === '/api/folders') return [200, []]
  if (path === '/api/insights') return [200, emptyPage]
  return [200, emptyPage]
}

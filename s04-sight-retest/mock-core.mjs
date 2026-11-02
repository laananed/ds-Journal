const now = '2026-10-31T02:00:00Z'
const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const docText = (d) => {
  let out = ''
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'text' && typeof n.text === 'string') out += n.text
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(d)
  return out
}

function freshState() {
  return {
    schedules: [
      { id: 1, title: '与导师讨论提纲', starts_at: '2026-11-01T06:00:00Z', ends_at: null, completed: false, revision: 1, created_at: now, updated_at: now },
      { id: 2, title: '跑步', starts_at: '2026-11-02T00:00:00Z', ends_at: null, completed: true, revision: 3, created_at: now, updated_at: now },
    ],
    nextScheduleId: 10,
    insights: [
      { type: 'insight', id: 100, title: '已有洞察', display_title: '已有洞察', content: '参见 [[目标条目]]', revision: 2, folder_id: null, created_at: now, updated_at: now, deleted_at: null, content_doc: doc('参见 [[目标条目]]'), document_schema_version: 1, document_format: 'tiptap' },
    ],
    nextInsightId: 200,
    journals: [
      { type: 'journal', id: 300, title: '目标条目', display_title: '目标条目', content: '这是一条目标记录', revision: 1, folder_id: null, created_at: now, updated_at: now, deleted_at: null, journal_date: '2026-10-30', journal_kind: 'writing' },
    ],
    folders: [{ id: 1, name: '研究' }],
    fault: {},
    requests: [],
  }
}

function pageOf(items, page, pageSize = 20) {
  return { items, page, page_size: pageSize, total: items.length, has_next: items.length > page * pageSize }
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) })
}

async function installMock(pageRef, state) {
  await pageRef.route('**/api/**', async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const path = url.pathname
    const entry = { method, path, search: url.search, body: null }
    if (method !== 'GET') {
      try { entry.body = JSON.parse(request.postData() ?? 'null') } catch { entry.body = request.postData() }
    }
    entry.ifMatch = request.headers()['if-match'] ?? null
    state.requests.push(entry)
    const f = state.fault
    const fail = (key) => f[key] === true
    const abort = (key) => f[key] === 'network'

    // ---------- 基础读取 ----------
    if (path === '/api/business-day') {
      return json(route, 200, { timezone: 'Asia/Shanghai', day_start_hour: 4, server_time: now, business_date: '2026-10-31' })
    }
    if (path === '/api/rituals') {
      return json(route, 200, { journal_date: url.searchParams.get('journal_date') ?? '', set: null, end: null })
    }
    if (path === '/api/folders') return json(route, 200, state.folders)

    if (path === '/api/journals') {
      const date = url.searchParams.get('journal_date')
      const items = date ? state.journals.filter((j) => j.journal_date === date) : state.journals
      return json(route, 200, pageOf(items, Number(url.searchParams.get('page') ?? 1)))
    }
    if (/^\/api\/journals\/\d+$/.test(path)) {
      const id = Number(path.split('/').pop())
      const item = state.journals.find((j) => j.id === id)
      return item ? json(route, 200, item) : json(route, 404, { detail: 'Journal not found' })
    }

    // ---------- 日程 ----------
    if (path === '/api/schedules' && method === 'GET') {
      if (abort('scheduleList')) return route.abort('failed')
      if (fail('scheduleList')) return json(route, 500, { detail: 'internal error' })
      const page = Number(url.searchParams.get('page') ?? 1)
      const start = (page - 1) * 20
      return json(route, 200, { items: state.schedules.slice(start, start + 20), page, has_next: state.schedules.length > start + 20 })
    }
    if (path === '/api/schedules' && method === 'POST') {
      if (abort('scheduleCreate')) return route.abort('failed')
      if (fail('scheduleCreate')) return json(route, 500, { detail: 'internal error' })
      const body = entry.body
      if (f.scheduleCreate === 'lost') {
        state.schedules.push({ id: state.nextScheduleId++, title: body.title, starts_at: body.starts_at, ends_at: body.ends_at ?? null, completed: Boolean(body.completed), revision: 1, created_at: now, updated_at: now, client_create_id: body.client_create_id })
        return route.abort('failed')
      }
      const existing = state.schedules.find((s) => s.client_create_id === body.client_create_id)
      if (existing) return json(route, 200, existing)
      const row = {
        id: state.nextScheduleId++, title: body.title, starts_at: body.starts_at, ends_at: body.ends_at ?? null,
        completed: Boolean(body.completed), revision: 1, created_at: now, updated_at: now, client_create_id: body.client_create_id,
      }
      state.schedules.push(row)
      return json(route, 201, row)
    }
    const scheduleMatch = path.match(/^\/api\/schedules\/(\d+)$/)
    if (scheduleMatch) {
      const id = Number(scheduleMatch[1])
      const row = state.schedules.find((s) => s.id === id)
      if (!row) return json(route, 404, { detail: 'Schedule not found' })
      if (method === 'GET') {
        if (abort('scheduleGet')) return route.abort('failed')
        return json(route, 200, row)
      }
      if (method === 'PATCH') {
        if (abort('schedulePatch')) return route.abort('failed')
        if (fail('schedulePatch')) return json(route, 500, { detail: 'internal error' })
        if (fail('scheduleConflict')) return json(route, 409, { detail: 'schedule revision has changed' })
        const body = entry.body
        if (body.expected_revision !== row.revision) return json(route, 409, { detail: 'schedule revision has changed' })
        let changed = false
        for (const key of ['title', 'starts_at', 'ends_at', 'completed']) {
          if (key in body && body[key] !== row[key]) { row[key] = body[key]; changed = true }
        }
        if (changed) { row.revision += 1; row.updated_at = now }
        return json(route, 200, row)
      }
      if (method === 'DELETE') {
        if (fail('scheduleDelete')) return json(route, 500, { detail: 'internal error' })
        const rev = Number((entry.ifMatch ?? '').replace(/"/g, ''))
        if (rev !== row.revision) return json(route, 409, { detail: 'schedule revision has changed' })
        state.schedules = state.schedules.filter((s) => s.id !== id)
        return route.fulfill({ status: 204, body: '' })
      }
    }

    // ---------- Insight ----------
    if (path === '/api/insights' && method === 'GET') {
      if (fail('insightList')) return json(route, 500, { detail: 'internal error' })
      return json(route, 200, pageOf(state.insights, Number(url.searchParams.get('page') ?? 1)))
    }
    if (path === '/api/insights' && method === 'POST') {
      if (abort('insightCreate')) return route.abort('failed')
      if (fail('insightCreate')) return json(route, 500, { detail: 'internal error' })
      const body = entry.body
      if (f.insightCreate === 'lost') {
        const text = docText(body.content_doc)
        state.insights.unshift({ type: 'insight', id: state.nextInsightId++, title: body.title ?? null, display_title: (body.title ?? '').trim() || '未命名 Insight', content: text, revision: 1, folder_id: body.folder_id ?? null, created_at: now, updated_at: now, deleted_at: null, content_doc: body.content_doc ?? null, document_schema_version: 1, document_format: 'tiptap', client_create_id: body.client_create_id })
        return route.abort('failed')
      }
      if (body.client_create_id) {
        const existing = state.insights.find((i) => i.client_create_id === body.client_create_id)
        if (existing) return json(route, 200, existing)
      }
      const text = docText(body.content_doc)
      const row = {
        type: 'insight', id: state.nextInsightId++, title: body.title ?? null,
        display_title: (body.title ?? '').trim() || '未命名 Insight', content: text,
        revision: 1, folder_id: body.folder_id ?? null, created_at: now, updated_at: now, deleted_at: null,
        content_doc: body.content_doc ?? null, document_schema_version: 1, document_format: 'tiptap',
        client_create_id: body.client_create_id,
      }
      state.insights.unshift(row)
      return json(route, 201, row)
    }
    const insightMatch = path.match(/^\/api\/insights\/(\d+)$/)
    if (insightMatch) {
      const id = Number(insightMatch[1])
      const row = state.insights.find((i) => i.id === id)
      if (!row) return json(route, 404, { detail: 'Insight not found' })
      if (method === 'GET') {
        if (abort('insightGet')) return route.abort('failed')
        return json(route, 200, row)
      }
      if (method === 'PATCH') {
        if (abort('insightPatch')) return route.abort('failed')
        if (fail('insightPatch')) return json(route, 500, { detail: 'internal error' })
        if (fail('insightConflict')) return json(route, 409, { detail: 'revision conflict', code: 'revision_conflict' })
        const body = entry.body
        if (body.expected_revision !== row.revision) {
          return json(route, 409, { detail: 'revision conflict', code: 'revision_conflict' })
        }
        if ('title' in body) { row.title = body.title; row.display_title = (body.title ?? '').trim() || '未命名 Insight' }
        if ('content_doc' in body) { row.content_doc = body.content_doc; row.content = docText(body.content_doc) }
        if ('folder_id' in body) row.folder_id = body.folder_id
        row.revision += 1
        row.updated_at = now
        return json(route, 200, row)
      }
      if (method === 'DELETE') {
        state.insights = state.insights.filter((i) => i.id !== id)
        return route.fulfill({ status: 204, body: '' })
      }
    }

    // ---------- 搜索 / 链接 ----------
    if (path === '/api/search') {
      const q = (url.searchParams.get('q') ?? '').trim()
      const type = url.searchParams.get('type') ?? 'all'
      const all = [...state.journals, ...state.insights]
      const matched = all.filter((item) => (type === 'all' || item.type === type)
        && (`${item.display_title}${item.content}`.includes(q)))
      return json(route, 200, pageOf(matched, Number(url.searchParams.get('page') ?? 1)))
    }
    if (path === '/api/links/resolve') {
      const title = url.searchParams.get('title') ?? ''
      if (fail('linkResolve')) return json(route, 500, { detail: 'internal error' })
      const matched = [...state.journals, ...state.insights]
        .filter((item) => item.display_title === title)
        .map((item) => ({ type: item.type, id: item.id, title: item.title, display_title: item.display_title, journal_date: item.journal_date, created_at: item.created_at }))
      return json(route, 200, pageOf(matched, 1))
    }

    return json(route, 404, { detail: `not mocked: ${method} ${path}` })
  })
}


export { now, freshState, pageOf, json, installMock }

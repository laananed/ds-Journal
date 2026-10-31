/**
 * SeekJournal Web 常用路径 QA 用的内存 Mock 后端 + 静态服务。
 *
 * 目的：在不连接真实后端（127.0.0.1:8000）与 PostgreSQL 的前提下，
 * 用隔离端口跑真实构建产物，验证 Writing / Set / End 的日常路径。
 *
 * 只实现本次检查需要的最小端点；文档结构与 `backend/app/writing/documents.py`
 * 的 goalItem 转换规则保持一致（纯文字 taskItem → goalItem）。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const PORT = Number(process.env.MOCK_PORT ?? 8039)
const DIST = process.env.MOCK_DIST ?? join(process.cwd(), 'frontend', 'dist')

const DAY = '2026-10-31'

/** 内存库 */
const state = {
  nextId: 1,
  journals: new Map(),          // id -> journal
  createKeys: new Map(),        // client_create_id -> id
  templates: {
    set: { revision: 1, questions: [{ id: 'q-set-1', text: '今天最重要的一件事是什么？' }] },
    end: { revision: 1, questions: [{ id: 'q-end-1', text: '今天最值得记住的瞬间？' }] },
  },
  links: [],                    // { link_id, set_id, end_id, goal_id, end_node_id }
  fault: { patchStatus: null, postStatus: null, patchDelayMs: 0, goalsStatus: null, templateDelayMs: 0, goalDelayMs: 0, goalPatchDelayMs: 0 },
  log: [],
  requests: [],                 // 写请求全文（含 content_doc），用于核对「实际提交了什么」
  marks: [],                    // 场景标记，便于与浏览器事件对齐时间
}

const STARTED_AT = Date.now()
let requestSeq = 0

/** 记录一次写请求：正文、抽取后的文本、服务器接收时刻。 */
function recordRequest(method, path, body) {
  requestSeq += 1
  const entry = {
    seq: requestSeq,
    iso: Date.now(),
    t: Date.now() - STARTED_AT,
    method,
    path,
    body: body ?? null,
    text: body !== null && typeof body === 'object' && body.content_doc !== undefined
      ? textOfDoc(body.content_doc)
      : undefined,
  }
  state.requests.push(entry)
  if (state.requests.length > 400) state.requests.shift()
  return entry
}

function nowIso() { return new Date().toISOString() }

function textOfDoc(doc) {
  if (doc === null || doc === undefined) return ''
  const out = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'text' && typeof node.text === 'string') { out.push(node.text); return }
    if (node.type === 'hardBreak') { out.push('\n'); return }
    if (Array.isArray(node.content)) {
      node.content.forEach((child, index) => {
        walk(child)
        const blockish = ['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'goalItem', 'goalReview', 'aiReply', 'aiSummary']
        if (blockish.includes(node.type) && index < node.content.length - 1) out.push('\n')
      })
    }
  }
  walk(doc)
  return out.join('')
}

function makeJournal(over) {
  const id = state.nextId++
  const journal = {
    type: 'journal',
    id,
    title: null,
    display_title: `写作 #${id}`,
    content: '',
    revision: 1,
    folder_id: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
    journal_date: DAY,
    journal_kind: 'writing',
    content_doc: { type: 'doc', content: [{ type: 'paragraph', attrs: { id: `p-${id}-1` }, content: [] }] },
    document_schema_version: 1,
    document_format: 'tiptap',
    content_blocks: null,
    ...over,
  }
  if (journal.journal_kind === 'set') journal.display_title = `开始今天 · ${journal.journal_date}`
  if (journal.journal_kind === 'end') journal.display_title = `结束今天 · ${journal.journal_date}`
  if (journal.title !== null && journal.title !== '') journal.display_title = journal.title
  journal.content = textOfDoc(journal.content_doc)
  return journal
}

function publicJournal(journal) {
  const base = { ...journal, content: textOfDoc(journal.content_doc) }
  if (journal.journal_kind === 'set' || journal.journal_kind === 'end') {
    base.goal_links = state.links.filter((link) => link.set_id === journal.id || link.end_id === journal.id)
    base.related_revisions = [...state.journals.values()]
      .filter((j) => j.deleted_at === null && state.links.some((l) => (l.set_id === journal.id && l.end_id === j.id) || (l.end_id === journal.id && l.set_id === j.id)))
      .map((j) => ({ type: 'journal', id: j.id, revision: j.revision }))
  }
  return base
}

function findGoalNode(doc, goalId) {
  for (const block of doc?.content ?? []) {
    if (block.type === 'goalItem' && block.attrs?.goal_id === goalId) return block
  }
  return null
}

/** 与后端一致的纯文字 taskItem → goalItem 转换（只处理顶层清单）。 */
function convertTaskItem(doc, itemId, nodeId, goalId) {
  const result = JSON.parse(JSON.stringify(doc))
  const blocks = Array.isArray(result.content) ? result.content : []
  const matches = []
  blocks.forEach((block, li) => {
    if (block.type !== 'taskList' || !Array.isArray(block.content)) return
    block.content.forEach((item, ii) => {
      if (item?.attrs?.id === itemId) matches.push([li, ii])
    })
  })
  if (matches.length !== 1) return null
  const [li, ii] = matches[0]
  const block = result.content[li]
  const item = block.content[ii]
  const checked = item?.attrs?.checked
  if (typeof checked !== 'boolean') return null
  const children = item.content ?? []
  if (children.length !== 1 || children[0].type !== 'paragraph') return null
  const parts = []
  for (const child of children[0].content ?? []) {
    if (Array.isArray(child.marks) && child.marks.length > 0) return null
    if (child.type === 'text') parts.push(child.text ?? '')
    else if (child.type === 'hardBreak') parts.push('\n')
    else return null
  }
  const value = parts.join('')
  if (value.trim() === '' || Array.from(value).length > 2000) return null
  const goal = { type: 'goalItem', attrs: { id: nodeId, goal_id: goalId, text: value, checked } }
  const before = block.content.slice(0, ii)
  const after = block.content.slice(ii + 1)
  const replacement = []
  if (before.length > 0) replacement.push({ ...block, content: before })
  replacement.push(goal)
  if (after.length > 0) {
    const last = { ...block, content: after }
    if (before.length > 0 && last.attrs && 'id' in last.attrs) last.attrs = { ...last.attrs, id: `tl-${Math.random().toString(16).slice(2)}` }
    replacement.push(last)
  }
  result.content.splice(li, 1, ...replacement)
  return result
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = normalize(join(DIST, rel))
  if (!file.startsWith(normalize(DIST))) { send(res, 403, { detail: 'forbidden' }); return }
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch {
    const html = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    res.end(html)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  const method = req.method ?? 'GET'
  state.log.push({ at: nowIso(), method, path: p + url.search })

  /* ---------------------------------------------------------- QA 控制面 */
  if (p === '/__mock/state') {
    return send(res, 200, {
      journals: [...state.journals.values()].map(publicJournal),
      fault: state.fault,
      log: state.log.slice(-200),
      requests: state.requests,
      marks: state.marks,
    })
  }
  if (p === '/__mock/log') {
    return send(res, 200, { requests: state.requests, marks: state.marks, now: Date.now() })
  }
  if (p === '/__mock/mark') {
    const body = await readBody(req)
    state.marks.push({ label: String(body.label ?? ''), iso: Date.now(), t: Date.now() - STARTED_AT })
    return send(res, 200, { ok: true, marks: state.marks })
  }
  if (p === '/__mock/fault') {
    const body = await readBody(req)
    state.fault = { ...state.fault, ...body }
    return send(res, 200, state.fault)
  }
  if (p === '/__mock/reset') {
    state.nextId = 1
    state.journals.clear()
    state.createKeys.clear()
    state.links = []
    state.fault = { patchStatus: null, postStatus: null, patchDelayMs: 0, goalsStatus: null, templateDelayMs: 0, goalDelayMs: 0, goalPatchDelayMs: 0 }
    state.log = []
    state.requests = []
    state.marks = []
    return send(res, 200, { ok: true })
  }

  if (!p.startsWith('/api/')) return serveStatic(res, p)

  /* ------------------------------------------------------------- 读接口 */
  if (method === 'GET' && p === '/api/business-day') {
    return send(res, 200, { timezone: 'Asia/Shanghai', day_start_hour: 4, server_time: nowIso(), business_date: DAY })
  }

  if (method === 'GET' && p === '/api/journals') {
    const date = url.searchParams.get('journal_date')
    const kind = url.searchParams.get('journal_kind')
    const page = Number(url.searchParams.get('page') ?? '1')
    let items = [...state.journals.values()].filter((j) => j.deleted_at === null)
    if (date !== null) items = items.filter((j) => j.journal_date === date)
    if (kind !== null && kind !== 'all') items = items.filter((j) => (j.journal_kind ?? 'writing') === kind)
    items.sort((a, b) => b.id - a.id)
    const pageSize = 20
    const slice = items.slice((page - 1) * pageSize, page * pageSize)
    return send(res, 200, {
      items: slice.map(publicJournal),
      page,
      page_size: pageSize,
      total: items.length,
      has_next: page * pageSize < items.length,
    })
  }

  if (method === 'GET' && /^\/api\/journals\/\d+$/.test(p)) {
    const id = Number(p.split('/').pop())
    const journal = state.journals.get(id)
    if (journal === undefined || journal.deleted_at !== null) {
      return send(res, 404, { detail: 'journal not found', code: 'not_found' })
    }
    return send(res, 200, publicJournal(journal))
  }

  if (method === 'GET' && p === '/api/rituals') {
    const date = url.searchParams.get('journal_date') ?? DAY
    const pick = (kind) => [...state.journals.values()]
      .filter((j) => j.journal_date === date && j.journal_kind === kind && j.deleted_at === null)
      .map(publicJournal)[0] ?? null
    return send(res, 200, { journal_date: date, set: pick('set'), end: pick('end') })
  }

  if (method === 'GET' && p === '/api/ritual-templates') return send(res, 200, state.templates)

  if (method === 'GET' && p === '/api/trash') {
    const type = url.searchParams.get('type')
    const items = [...state.journals.values()]
      .filter((j) => j.deleted_at !== null)
      .filter((j) => type === null || type === 'all' || type === 'journal')
      .sort((a, b) => b.id - a.id)
      .map(publicJournal)
    return send(res, 200, { items, page: 1, page_size: 20, total: items.length, has_next: false })
  }

  if (method === 'GET' && /^\/api\/trash\/(journal|insight)\/\d+$/.test(p)) {
    const id = Number(p.split('/').pop())
    const journal = state.journals.get(id)
    if (journal === undefined || journal.deleted_at === null) return send(res, 404, { detail: 'trash item not found', code: 'not_found' })
    return send(res, 200, publicJournal(journal))
  }

  if (method === 'GET' && p === '/api/ai/settings') {
    return send(res, 503, { detail: 'AI disabled in QA mock', code: 'ai_unavailable' })
  }

  /* ------------------------------------------------------------- 写接口 */
  if (method === 'POST' && p === '/api/journals') {
    const body = await readBody(req)
    recordRequest('POST', p, body)
    if (state.fault.postStatus !== null) return send(res, state.fault.postStatus, { detail: 'injected failure', code: 'injected' })
    const key = body.client_create_id ?? null
    if (key !== null && state.createKeys.has(key)) {
      const existing = state.journals.get(state.createKeys.get(key))
      return send(res, 200, publicJournal(existing))
    }
    const journal = makeJournal({
      title: body.title ?? null,
      folder_id: body.folder_id ?? null,
      journal_date: body.journal_date ?? DAY,
      journal_kind: body.journal_kind ?? 'writing',
      content_doc: body.content_doc ?? { type: 'doc', content: [{ type: 'paragraph', attrs: { id: `p-${state.nextId}-1` }, content: [] }] },
    })
    if (body.deleted === true) journal.deleted_at = nowIso()
    state.journals.set(journal.id, journal)
    if (key !== null) state.createKeys.set(key, journal.id)
    return send(res, 201, publicJournal(journal))
  }

  if (method === 'PATCH' && /^\/api\/journals\/\d+$/.test(p)) {
    const body = await readBody(req)
    const logged = recordRequest('PATCH', p, body)
    if (state.fault.patchDelayMs > 0) await new Promise((r) => setTimeout(r, state.fault.patchDelayMs))
    if (state.fault.patchStatus !== null) {
      logged.result = state.fault.patchStatus
      return send(res, state.fault.patchStatus, { detail: 'injected failure', code: 'injected' })
    }
    const id = Number(p.split('/').pop())
    const journal = state.journals.get(id)
    if (journal === undefined || journal.deleted_at !== null) {
      logged.result = 404
      return send(res, 404, { detail: 'journal not found', code: 'not_found' })
    }
    if (body.expected_revision !== journal.revision) {
      logged.result = 409
      return send(res, 409, { detail: 'revision conflict', code: 'revision_conflict' })
    }
    if (body.title !== undefined) journal.title = body.title
    if (body.content_doc !== undefined) journal.content_doc = body.content_doc
    if (body.journal_date !== undefined) journal.journal_date = body.journal_date
    if (body.folder_id !== undefined) journal.folder_id = body.folder_id
    journal.revision += 1
    journal.updated_at = nowIso()
    journal.display_title = journal.title !== null && journal.title !== ''
      ? journal.title
      : (journal.journal_kind === 'set' ? `开始今天 · ${journal.journal_date}` : journal.journal_kind === 'end' ? `结束今天 · ${journal.journal_date}` : `写作 #${journal.id}`)
    return send(res, 200, publicJournal(journal))
  }

  if (method === 'PATCH' && /^\/api\/ritual-templates\/(set|end)$/.test(p)) {
    const kind = p.split('/').pop()
    const body = await readBody(req)
    recordRequest('PATCH', p, body)
    if (state.fault.templateDelayMs > 0) await new Promise((r) => setTimeout(r, state.fault.templateDelayMs))
    if (body.expected_revision !== state.templates[kind].revision) return send(res, 409, { detail: 'template conflict', code: 'revision_conflict' })
    state.templates[kind] = { revision: state.templates[kind].revision + 1, questions: body.questions ?? [] }
    return send(res, 200, state.templates[kind])
  }

  if (method === 'POST' && /^\/api\/rituals\/\d+\/goals$/.test(p)) {
    const body = await readBody(req)
    recordRequest('POST', p, body)
    if (state.fault.goalDelayMs > 0) await new Promise((r) => setTimeout(r, state.fault.goalDelayMs))
    if (state.fault.goalsStatus !== null) return send(res, state.fault.goalsStatus, { detail: 'injected failure', code: 'injected' })
    const id = Number(p.split('/')[3])
    const journal = state.journals.get(id)
    if (journal === undefined) return send(res, 404, { detail: 'not found', code: 'not_found' })
    if (body.expected_revision !== journal.revision) return send(res, 409, { detail: 'revision conflict', code: 'revision_conflict' })
    const nodeId = `goal-${Math.random().toString(16).slice(2)}`
    const goalId = `goal-id-${Math.random().toString(16).slice(2)}`
    const next = convertTaskItem(journal.content_doc, body.task_item_id, nodeId, goalId)
    if (next === null) return send(res, 422, { detail: 'checklist item cannot be converted', code: 'invalid_goal' })
    const baseRevision = journal.revision
    journal.content_doc = next
    journal.revision += 1
    journal.updated_at = nowIso()
    return send(res, 200, {
      files: [publicJournal(journal)],
      effects: [{ type: 'journal', id: journal.id, base_revision: baseRevision, revision: journal.revision, ops: [{ kind: 'copy_nodes', node_id: nodeId }] }],
      request_id: null,
    })
  }

  if (method === 'PATCH' && /^\/api\/ritual-goals\/\d+\/[^/]+$/.test(p)) {
    const parts = p.split('/')
    const setId = Number(parts[3])
    const goalId = decodeURIComponent(parts[4])
    const set = state.journals.get(setId)
    if (set === undefined) return send(res, 404, { detail: 'not found', code: 'not_found' })
    const body = await readBody(req)
    const logged = recordRequest('PATCH', p, body)
    if (state.fault.goalPatchDelayMs > 0) await new Promise((r) => setTimeout(r, state.fault.goalPatchDelayMs))
    if (body.expected_set_revision !== set.revision) { logged.result = 409; return send(res, 409, { detail: 'revision conflict', code: 'revision_conflict' }) }
    const node = findGoalNode(set.content_doc, goalId)
    if (node === null) return send(res, 404, { detail: 'goal not found', code: 'not_found' })
    const baseRevision = set.revision
    if (typeof body.checked === 'boolean') node.attrs.checked = body.checked
    if (typeof body.text === 'string') node.attrs.text = body.text
    set.revision += 1
    set.updated_at = nowIso()
    return send(res, 200, {
      files: [publicJournal(set)],
      effects: [{ type: 'journal', id: set.id, base_revision: baseRevision, revision: set.revision, ops: [{ kind: 'goal_fields', node_id: node.attrs.id }] }],
      request_id: null,
    })
  }

  if (method === 'POST' && p === '/api/ritual-goal-links') {
    const body = await readBody(req)
    const set = state.journals.get(Number(body.source_set_id))
    const end = state.journals.get(Number(body.end_id))
    if (set === undefined || end === undefined) return send(res, 404, { detail: 'not found', code: 'not_found' })
    if (body.expected_set_revision !== set.revision) return send(res, 409, { detail: 'revision conflict', code: 'revision_conflict' })
    if (body.expected_end_revision !== end.revision) return send(res, 409, { detail: 'revision conflict', code: 'revision_conflict' })
    const baseRevision = end.revision
    const created = []
    for (const goalId of body.goal_ids ?? []) {
      const goal = findGoalNode(set.content_doc, goalId)
      if (goal === null) return send(res, 422, { detail: 'goal unavailable', code: 'invalid_goal' })
      const linkId = `link-${Math.random().toString(16).slice(2)}`
      const nodeId = `review-${Math.random().toString(16).slice(2)}`
      end.content_doc.content.push({
        type: 'goalReview',
        attrs: { id: nodeId, link_id: linkId, review_title: goal.attrs.text, goal_snapshot: goal.attrs.text, checked_snapshot: goal.attrs.checked },
        content: [{ type: 'paragraph', attrs: { id: `rp-${Math.random().toString(16).slice(2)}` }, content: [] }],
      })
      state.links.push({ link_id: linkId, set_id: set.id, end_id: end.id, goal_id: goalId, end_node_id: nodeId })
      created.push(nodeId)
    }
    end.revision += 1
    end.updated_at = nowIso()
    return send(res, 200, {
      files: [publicJournal(set), publicJournal(end)],
      effects: [{ type: 'journal', id: end.id, base_revision: baseRevision, revision: end.revision, ops: created.map((node_id) => ({ kind: 'copy_nodes', node_id })) }],
      request_id: null,
    })
  }

  return send(res, 404, { detail: `no mock route: ${method} ${p}`, code: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock server on http://127.0.0.1:${PORT} (dist=${DIST})`)
})

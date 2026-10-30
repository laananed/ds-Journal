/**
 * Insight 会话绑定的纯逻辑测试（Stage 4 / S04-T11，修复 D1）。
 *
 * 用 Node 内置类型剥离运行，不引入测试框架：
 *
 *   node --experimental-strip-types src/state/insightSession.test.ts
 *
 * 复现的缺陷（独立测试 D1）：新建 Insight 保存成功后，会话键仍是
 * `insight:draft:<key>`（`settleWrite` 只换写队列键）。同页「返回列表 → 重开详情」
 * 时若订阅方二次假设 `insight:<id>`，`getSession` 得到 null，编辑绑定空草稿、
 * 自动保存不触发、导航前 flush 也找不到会话。
 *
 * 这里锁定修复后的消费契约（页面在渲染期用 `findInsightSession` 解析实际会话）：
 * 1. 重开详情后必须解析到**同一条**会话，而不是 null；
 * 2. 重开不会重置草稿身份，也不会覆盖较新输入；
 * 3. 后续编辑走真实 PATCH（带 CAS 版本），不是重新创建；
 * 4. `insightHasUnsavedInput` 只把真实未提交输入判为「需要保存」。
 */

import { createEditSessionStore, type DocumentDraft, type SaveTransport } from './editSessions.ts'
import { findInsightSession, insightDraftSessionId, insightHasUnsavedInput, insightSessionId } from './insightSession.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`失败：${label}`)
  passed += 1
}

function draft(title: string, text: string): DocumentDraft {
  return {
    title,
    content_doc: {
      type: 'doc',
      content: text === ''
        ? []
        : [{ type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text }] }],
    },
    date: '',
    folder_id: null,
  }
}

const BLANK = draft('', '')

interface Call { kind: 'create' | 'update'; id?: number; revision?: number; title: string }

/** 记录真实请求序列的传输层：创建回 id 7 / v1，更新逐次 +1。 */
function recordingTransport(calls: Call[]): SaveTransport {
  return {
    async create(request) {
      calls.push({ kind: 'create', title: request.draft.title })
      return { id: 7, revision: 1, draft: request.draft }
    },
    async update(request) {
      calls.push({
        kind: 'update',
        id: request.file_id,
        revision: request.expected_revision,
        title: request.draft.title,
      })
      return { id: request.file_id, revision: request.expected_revision + 1, draft: request.draft }
    },
  }
}

/**
 * 同页创建 → 重开详情：必须引用同一会话，订阅键用返回的 resolved。
 * 同时验证「草稿身份不被重建」与「重开不覆盖较新输入」。
 */
async function testReopenAfterCreate() {
  const calls: Call[] = []
  const store = createEditSessionStore()
  const transport = recordingTransport(calls)
  const draftKey = insightDraftSessionId('draft-d1')

  store.openSession({
    sessionId: draftKey, type: 'insight', tabId: 'insight', draft: BLANK, transport, createKey: 'key-d1',
  })
  check(findInsightSession(store, { fileId: null, draftId: draftKey })?.sessionId === draftKey, '创建面板绑定草稿键')
  const createdDraftId = store.getSession(draftKey)?.draftId

  store.changeSession(draftKey, draft('第一版', '刚写下的内容'), 'user_input')
  await store.saveToSequence(draftKey)
  check(calls.length === 1 && calls[0].kind === 'create', '创建只发一次 POST')
  check(store.getSession(draftKey)?.fileId === 7, '创建后会话拿到真实文件 ID')

  // 同页返回列表 → 重开详情：请求键是 insight:7，实际会话仍是草稿键。
  const reopen = store.openSession({
    sessionId: insightSessionId(7),
    type: 'insight',
    tabId: 'insight',
    draft: draft('服务器标题', '服务器内容'),
    file: { id: 7, revision: 1, draft: draft('服务器标题', '服务器内容') },
    transport,
  })
  const bound = findInsightSession(store, { fileId: 7, draftId: insightSessionId(7) })
  check(bound !== null, '重开详情能解析到存活会话（D1 的核心断言）')
  check(bound?.sessionId === reopen.sessionId, '解析结果就是 openSession 复用的那条会话')
  check(bound?.fileId === 7, '绑定会话指向真实文件')
  check(bound?.draft.title === '第一版', '重开不覆盖会话里的较新输入')
  check(bound?.draftId === createdDraftId, '草稿身份未被重建')

  // 重开后的修改必须走真实 PATCH，且带当前版本。
  const boundKey = bound?.sessionId ?? ''
  store.changeSession(boundKey, draft('第二版', '重开后改的内容'), 'user_input')
  check(insightHasUnsavedInput(store.getSession(boundKey)), '修改后判为有未提交输入')
  await store.saveToSequence(boundKey)
  const patch = calls[1]
  check(calls.length === 2 && patch.kind === 'update', '重开后保存是 PATCH 而不是再次创建')
  check(patch?.id === 7 && patch?.revision === 1, 'PATCH 带真实文件 ID 与 CAS 版本')
  check(store.getSession(boundKey)?.revision === 2, 'PATCH 成功后版本推进')

  // 已同步之后不再被判为「有未提交输入」。
  check(!insightHasUnsavedInput(store.getSession(boundKey)), '同步完成后不阻塞导航')
  check(!insightHasUnsavedInput(null), '没有会话时不阻塞导航')
}

/**
 * 已有文件直接打开：请求键与实际键一致，第二次打开复用同一会话（不重建）。
 */
async function testOpenExistingIsStable() {
  const calls: Call[] = []
  const store = createEditSessionStore()
  const transport = recordingTransport(calls)
  const first = store.openSession({
    sessionId: insightSessionId(11),
    type: 'insight',
    tabId: 'insight',
    draft: draft('A', '正文'),
    file: { id: 11, revision: 3, draft: draft('A', '正文') },
    transport,
  })
  check(first.sessionId === 'insight:11', '没有存活草稿会话时按 insight:<id> 建会话')
  store.changeSession(first.sessionId, draft('A', '本地新增'), 'user_input')
  store.openSession({
    sessionId: insightSessionId(11),
    type: 'insight',
    tabId: 'insight',
    draft: draft('A', '正文'),
    file: { id: 11, revision: 3, draft: draft('A', '正文') },
    transport,
  })
  const second = findInsightSession(store, { fileId: 11, draftId: 'insight:11' })
  check(second?.sessionId === first.sessionId, '再次打开复用同一会话键')
  check(second?.draft.title === 'A', '复用会话保留草稿')
  check(calls.length === 0, '打开详情本身不发写请求')
}

/** 保存失败时：草稿留在会话里，导航仍被判定为「不可静默离开」。 */
async function testFailureKeepsDraft() {
  const store = createEditSessionStore()
  const failing: SaveTransport = {
    async create() { throw new Error('网络中断') },
    async update() { throw new Error('网络中断') },
  }
  const key = insightDraftSessionId('draft-fail')
  store.openSession({
    sessionId: key,
    type: 'insight',
    tabId: 'insight',
    draft: BLANK,
    transport: failing,
    createKey: 'key-fail',
  })
  store.changeSession(key, draft('失败也要留', '不能丢的字'), 'user_input')
  await store.saveToSequence(key)
  const session = findInsightSession(store, { fileId: null, draftId: key })
  check(session?.status === 'failed', '创建失败进入 failed')
  check(session?.draft.title === '失败也要留' && session.draft.content_doc !== null, '失败后草稿仍在')
  check(insightHasUnsavedInput(session), '失败后导航前必须先保存/确认')
}

await testReopenAfterCreate()
await testOpenExistingIsStable()
await testFailureKeepsDraft()

console.log(`insightSession: ${passed} 项通过`)

/**
 * 应用级编辑会话的纯逻辑测试（Stage 4 / S04-T02）。
 *
 * 不引入测试框架，直接用 Node 内置类型剥离运行：
 *
 *   node --experimental-strip-types src/state/editSessions.test.ts
 *
 * 断言只用 `throw`/`check`，因此不需要额外类型声明，也能被 `tsc -b` 检查。
 *
 * 覆盖 `docs/stage4-tasks.md` §3.3 与产品 §10 / API §10 的关键故障：
 * 单文件单在途、创建丢响应后同键重放再 PATCH、切页续写、迟到与乱序响应、
 * 跨文件隔离、CAS 冲突、404、网络失败、有界序号屏障、受控窄 effects。
 */

import {
  applyChange,
  applyNarrowOps,
  createEditSessionStore,
  draftEquals,
  draftPatch,
  EditSessionRestoreError,
  fileKey,
  localStateLabel,
  planWrite,
  settleWrite,
  createSession,
  sortQueueKeys,
  type CreateRequest,
  type DocumentDraft,
  type EditSession,
  type FileMutation,
  type OpenSessionInput,
  type SaveTransport,
  type ServerFile,
  type UpdateRequest,
} from './editSessions.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`失败：${label}`)
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(actualText === expectedText, `${label}：期望 ${expectedText}，实际 ${actualText}`)
}

/* --------------------------------------------------------------- 测试替身 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Call = { kind: 'create' | 'update'; request: CreateRequest | UpdateRequest; reply: Deferred<ServerFile> }

/** 手动控制每次请求何时、以什么结果返回的传输层。 */
function manualTransport(): { transport: SaveTransport; calls: Call[] } {
  const calls: Call[] = []
  const transport: SaveTransport = {
    create(request) {
      const reply = deferred<ServerFile>()
      calls.push({ kind: 'create', request, reply })
      return reply.promise
    },
    update(request) {
      const reply = deferred<ServerFile>()
      calls.push({ kind: 'update', request, reply })
      return reply.promise
    },
  }
  return { transport, calls }
}

function doc(text = ''): unknown {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'p-1' }, content: text === '' ? [] : [{ type: 'text', text }] }],
  }
}

function draft(overrides: Partial<DocumentDraft> = {}): DocumentDraft {
  return { title: '', content_doc: doc(''), date: '2026-10-30', folder_id: null, ...overrides }
}

function serverFile(id: number, revision: number, value: DocumentDraft): ServerFile {
  return { id, revision, draft: value }
}

function httpError(status: number, message = `HTTP ${status}`): unknown {
  return Object.assign(new Error(message), { status })
}

function openNew(store: ReturnType<typeof createEditSessionStore>, transport: SaveTransport, sessionId = 's1') {
  return store.openSession({
    sessionId,
    type: 'journal',
    tabId: 'tab-1',
    draft: draft(),
    transport,
  })
}

const flushMicrotasks = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

/* ------------------------------------------------- 1. 会话基础与序号语义 */

{
  const transport = manualTransport()
  const store = createEditSessionStore()
  const session = openNew(store, transport.transport)
  expectEqual(session.status, 'saved', '新会话初始为已保存（服务器无内容）')
  expectEqual(session.queueKey, 'draft:s1', '未取得 id 前写队列键以草稿身份区分')

  store.changeSession('s1', draft({ content_doc: doc('第一句') }), 'user_input')
  const changed = store.getSession('s1')!
  expectEqual(changed.inputSeq, 1, '用户输入推进保存序号')
  expectEqual(changed.userInputSeq, 1, '用户输入推进 AI 触发序号')
  expectEqual(changed.status, 'unsaved', '有未提交输入')

  // 相同内容不推进序号，也不制造一次提交机会。
  store.changeSession('s1', draft({ content_doc: doc('第一句') }), 'user_input')
  expectEqual(store.getSession('s1')!.inputSeq, 1, '相同内容不推进序号')

  // 系统写入推进保存序号，但不推进 AI 触发序号（模板插入 / 载入 / AI 回写）。
  store.changeSession('s1', draft({ content_doc: doc('第一句'), title: '系统标题' }), 'system')
  expectEqual(store.getSession('s1')!.inputSeq, 2, '系统写入仍需保存')
  expectEqual(store.getSession('s1')!.userInputSeq, 1, '系统写入不推进 AI 触发序号')
}

/* ------------------------------------ 2. 单文件单在途 + 创建重放 + 后续 PATCH */

async function testCreateReplayAndPatch(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  openNew(store, transport)
  const first = draft({ title: '标题', content_doc: doc('第一次') })
  store.changeSession('s1', first, 'user_input')

  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 1, '首次保存只有一个请求')
  expectEqual(calls[0].kind, 'create', '首次保存是创建')
  const createKey = (calls[0].request as CreateRequest).client_create_id
  check(createKey !== '', '创建请求带稳定键')

  // 首次 POST 响应丢失前，用户继续输入：不能换键，也不能把新输入改成首次 payload。
  store.changeSession('s1', draft({ title: '标题', content_doc: doc('第一次第二次') }), 'user_input')
  expectEqual(calls.length, 1, '在途期间不排第二个请求')

  // 首次 POST 响应丢失（网络错误）：保留首次 payload 与原键，状态为失败。
  calls[0].reply.reject(httpError(0, '网络中断'))
  await saving
  const failed = store.getSession('s1')!
  expectEqual(failed.status, 'failed', '首次创建失败进入 failed')
  expectEqual(failed.firstRequest?.client_create_id, createKey, '失败后保留首次创建键')
  expectEqual(failed.draft.content_doc, doc('第一次第二次'), '失败后保留较新草稿')

  // 用户显式重试：同键 + 同首次 payload（不是新输入）。
  const retrying = store.retry('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 2, '重试发出第二次创建请求')
  expectEqual(calls[1].kind, 'create', '重试仍是创建（身份尚未取得）')
  expectEqual((calls[1].request as CreateRequest).client_create_id, createKey, '重试复用同一个创建键')
  expectEqual((calls[1].request as CreateRequest).draft, first, '重放的是首次 payload，不含新输入')

  // 重放成功：取得真实身份与版本，较新输入继续以 PATCH 提交。
  calls[1].reply.resolve(serverFile(42, 1, first))
  await flushMicrotasks()
  const afterCreate = store.getSession('s1')!
  expectEqual(afterCreate.fileId, 42, '取得服务器 id')
  expectEqual(afterCreate.queueKey, fileKey('journal', 42), '写队列键切换为 typed key')
  expectEqual(calls.length, 3, '较新输入随后以 PATCH 提交')
  expectEqual(calls[2].kind, 'update', '第二次写入是 PATCH')
  expectEqual((calls[2].request as UpdateRequest).expected_revision, 1, 'PATCH 用真实返回的版本')
  expectEqual((calls[2].request as UpdateRequest).draft.content_doc, doc('第一次第二次'), 'PATCH 带上最新输入')

  calls[2].reply.resolve(serverFile(42, 2, draft({ title: '标题', content_doc: doc('第一次第二次') })))
  const retried = await retrying
  expectEqual(retried.kind, 'clean', '重放并补写完成后回到干净状态')
  const settled = store.getSession('s1')!
  expectEqual(settled.revision, 2, 'PATCH 成功后版本推进')
  expectEqual(settled.status, 'saved', '最终状态为服务器已保存')
  expectEqual(settled.draft.content_doc, doc('第一次第二次'), '最终草稿与提交内容一致')
}

/* ---------------------------------------------------- 3. 切页续写（页面卸载） */

async function testNavigateAwayKeepsSaving(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  openNew(store, transport)
  store.changeSession('s1', draft({ content_doc: doc('切页前') }), 'user_input')

  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 1, '切页前已发出保存')

  // 模拟导航：页面不再订阅，但应用级会话与在途请求都在。
  const unsubscribe = store.subscribe(() => {})
  unsubscribe()
  calls[0].reply.resolve(serverFile(7, 1, draft({ content_doc: doc('切页前') })))
  await saving

  // 回到原页面：复用同一会话，不重建、不丢草稿。
  const reopened = store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1',
    draft: draft(), transport: transport,
  })
  expectEqual(reopened.sessionId, 's1', '重新打开复用同一会话')
  expectEqual(reopened.fileId, 7, '身份在会话里保留')
  expectEqual(reopened.status, 'saved', '切页期间保存成功')

  // 回到页面后继续写，仍走同一个会话的队列。
  store.changeSession('s1', draft({ content_doc: doc('切页后') }), 'user_input')
  const saving2 = store.saveToSequence('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 2, '回来后继续以 PATCH 写入')
  expectEqual((calls[1].request as UpdateRequest).file_id, 7, 'PATCH 目标仍是同一文件')
  calls[1].reply.resolve(serverFile(7, 2, draft({ content_doc: doc('切页后') })))
  await saving2
  expectEqual(store.getSession('s1')!.revision, 2, '续写版本推进')
}

/* ------------------------------------------------ 4. 迟到响应与已关闭会话 */

async function testLateResponseIgnored(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  openNew(store, transport)
  store.changeSession('s1', draft({ content_doc: doc('旧输入') }), 'user_input')
  const saving = store.saveToSequence('s1')
  await flushMicrotasks()

  // 用户中途采用服务器版本（冲突界面操作），在途请求此时已不属于当前基线。
  store.resolveTakeServer('s1', { id: 5, revision: 9, draft: draft({ content_doc: doc('服务器内容') }) })
  calls[0].reply.resolve(serverFile(5, 10, draft({ content_doc: doc('旧输入') })))
  await saving

  const session = store.getSession('s1')!
  expectEqual(session.revision, 9, '迟到响应不覆盖已采用的服务器版本')
  expectEqual(session.draft.content_doc, doc('服务器内容'), '迟到响应不覆盖用户已选择的内容')
  expectEqual(session.status, 'saved', '迟到响应不改状态')
}

async function testClosedSessionIgnored(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  openNew(store, transport)
  store.changeSession('s1', draft({ content_doc: doc('将被丢弃') }), 'user_input')
  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  store.closeSession('s1')
  calls[0].reply.resolve(serverFile(11, 1, draft({ content_doc: doc('将被丢弃') })))
  await saving
  expectEqual(store.getSession('s1'), null, '已关闭会话不会被迟到响应复活')
}

/* ------------------------------------------------------ 5. 跨文件响应隔离 */

async function testCrossFileIsolation(): Promise<void> {
  const a = manualTransport()
  const b = manualTransport()
  const store = createEditSessionStore()
  openNew(store, a.transport, 'sa')
  store.openSession({ sessionId: 'sb', type: 'journal', tabId: 'tab-1', draft: draft(), transport: b.transport })

  store.changeSession('sa', draft({ content_doc: doc('A 文件') }), 'user_input')
  store.changeSession('sb', draft({ content_doc: doc('B 文件') }), 'user_input')
  const savingA = store.saveToSequence('sa')
  const savingB = store.saveToSequence('sb')
  await flushMicrotasks()
  expectEqual(a.calls.length, 1, 'A 文件发出自己的请求')
  expectEqual(b.calls.length, 1, 'B 文件发出自己的请求')

  // A 失败，B 成功：两个文件互不影响。
  a.calls[0].reply.reject(httpError(500, 'A 失败'))
  b.calls[0].reply.resolve(serverFile(2, 1, draft({ content_doc: doc('B 文件') })))
  await Promise.all([savingA, savingB])

  expectEqual(store.getSession('sa')!.status, 'failed', 'A 进入失败')
  expectEqual(store.getSession('sa')!.draft.content_doc, doc('A 文件'), 'A 保留草稿')
  expectEqual(store.getSession('sb')!.status, 'saved', 'B 不受 A 失败影响')
  expectEqual(store.getSession('sb')!.fileId, 2, 'B 取得自己的身份')

  // B 的响应不会把 A 的草稿或状态改掉。
  expectEqual(store.getSession('sa')!.fileId, null, '跨文件响应不改其他文件的身份')
}

/* ------------------------------------------------ 6. CAS 冲突 / 404 / 失败 */

async function testConflictKeepsBothSides(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: doc('服务器内容') }),
    file: { id: 3, revision: 4, draft: draft({ content_doc: doc('服务器内容') }) },
    transport: transport,
  })
  store.changeSession('s1', draft({ content_doc: doc('本地内容') }), 'user_input')
  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  calls[0].reply.reject(httpError(409, 'revision_conflict'))
  await saving

  const conflicted = store.getSession('s1')!
  expectEqual(conflicted.status, 'conflict', '409 进入冲突')
  expectEqual(conflicted.draft.content_doc, doc('本地内容'), '冲突保留本地内容')
  expectEqual(conflicted.baseline.content_doc, doc('服务器内容'), '冲突保留服务器基线')
  expectEqual(conflicted.revision, 4, '冲突不自动抬版本')

  // 冲突状态下不自动重试。
  const again = await store.saveToSequence('s1')
  expectEqual(again, { kind: 'blocked', reason: 'conflict' }, '冲突时不自动重发')

  // 用户明确选择「保留我的草稿，基于服务器最新版本重发」。
  store.resolveKeepLocal('s1', { id: 3, revision: 7, draft: draft({ content_doc: doc('服务器内容 v7') }) })
  const resaving = store.saveToSequence('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 2, '显式选择后重新提交')
  expectEqual((calls[1].request as UpdateRequest).expected_revision, 7, '用真实最新版本重发')
  expectEqual((calls[1].request as UpdateRequest).draft.content_doc, doc('本地内容'), '重发仍带本地内容')
  calls[1].reply.resolve(serverFile(3, 8, draft({ content_doc: doc('本地内容') })))
  await resaving
  expectEqual(store.getSession('s1')!.status, 'saved', '最终保存成功')
}

async function testMissingServerKeepsDraft(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: doc('旧内容') }),
    file: { id: 9, revision: 2, draft: draft({ content_doc: doc('旧内容') }) },
    transport: transport,
  })
  store.changeSession('s1', draft({ content_doc: doc('新内容') }), 'user_input')
  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  calls[0].reply.reject(httpError(404, 'Journal 不存在'))
  await saving
  const session = store.getSession('s1')!
  expectEqual(session.status, 'missing', '404 标记服务器已不存在')
  expectEqual(session.draft.content_doc, doc('新内容'), '404 不丢本地草稿')
  const created = await store.saveToSequence('s1')
  expectEqual(created, { kind: 'blocked', reason: 'missing' }, '404 后不自动新建其它文件')
}

/* ------------------------------------------------------ 7. 有界序号屏障 */

async function testBoundedSequenceBarrier(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: doc('基线') }),
    file: { id: 12, revision: 3, draft: draft({ content_doc: doc('基线') }) },
    transport: transport,
  })
  store.changeSession('s1', draft({ content_doc: doc('屏障内') }), 'user_input')
  const barrierSeq = store.getSession('s1')!.inputSeq
  expectEqual(barrierSeq, 1, '屏障序号为当前输入序号')

  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  // 请求已经带上屏障内的内容；用户继续输入不会改变这次请求。
  store.changeSession('s1', draft({ content_doc: doc('屏障内 + 之后') }), 'user_input')
  expectEqual((calls[0].request as UpdateRequest).draft.content_doc, doc('屏障内'), '提交的是屏障内快照')
  calls[0].reply.resolve(serverFile(12, 4, draft({ content_doc: doc('屏障内') })))
  const result = await saving
  expectEqual(result, { kind: 'queued', seq: 2 }, '屏障之后的输入留待下一轮')
  const session = store.getSession('s1')!
  expectEqual(session.status, 'unsaved', '新输入仍未提交')
  expectEqual(session.draft.content_doc, doc('屏障内 + 之后'), '新输入完整保留')
}

/* --------------------------------------------------- 8. 受控窄 effects 应用 */

/** 服务器把占位替换成回复后，同一 id 只保留一个节点。 */
function placeholderDoc(text: string, replacement: string | null): unknown {
  const paragraph = { type: 'paragraph', attrs: { id: 'p-1' }, content: [{ type: 'text', text }] }
  const second = replacement === null
    ? { type: 'aiPlaceholder', attrs: { id: 'ph-1', request_id: 'r-1' } }
    : {
        type: 'aiReply',
        attrs: { id: 'ph-1', request_id: 'r-1' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: replacement }] }],
      }
  return { type: 'doc', content: [paragraph, second] }
}

async function testApplyMutation(): Promise<void> {
  const { transport } = manualTransport()
  const store = createEditSessionStore()
  // 会话 A：没有较新输入 → 整体采用服务器内容。
  store.openSession({
    sessionId: 'idle', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: placeholderDoc('原文', null) }),
    file: { id: 20, revision: 5, draft: draft({ content_doc: placeholderDoc('原文', null) }) },
    transport: transport,
  })
  // 会话 B：已有较新输入 → 只应用窄 op，整篇不被回填。
  store.openSession({
    sessionId: 'busy', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: placeholderDoc('原文', null) }),
    file: { id: 21, revision: 5, draft: draft({ content_doc: placeholderDoc('原文', null) }) },
    transport: transport,
  })
  store.changeSession('busy', draft({ content_doc: placeholderDoc('原文 + 用户续写', null) }), 'user_input')

  const serverDocA = placeholderDoc('原文', 'AI 回复 A')
  /** 服务器快照只到上次保存的内容，不含用户这次的新输入。 */
  const serverDocB = placeholderDoc('原文', 'AI 回复 B')
  const mutation: FileMutation = {
    files: [
      { type: 'journal', file: serverFile(20, 6, draft({ content_doc: serverDocA })) },
      { type: 'journal', file: serverFile(21, 6, draft({ content_doc: serverDocB })) },
    ],
    effects: [
      { type: 'journal', id: 20, base_revision: 5, revision: 6, ops: [{ kind: 'replace_placeholder', node_id: 'ph-1' }] },
      { type: 'journal', id: 21, base_revision: 5, revision: 6, ops: [{ kind: 'replace_placeholder', node_id: 'ph-1' }] },
    ],
  }
  const summary = store.applyFileMutation(mutation)
  expectEqual(summary.applied.length, 2, '两个会话都收到受控变化')
  expectEqual(summary.conflicts.length, 0, '没有版本冲突')

  const idleSession = store.getSession('idle')!
  expectEqual(idleSession.revision, 6, '无新输入的会话版本推进')
  expectEqual(idleSession.draft.content_doc, serverDocA, '无新输入的会话采用服务器内容')
  expectEqual(idleSession.status, 'saved', '无新输入的会话回到已保存')

  const busySession = store.getSession('busy')!
  expectEqual(busySession.revision, 6, '有续写的会话版本也推进')
  expectEqual(busySession.status, 'unsaved', '续写仍需提交')
  const busyNodes = (busySession.draft.content_doc as { content: { type: string }[] }).content
  check(busyNodes.some((node) => node.type === 'aiReply'), '窄 op 把 AI 回复插回本地文档')
  check(!busyNodes.some((node) => node.type === 'aiPlaceholder'), '占位节点被同 id 的回复替换')
  check(
    JSON.stringify(busySession.draft.content_doc).includes('原文 + 用户续写'),
    '窄 op 不覆盖用户续写内容',
  )

  // base_revision 对不上：未知差异 → 冲突，双方内容保留。
  const stale = store.applyFileMutation({
    files: [{ type: 'journal', file: serverFile(20, 9, draft({ content_doc: doc('服务器又变了') })) }],
    effects: [{ type: 'journal', id: 20, base_revision: 8, revision: 9, ops: [] }],
  })
  expectEqual(stale.conflicts.length, 1, 'base_revision 不符判为冲突')
  expectEqual(store.getSession('idle')!.status, 'conflict', '冲突状态可见')
  expectEqual(store.getSession('idle')!.draft.content_doc, serverDocA, '冲突不覆盖本地内容')

  // 未识别 op 必须保留草稿并进入冲突，不能抬版本后覆盖服务器变化。
  store.resolveTakeServer('idle', { id: 20, revision: 6, draft: draft({ content_doc: serverDocA }) })
  store.changeSession('idle', draft({ content_doc: placeholderDoc('再写一点', null) }), 'user_input')
  const unknownOp = store.applyFileMutation({
    files: [{ type: 'journal', file: serverFile(20, 7, draft({ content_doc: placeholderDoc('再写一点', 'AI 2') })) }],
    effects: [{ type: 'journal', id: 20, base_revision: 6, revision: 7, ops: [{ kind: 'mind_comment_marks' }] }],
  })
  expectEqual(unknownOp.conflicts.length, 1, '未识别 op 应进入冲突')
  expectEqual(store.getSession('idle')!.revision, 6, '未识别 op 不推进基线版本')
  expectEqual(store.getSession('idle')!.status, 'conflict', '未识别 op 禁止静默保存')
  expectEqual(store.getSession('idle')!.draft.content_doc, placeholderDoc('再写一点', null), '未识别 op 不改内容')

  const reviewDoc = (text: string, answer: string) => ({ type: 'doc', content: [{ type: 'goalReview',
    attrs: { id: 'review-1', link_id: 'link-1', goal_snapshot: text, checked_snapshot: false, review_title: text },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: answer }] }] }] })
  const baseline = draft({ content_doc: reviewDoc('旧目标', '已保存回答') })
  store.openSession({ sessionId: 'review', type: 'journal', tabId: 'tab-1', draft: baseline,
    file: { id: 22, revision: 1, draft: baseline }, transport })
  store.changeSession('review', draft({ content_doc: reviewDoc('旧目标', '正在输入的回答') }), 'user_input')
  const synced = store.applyFileMutation({
    files: [{ type: 'journal', file: serverFile(22, 2, draft({ content_doc: reviewDoc('新目标', '已保存回答') })) }],
    effects: [{ type: 'journal', id: 22, base_revision: 1, revision: 2,
      ops: [{ kind: 'goal_fields', node_id: 'review-1' }] }],
  })
  expectEqual(synced.conflicts.length, 0, '回答编辑期间允许合并目标系统字段')
  expectEqual(store.getSession('review')!.draft.content_doc, reviewDoc('新目标', '正在输入的回答'), '目标同步保留未保存回答')
  const beforeConflict = store.getSession('review')!.draft
  const unexpectedDoc = reviewDoc('又改目标', '服务器另改回答')
  const unsafe = store.applyFileMutation({
    files: [{ type: 'journal', file: serverFile(22, 3, draft({ content_doc: unexpectedDoc })) }],
    effects: [{ type: 'journal', id: 22, base_revision: 2, revision: 3,
      ops: [{ kind: 'goal_fields', node_id: 'review-1' }] }],
  })
  expectEqual(unsafe.conflicts.length, 1, '未声明的服务器回答变化应冲突')
  expectEqual(store.getSession('review')!.revision, 2, '未知差异不能推进版本')
  expectEqual(store.getSession('review')!.draft, beforeConflict, '冲突保留整个未保存草稿')

  const racing = manualTransport()
  const concurrent = createEditSessionStore()
  const original = draft({ content_doc: doc('原文') })
  concurrent.openSession({ sessionId: 'flight', type: 'journal', tabId: 'tab', draft: original,
    file: { id: 23, revision: 1, draft: original }, transport: racing.transport })
  const pendingDraft = draft({ content_doc: doc('用户在途输入') })
  concurrent.changeSession('flight', pendingDraft, 'user_input')
  const saving = concurrent.saveToSequence('flight')
  await flushMicrotasks()
  const inFlightResult = concurrent.applyFileMutation({ files: [
    { type: 'journal', file: serverFile(23, 2, draft({ content_doc: doc('服务器变化') })) }],
    effects: [{ type: 'journal', id: 23, base_revision: 1, revision: 2, ops: [{ kind: 'goal_fields', node_id: 'p-1' }] }] })
  expectEqual(inFlightResult.conflicts.length, 1, '在途保存遇到外部变化必须冲突')
  expectEqual(concurrent.getSession('flight')!.draft, pendingDraft, '在途用户输入保留')
  racing.calls[0].reply.resolve(serverFile(23, 2, pendingDraft))
  await saving
  expectEqual(concurrent.getSession('flight')!.status, 'conflict', '迟到的保存响应不能清除冲突')
  expectEqual(concurrent.getSession('flight')!.draft, pendingDraft, '迟到响应不能覆盖草稿')
}

/* -------------------------------------------------------- 9. 多文件命令 */

async function testRunFileCommand(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1',
    draft: draft({ content_doc: doc('基线') }),
    file: { id: 30, revision: 2, draft: draft({ content_doc: doc('基线') }) },
    transport: transport,
  })
  store.changeSession('s1', draft({ content_doc: doc('命令前输入') }), 'user_input')

  let commandRan = 0
  const command = store.runFileCommand('s1', async () => {
    commandRan += 1
    expectEqual(calls.length, 1, '命令前先落库到当前序号')
    expectEqual(store.getSession('s1')!.revision, 3, '命令执行时最新输入已落到服务器')
    return {
      files: [{ type: 'journal', file: serverFile(30, 4, draft({ content_doc: doc('命令后') })) }],
      effects: [{ type: 'journal', id: 30, base_revision: 3, revision: 4, ops: [] }],
    } satisfies FileMutation
  }, ['insight:2', 'journal:30'])

  await flushMicrotasks()
  expectEqual(calls.length, 1, '命令前发出一次 PATCH')
  calls[0].reply.resolve(serverFile(30, 3, draft({ content_doc: doc('命令前输入') })))
  await command
  expectEqual(commandRan, 1, '落库之后才执行命令')
  expectEqual(store.getSession('s1')!.revision, 4, '命令返回的版本已应用到会话')
  expectEqual(store.getSession('s1')!.draft.content_doc, doc('命令后'), '命令结果已应用')
}

/* -------------------------------------------------- 10. 排序与失败语义 */

{
  expectEqual(
    sortQueueKeys(['journal:12', 'insight:3', 'journal:2', 'insight:3', 'draft:z']),
    ['draft:z', 'insight:3', 'journal:2', 'journal:12'],
    '关联队列按 typed key 稳定排序并去重',
  )
  expectEqual(fileKey('insight', 5), 'insight:5', 'typed key 形状')
}

{
  // 纯函数层：迟到序号不会改动会话。
  const session: EditSession = createSession({
    sessionId: 'x', type: 'journal', tabId: 't', draft: draft(), transport: manualTransport().transport,
  })
  const changed = applyChange(session, draft({ content_doc: doc('输入') }), 'user_input')
  const decision = planWrite(changed)
  expectEqual(decision.kind, 'create', '未取得身份且有输入 → 创建')
  const inFlight = settleWrite({ ...changed, inFlight: { seq: 99, draft: changed.draft } }, 1, {
    kind: 'ok', file: serverFile(1, 1, changed.draft),
  })
  expectEqual(inFlight.inFlight?.seq, 99, '序号不匹配的结算被忽略')
  expectEqual(inFlight.fileId, null, '迟到结算不改身份')
}

{
  // 业务判定注入：不满足可提交条件时停在 invalid，不发请求。
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession({
    sessionId: 's1', type: 'journal', tabId: 'tab-1', draft: draft(),
    transport: transport, isSavable: () => false,
  })
  store.changeSession('s1', draft({ content_doc: doc('x') }), 'user_input')
  const blocked = await store.saveToSequence('s1')
  expectEqual(blocked, { kind: 'blocked', reason: 'invalid' }, '不可提交时不发请求')
  expectEqual(calls.length, 0, '不可提交时零请求')
}

{
  // IME 组合期间不提交半个拼音。
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  openNew(store, transport)
  store.changeSession('s1', draft({ content_doc: doc('ni') }), 'user_input')
  store.setComposing('s1', true)
  const blocked = await store.saveToSequence('s1')
  expectEqual(blocked, { kind: 'blocked', reason: 'ime' }, 'IME 组合期间不提交')
  expectEqual(calls.length, 0, 'IME 组合期间零请求')
  store.setComposing('s1', false)
  const saving = store.saveToSequence('s1')
  await flushMicrotasks()
  expectEqual(calls.length, 1, '组合结束后立即可以提交')
  calls[0].reply.resolve(serverFile(1, 1, draft({ content_doc: doc('ni') })))
  await saving
}

/* --------------------------- 12. T02 恢复入口：已存首次请求重放（S04-T06） */

const RECORD_KEY = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** 记录里冻结的原首次 payload 与会话里较新的输入刻意不同。 */
function restoredInput(overrides: Partial<OpenSessionInput> = {}): OpenSessionInput {
  return {
    sessionId: 'draft-restore',
    type: 'journal',
    tabId: 'tab-1',
    draftId: 'draft-restore',
    draft: draft({ title: '较新标题', content_doc: doc('较新内容') }),
    transport: manualTransport().transport,
    createKey: RECORD_KEY,
    firstRequest: {
      client_create_id: RECORD_KEY,
      draft: draft({ title: '首次标题', content_doc: doc('首次内容') }),
      extras: { journal_kind: 'writing' },
      seq: 2,
    },
    resumedInputSeq: 5,
    ...overrides,
  }
}

function restoreRejection(input: OpenSessionInput): string {
  try {
    createSession(input)
    return 'none'
  } catch (error: unknown) {
    return error instanceof EditSessionRestoreError ? error.reason : 'other'
  }
}

{
  const restored = createSession(restoredInput())
  expectEqual(restored.createKey, RECORD_KEY, '恢复会话沿用记录里的创建键')
  expectEqual(restored.firstRequest?.client_create_id, RECORD_KEY, '会话冻结原首次创建键')
  expectEqual(restored.firstRequest?.draft.content_doc, doc('首次内容'), '冻结的是原首次 payload')
  expectEqual(restored.draft.content_doc, doc('较新内容'), '编辑器里是较新的本地内容')
  expectEqual(restored.baseline.content_doc, doc('较新内容'), '新建会话的基线等于打开时的草稿')
  expectEqual(restored.inputSeq, 5, '输入序号续上记录的 input_seq')
  expectEqual(restored.ackedSeq, 0, '恢复时没有任何服务器写入被确认')

  // 关键差异：草稿回到基线时，首次请求仍然优先于「没有变化」。
  const sameAsOriginal = createSession(restoredInput({
    draft: draft({ title: '首次标题', content_doc: doc('首次内容') }),
  }))
  const decision = planWrite(sameAsOriginal)
  check(decision.kind === 'create' && decision.request.client_create_id === RECORD_KEY,
    '草稿等于原 payload 时仍按原键重放，而不是判为无需保存')
}

{
  expectEqual(restoreRejection(restoredInput({ createKey: 'other-key' })), 'key_mismatch',
    '显式传入不同创建键时拒绝恢复')
  expectEqual(restoreRejection(restoredInput({ resumedInputSeq: 1 })), 'stale_seq',
    '首次请求序号超前于恢复现场时拒绝')
  expectEqual(restoreRejection(restoredInput({ resumedInputSeq: -1 })), 'invalid_resume_seq',
    '恢复现场序号非法时拒绝')
  expectEqual(restoreRejection(restoredInput({
    firstRequest: { client_create_id: RECORD_KEY, draft: { title: 1 } as unknown as DocumentDraft, extras: null, seq: 1 },
  })), 'corrupt_request', '载荷不完整时拒绝恢复（不猜默认值）')
  expectEqual(restoreRejection(restoredInput({
    firstRequest: { client_create_id: RECORD_KEY, draft: draft({}), extras: [] as unknown as Record<string, unknown>, seq: 1 },
  })), 'corrupt_request', '附加字段不是对象时拒绝恢复')
  expectEqual(restoreRejection(restoredInput({
    firstRequest: { client_create_id: RECORD_KEY, draft: draft({}), extras: null, seq: 0 } as never,
  })), 'stale_seq', '首次请求序号为 0 时拒绝恢复')
  expectEqual(restoreRejection(restoredInput({
    file: { id: 9, revision: 1, draft: draft() },
  })), 'corrupt_request', '已有服务器身份时拒绝把首次请求挂回去')
}

async function testRestoreReplaysOriginalThenPatches(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  const opened = store.openSession(restoredInput({ transport }))
  expectEqual(opened.inputSeq, 5, '打开后即可继续原来的序号')

  const saving = store.saveToSequence('draft-restore')
  await flushMicrotasks()
  expectEqual(calls.length, 1, '恢复后第一个请求是创建')
  expectEqual(calls[0].kind, 'create', '身份未取得，先创建')
  const create = calls[0].request as CreateRequest
  expectEqual(create.client_create_id, RECORD_KEY, '创建使用原 client_create_id')
  expectEqual(create.draft.content_doc, doc('首次内容'), '创建 body 是原首次 payload')
  expectEqual(create.extras, { journal_kind: 'writing' }, '首次请求的附加字段原样带出')

  calls[0].reply.resolve(serverFile(88, 1, draft({ title: '首次标题', content_doc: doc('首次内容') })))
  await flushMicrotasks()
  expectEqual(calls.length, 2, '创建成功后紧接着用真实版本 PATCH 最新输入')
  const patch = calls[1].request as UpdateRequest
  expectEqual(patch.expected_revision, 1, 'PATCH 使用创建返回的 revision（CAS）')
  expectEqual(patch.draft.content_doc, doc('较新内容'), 'PATCH 提交最新内容')
  expectEqual(store.getSession('draft-restore')?.ackedSeq, 2,
    '创建只确认到原首次请求的序号，不把较新输入算作已保存')

  calls[1].reply.resolve(serverFile(88, 2, draft({ title: '较新标题', content_doc: doc('较新内容') })))
  const result = await saving
  expectEqual(result.kind, 'clean', '创建与补写在一次排空里完成')
  const done = store.getSession('draft-restore')!
  expectEqual(done.status, 'saved', '最终为服务器已保存')
  expectEqual(done.revision, 2, '版本推进到 PATCH 结果')
  expectEqual(done.ackedSeq, 5, 'PATCH 确认后序号才推进到最新输入')
  expectEqual(done.firstRequest, null, '取得身份后清空首次请求')
  expectEqual(done.queueKey, fileKey('journal', 88), '队列键切换为 typed key')
}

async function testRestoreAdoptsPlaceholderOrRefusesBusy(): Promise<void> {
  const { transport } = manualTransport()
  const store = createEditSessionStore()
  // 页面先开了空草稿（新生成创建键），用户随后选择「恢复原请求」。
  store.openSession({
    sessionId: 'draft-restore', type: 'journal', tabId: 'tab-1',
    draftId: 'draft-restore', draft: draft(), transport,
  })
  const adopted = store.openSession(restoredInput({ transport }))
  expectEqual(adopted.createKey, RECORD_KEY, '空白占位会话接手记录的创建键')
  expectEqual(adopted.firstRequest?.client_create_id, RECORD_KEY, '首次请求挂到同一个会话')
  expectEqual(adopted.draft.content_doc, doc('较新内容'), '占位草稿换成记录里的最新内容')
  expectEqual(store.listSessions().length, 1, '整个过程只有一个会话')

  // 已经有用户输入的会话：不允许替换创建键，也不许覆盖现场草稿。
  const busyStore = createEditSessionStore()
  const busyTransport = manualTransport().transport
  busyStore.openSession({
    sessionId: 'draft-restore', type: 'journal', tabId: 'tab-1',
    draftId: 'draft-restore', draft: draft(), transport: busyTransport,
  })
  busyStore.changeSession('draft-restore', draft({ content_doc: doc('用户已经在写') }), 'user_input')
  let reason = 'none'
  try {
    busyStore.openSession(restoredInput({ transport: busyTransport, createKey: 'another-key' }))
  } catch (error: unknown) {
    reason = error instanceof EditSessionRestoreError ? error.reason : 'other'
  }
  expectEqual(reason, 'key_mismatch', '已有输入的会话拒绝换成记录的创建键')
  expectEqual(busyStore.getSession('draft-restore')?.draft.content_doc, doc('用户已经在写'),
    '拒绝时不覆盖用户已经写下的内容')
  expectEqual(busyStore.getSession('draft-restore')?.firstRequest, null, '拒绝时不挂半套首次请求')
}

async function testLateCreateResponseIgnoredAfterRestore(): Promise<void> {
  const { transport, calls } = manualTransport()
  const store = createEditSessionStore()
  store.openSession(restoredInput({ transport }))
  const saving = store.saveToSequence('draft-restore')
  await flushMicrotasks()
  expectEqual(calls.length, 1, '已发出重放创建')

  // 在途期间用户继续写：不能被这条在途响应覆盖。
  store.changeSession('draft-restore', draft({ title: '较新标题', content_doc: doc('更晚的一句') }), 'user_input')

  // 迟到的、序号对不上的旧响应（例如重复投递）直接丢弃。
  const late = settleWrite(store.getSession('draft-restore')!, 1, { kind: 'ok', file: serverFile(99, 9, draft()) })
  expectEqual(late.fileId, null, '旧序号响应不结算身份')
  expectEqual(late.draft.content_doc, doc('更晚的一句'), '旧序号响应不改草稿')

  calls[0].reply.resolve(serverFile(88, 1, draft({ title: '首次标题', content_doc: doc('首次内容') })))
  await flushMicrotasks()
  const firstRound = await saving
  expectEqual(calls.length, 1, '有界屏障：在途期间的新输入不在本轮越界提交')
  expectEqual(firstRound.kind, 'queued', '本轮如实报告还有未提交的新输入')

  // 下一轮排空：用创建返回的真实版本 PATCH 最新输入（同一会话、同一队列）。
  const second = store.saveToSequence('draft-restore')
  await flushMicrotasks()
  expectEqual(calls.length, 2, '第二次排空才发出 PATCH')
  expectEqual((calls[1].request as UpdateRequest).expected_revision, 1, 'PATCH 带真实 revision')
  expectEqual((calls[1].request as UpdateRequest).draft.content_doc, doc('更晚的一句'), 'PATCH 提交最新输入')
  calls[1].reply.resolve(serverFile(88, 2, draft({ title: '较新标题', content_doc: doc('更晚的一句') })))
  const result = await second
  expectEqual(result.kind, 'clean', '在途期间的新输入最终也落地')
  expectEqual(store.getSession('draft-restore')?.draft.content_doc, doc('更晚的一句'), '最新输入没有被回滚')
}

/* --------------------------------------------------- 11. 草稿比较与补丁 */

{
  expectEqual(draftPatch(draft({ title: 'a' }), draft()), { title: 'a' }, '补丁只含变化字段')
  expectEqual(draftPatch(draft({ title: '' }), draft({ title: 'a' })), { title: null }, '清空标题提交 null')
  check(draftEquals(draft(), draft()), '不同引用但内容相同判等')
  check(!draftEquals(draft({ content_doc: doc('a') }), draft({ content_doc: doc('b') })), '内容不同不等')
  expectEqual(localStateLabel('saved'), '本地草稿已保存（仅本机浏览器）', '本地状态文案与服务器保存分开')
  expectEqual(applyNarrowOps(draft(), null, [{ kind: 'replace_placeholder', node_id: 'x' }]).ignored, ['replace_placeholder'], '缺服务器文档时窄 op 忽略')
}

/* ------------------------------------------------------------- 执行异步用例 */

await testCreateReplayAndPatch()
await testNavigateAwayKeepsSaving()
await testLateResponseIgnored()
await testClosedSessionIgnored()
await testCrossFileIsolation()
await testConflictKeepsBothSides()
await testMissingServerKeepsDraft()
await testBoundedSequenceBarrier()
await testRestoreReplaysOriginalThenPatches()
await testRestoreAdoptsPlaceholderOrRefusesBusy()
await testLateCreateResponseIgnoredAfterRestore()
await testApplyMutation()
await testRunFileCommand()

console.log(`editSessions: ${passed} 项通过`)

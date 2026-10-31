/**
 * 受控命令返回的 FileMutation 与「较新草稿」的隔离（API §10、架构 §4）。
 *
 * 受控问题插入 / Set 目标创建（API §4，2026-10-31）在服务端成功后返回
 * `copy_nodes` effect。写入队列只允许两种落法：
 * - 本地没有较新输入 → 整篇采用服务器版本（adopt）；
 * - 本地有较新输入 → **绝不整篇回填**；能窄合并才合并，不能就进冲突并保留草稿。
 *
 * 本文件把这条不变量固定在算法层（不启动浏览器、不连数据库）：
 *
 *   node --experimental-strip-types src/state/controlledMutation.test.ts
 *
 * 说明：当前 `state/narrowOps.ts` 不合并 `copy_nodes`（保守策略，避免在
 * 「服务端把清单拆成两段」这类结构变化上猜位置）。因此「命令在途时继续输入」
 * 的期望结果是**冲突**：服务器已提交、本地草稿完整保留、由用户对照版本处理。
 * 若日后 T02/T09 决定窄合并纯插入，这里只需把该场景的期望改成「合并且不丢字」。
 */

import {
  createEditSessionStore,
  type DocumentDraft,
  type FileMutation,
  type SaveTransport,
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

const PARAGRAPH_ID = '11111111-1111-4111-8111-111111111111'
const QUESTION_ID = '22222222-2222-4222-8222-222222222222'
const ANSWER_ID = '33333333-3333-4333-8333-333333333333'

function paragraph(text: string): Record<string, unknown> {
  return { type: 'paragraph', attrs: { id: PARAGRAPH_ID }, content: [{ type: 'text', text }] }
}

function documentWith(text: string): { type: 'doc'; content: unknown[] } {
  return { type: 'doc', content: [paragraph(text)] }
}

function questionDocument(text: string): { type: 'doc'; content: unknown[] } {
  return {
    type: 'doc',
    content: [
      paragraph(text),
      { type: 'ritualQuestion', attrs: { id: QUESTION_ID, template_question_id: null, question_snapshot: '今天最重要的事？' } },
      { type: 'paragraph', attrs: { id: ANSWER_ID }, content: [] },
    ],
  }
}

function draft(content: unknown): DocumentDraft {
  return { title: '开始今天 2026-10-31', content_doc: content, date: '2026-10-31', folder_id: null }
}

const transport: SaveTransport = {
  async create() { throw new Error('本文件不发起真实创建') },
  async update() { throw new Error('本文件不发起真实保存') },
}

function mutation(base: number, next: number, content: unknown): FileMutation {
  return {
    files: [{ type: 'journal', file: { id: 5, revision: next, draft: draft(content) } }],
    effects: [{
      type: 'journal', id: 5, base_revision: base, revision: next,
      ops: [{ kind: 'copy_nodes', node_id: QUESTION_ID }],
    }],
    request_id: null,
  }
}

function open(store: ReturnType<typeof createEditSessionStore>) {
  return store.openSession({
    sessionId: 'set-5',
    type: 'journal',
    tabId: 'tab-1',
    draft: draft(documentWith('已有正文')),
    transport,
    file: { id: 5, revision: 3, draft: draft(documentWith('已有正文')) },
  })
}

/* ------------------------------------------- 1. 无较新输入：整篇采用 */

{
  const store = createEditSessionStore()
  open(store)
  const summary = store.applyFileMutation(mutation(3, 4, questionDocument('已有正文')))
  const session = store.getSession('set-5')
  check(session !== null, '会话存在')
  expectEqual(summary.conflicts.length, 0, '无较新输入不产生冲突')
  expectEqual(summary.applied[0]?.applied, ['copy_nodes'], '记录受控变化种类')
  expectEqual(session!.revision, 4, '采用服务器版本')
  expectEqual(session!.status, 'saved', '与服务器一致，显示为已保存')
  check(JSON.stringify(session!.draft.content_doc).includes(QUESTION_ID), '插入的问题节点进入本地草稿')
  check(JSON.stringify(session!.draft.content_doc).includes('已有正文'), '原有正文保留')
}

/* ------------------------- 2. 命令在途时继续输入：不得覆盖较新草稿 */

{
  const store = createEditSessionStore()
  open(store)
  store.changeSession('set-5', draft(documentWith('命令期间继续输入')), 'user_input')
  const summary = store.applyFileMutation(mutation(3, 4, questionDocument('已有正文')))
  const session = store.getSession('set-5')!
  expectEqual(summary.conflicts.length, 1, '无法安全合并时记为冲突')
  expectEqual(session.status, 'conflict', '进入冲突而不是假装已应用')
  expectEqual(session.revision, 3, '冲突时不得推进本地基线版本')
  check(JSON.stringify(session.draft.content_doc).includes('命令期间继续输入'), '较新输入逐字保留')
  check(!JSON.stringify(session.draft.content_doc).includes(QUESTION_ID), '不把未合并的服务器节点藏进草稿')
}

/* --------------------------------- 3. base_revision 与本地基线不一致 */

{
  const store = createEditSessionStore()
  open(store)
  const summary = store.applyFileMutation(mutation(1, 2, questionDocument('已有正文')))
  const session = store.getSession('set-5')!
  expectEqual(summary.conflicts.length, 1, '过期 base_revision 记为冲突')
  expectEqual(session.status, 'conflict', '不把过期变化当作已应用')
  expectEqual(session.revision, 3, '本地版本保持不变')
  check(JSON.stringify(session.draft.content_doc).includes('已有正文'), '本地内容保持不变')
}

/* ------------------- 4. 会话不存在时忽略而不是猜测归属（跨文件隔离） */

{
  const store = createEditSessionStore()
  open(store)
  const foreign = mutation(3, 4, questionDocument('已有正文'))
  foreign.effects[0].id = 99
  foreign.files = []
  const summary = store.applyFileMutation(foreign)
  expectEqual(summary.ignoredSessions, ['journal:99'], '没有打开的文件不做任何应用')
  expectEqual(store.getSession('set-5')!.revision, 3, '其他文件的会话不受影响')
}

console.log(`controlledMutation: ${passed} 项检查通过`)

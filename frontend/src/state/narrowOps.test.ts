/**
 * 受控窄变化安全合并的纯逻辑测试（Stage 4 / S04-T09）。
 *
 *   node --experimental-strip-types src/state/narrowOps.test.ts
 *
 * 覆盖 T08 交接的两个缺口：
 * 1. prepare 新占位遇到较新草稿时的纯插入合并（不覆盖用户输入）；
 * 2. comment_marks 的节点级「只增 Mark」接入。
 * 同时回归原有 replace_placeholder / goal_fields 语义。
 */

import {
  findNodeById,
  hasNode,
  mergeNarrowOps,
  nodeText,
  stripCommentMarks,
  type NarrowDraft,
} from './narrowOps.ts'

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

const PH = '11111111-1111-4111-8111-111111111111'
const CONT = '22222222-2222-4222-8222-222222222222'
const REPLY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function text(value: string, marks?: unknown[]): Record<string, unknown> {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks }
}

function paragraph(id: string, value: string, marks?: unknown[]): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id },
    content: value === '' ? [] : [text(value, marks)],
  }
}

function placeholder(id: string, requestId?: string): Record<string, unknown> {
  return {
    type: 'aiPlaceholder',
    attrs: { id, request_id: requestId ?? '33333333-3333-4333-8333-333333333333' },
  }
}

function reply(id: string, value: string): Record<string, unknown> {
  return {
    type: 'aiReply',
    attrs: { id, request_id: '33333333-3333-4333-8333-333333333333' },
    content: [paragraph(`${id}-p`, value)],
  }
}

function doc(...nodes: unknown[]): Record<string, unknown> {
  return { type: 'doc', content: nodes }
}

function draft(content: unknown, title = '标题'): NarrowDraft {
  return { title, content_doc: content, date: '2026-10-30', folder_id: null }
}

function ids(content: unknown): string[] {
  const nodes = (content as { content?: unknown[] }).content ?? []
  return nodes.map((node) => {
    const attrs = (node as { attrs?: { id?: string } }).attrs
    return attrs?.id ?? '?'
  })
}

/* --------------------- 1. prepare 新占位 + 较新草稿：纯插入，不覆盖输入 */

{
  const baseline = draft(doc(paragraph('p1', '第一段')))
  const server = draft(doc(paragraph('p1', '第一段'), placeholder(PH), paragraph(CONT, '')))
  const local = draft(doc(paragraph('p1', '第一段'), paragraph('p2', '用户刚续写的一段')))

  const result = mergeNarrowOps(local, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(result.applied, ['replace_placeholder'], '新占位被安全合并')
  expectEqual(result.ignored, [], '不判冲突')
  expectEqual(ids(result.draft.content_doc), ['p1', PH, CONT, 'p2'],
    '占位插在旧内容之后、用户新段落之前，用户内容原样保留')
  expectEqual(nodeText(findNodeById(result.draft.content_doc, 'p2')), '用户刚续写的一段',
    '用户新写的段落逐字保留')
  expectEqual(result.draft.title, '标题', '标题不受影响')

  // 会话核心的不变量：对基线应用同一批 ops 必须精确等于服务器文档。
  const baselineResult = mergeNarrowOps(baseline, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(baselineResult.draft.content_doc, server.content_doc, '基线 + ops 精确等于服务器文档')

  // 幂等：同一批 ops 再来一次，本地已有该节点，行为退化为原位替换而不是再插一份。
  const again = mergeNarrowOps(result.draft, server, [{ kind: 'replace_placeholder', node_id: PH }], server)
  expectEqual(ids(again.draft.content_doc), ['p1', PH, CONT, 'p2'], '重复应用不会插入第二份占位')
}

/* ------------------------------- 2. 已有占位 → 回复：原位替换，保留续写 */

{
  const baseline = draft(doc(paragraph('p1', '第一段'), placeholder(PH), paragraph(CONT, '')))
  // 后端 apply 保留占位节点自己的 ID，只把类型换成 aiReply（`apply_ai_placeholder`）。
  const server = draft(doc(paragraph('p1', '第一段'), reply(PH, 'AI 的回复'), paragraph(CONT, '')))
  const local = draft(doc(
    paragraph('p1', '第一段'),
    placeholder(PH),
    paragraph(CONT, ''),
    paragraph('p3', '调用期间又写的一段'),
  ))
  const result = mergeNarrowOps(local, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(result.applied, ['replace_placeholder'], '占位被替换为回复')
  expectEqual(ids(result.draft.content_doc), ['p1', PH, CONT, 'p3'], '回复原位、续写在后')
  expectEqual(nodeText(findNodeById(result.draft.content_doc, 'p3')), '调用期间又写的一段', '续写不丢')

  const baselineResult = mergeNarrowOps(baseline, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(baselineResult.draft.content_doc, server.content_doc, '基线 + ops 精确等于服务器文档')
}

/* --------------------------- 3. 占位所属锚点已被删改：拒绝而不是猜位置 */

{
  const baseline = draft(doc(paragraph('p1', '第一段')))
  const server = draft(doc(paragraph('p1', '第一段'), placeholder(PH), paragraph(CONT, '')))
  // 用户把 p1 整段删了，只留下自己新写的段落。
  const local = draft(doc(paragraph('p9', '完全另起的内容')))
  const result = mergeNarrowOps(local, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(result.applied, [], '锚点丢失时不插入')
  expectEqual(result.ignored, ['replace_placeholder'], '计入 ignored，交由会话判冲突并保留草稿')
  expectEqual(result.draft.content_doc, local.content_doc, '本地草稿一字未改')
}

/* ------------------------------------- 4. 位置冲突 / 未识别 op 一律保守 */

{
  const baseline = draft(doc(paragraph('p1', '第一段')))
  const server = draft(doc(paragraph('p1', '第一段'), placeholder(PH), paragraph(CONT, '')))
  // 本地已经出现同 ID 的节点（例如另一个标签已经合并过）：不再插入。
  const local = draft(doc(paragraph('p1', '第一段'), paragraph(PH, 'user 自己也用了这个 id')))
  const result = mergeNarrowOps(local, server, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(result.ignored, ['replace_placeholder'], '同 ID 节点已存在时不插入第二份')

  const unknown = mergeNarrowOps(local, server, [{ kind: 'copy_nodes' }], baseline)
  expectEqual(unknown.ignored, ['copy_nodes'], '未识别 op 计入 ignored')

  const noServer = mergeNarrowOps(local, null, [{ kind: 'replace_placeholder', node_id: PH }], baseline)
  expectEqual(noServer.ignored, ['replace_placeholder'], '没有服务器文档时不猜')
}

/* ------------------------------- 5. comment_marks：只增 Mark，不改用户文字 */

{
  const commentMark = { type: 'mindComment', attrs: { comment_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] } }
  const baseline = draft(doc(paragraph('p1', '今天很累'), paragraph('p2', '但还好')))
  const server = draft(doc(paragraph('p1', '今天很累', [commentMark]), paragraph('p2', '但还好')))
  const local = draft(doc(paragraph('p1', '今天很累'), paragraph('p2', '但还好'), paragraph('p3', '新写的')))

  const result = mergeNarrowOps(local, server, [{ kind: 'comment_marks' }], baseline)
  expectEqual(result.applied, ['comment_marks'], '评论 Mark 已接入会话')
  expectEqual(result.warnings, [], '内容未改动，无需提示')
  expectEqual(ids(result.draft.content_doc), ['p1', 'p2', 'p3'], '只加 Mark，不增删节点')
  const marked = findNodeById(result.draft.content_doc, 'p1') as { content: { marks?: unknown[] }[] }
  expectEqual(marked.content[0].marks, [commentMark], '段落上出现评论 Mark')
  expectEqual(nodeText(findNodeById(result.draft.content_doc, 'p3')), '新写的', '用户续写不受影响')

  const baselineResult = mergeNarrowOps(baseline, server, [{ kind: 'comment_marks' }], baseline)
  expectEqual(baselineResult.draft.content_doc, server.content_doc, '基线 + ops 精确等于服务器文档')
}

/* --------------------- 6. comment_marks 遇到已被改写的段落：跳过并提示 */

{
  const commentMark = { type: 'mindComment', attrs: { comment_ids: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] } }
  const baseline = draft(doc(paragraph('p1', '今天很累')))
  const server = draft(doc(paragraph('p1', '今天很累', [commentMark])))
  // 用户在 AI 期间把这段改成了别的内容。
  const local = draft(doc(paragraph('p1', '今天其实还好')))
  const result = mergeNarrowOps(local, server, [{ kind: 'comment_marks' }], baseline)
  expectEqual(result.applied, ['comment_marks'], '仍算已处理（评论保留在侧栏）')
  check(result.warnings.length === 1, '给出「无法挂 Mark」的提示')
  expectEqual(nodeText(findNodeById(result.draft.content_doc, 'p1')), '今天其实还好', '绝不覆盖用户改写')
  const node = findNodeById(result.draft.content_doc, 'p1') as { content: { marks?: unknown[] }[] }
  expectEqual(node.content[0].marks, undefined, '不把 Mark 挂到错误位置')

  // 去掉 Mark 后与服务器一致：确认判据确实是「除 Mark 外完全相同」。
  expectEqual(stripCommentMarks(server.content_doc), baseline.content_doc, 'stripCommentMarks 口径正确')
}

/* --------------------------------- 7. goal_fields 语义保持不变（回归） */

{
  const goal = (id: string, text: string, checked: boolean) => ({
    type: 'goalReview',
    attrs: { id, link_id: null, goal_snapshot: '目标', checked_snapshot: checked, review_title: `回顾：${text}` },
    content: [paragraph(`${id}-a`, '我的回答')],
  })
  const baseline = draft(doc(goal('g1', '读书', false)))
  const server = draft(doc(goal('g1', '读书', true)))
  const local = draft(doc(goal('g1', '读书', false)))

  const applied = mergeNarrowOps(local, server, [{ kind: 'goal_fields', node_id: 'g1' }], baseline)
  expectEqual(applied.applied, ['goal_fields'], '目标镜像字段可同步')
  const node = findNodeById(applied.draft.content_doc, 'g1') as { attrs: { checked_snapshot: boolean } }
  expectEqual(node.attrs.checked_snapshot, true, '镜像 checked 更新')

  // 本地已改过该节点（attrs 与基线不同）：不合并，交给用户处理。
  const editedLocal = draft(doc({ ...goal('g1', '读书', true), attrs: {
    id: 'g1', link_id: null, goal_snapshot: '目标', checked_snapshot: false, review_title: '回顾：我改过',
  } }))
  const refused = mergeNarrowOps(editedLocal, server, [{ kind: 'goal_fields', node_id: 'g1' }], baseline)
  expectEqual(refused.ignored, ['goal_fields'], '本地已改动时不静默覆盖')
}

/* ----------------------------------------------- 8. 辅助判定 */

{
  const content = doc(paragraph('p1', 'x'), placeholder(PH))
  check(hasNode(draft(content), PH), 'hasNode 能定位占位节点')
  check(!hasNode(draft(content), REPLY), 'hasNode 对不存在的节点返回 false')
}

console.log(`narrowOps: ${passed} 项通过`)

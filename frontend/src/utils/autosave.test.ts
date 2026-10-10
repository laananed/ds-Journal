/**
 * 自动保存纯逻辑的最小测试（Stage 3 / S3-T02）。
 *
 * 不引入测试框架：直接用 Node 内置的类型剥离运行本文件——
 *
 *   node --experimental-strip-types src/utils/autosave.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，也能被 `tsc -b` 检查。
 *
 * 反例覆盖 `docs/stage3-tasks.md` §4 与本轮提示词的验收点：
 * 草稿序号、单请求队列、乱序响应、创建后切换身份、失败不自动重试、
 * 两标签 409 冲突、空白/超长不提交、flush 决策。
 */

import {
  adoptServer,
  applyInput,
  beginSend,
  clearFailure,
  createAutosaveCore,
  displayStatus,
  draftProjection,
  draftToSnapshot,
  isCoreSavable,
  isSavable,
  isSnapshotSavable,
  isSnapshotPatchEmpty,
  isUpdateSavable,
  planSave,
  rebaseRevision,
  settle,
  snapshotEquals,
  snapshotPatch,
  statusLabel,
  type AutosaveCore,
  type DraftSnapshot,
  type SaveRequest,
} from './autosave.ts'
import type { Block } from '../types/writing.ts'

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

const BASE: DraftSnapshot = { title: '', content: '原始正文', date: '2026-10-10', folder_id: null }

function snapshot(overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return { ...BASE, ...overrides }
}

function existing(): AutosaveCore {
  return createAutosaveCore({ draft: BASE, createKey: 'key-1', file: { id: 7, revision: 3 } })
}

function fresh(): AutosaveCore {
  return createAutosaveCore({ draft: snapshot({ content: '' }), createKey: 'key-1', file: null })
}

function sendOf(core: AutosaveCore, savable = true): SaveRequest {
  const decision = planSave(core, savable)
  if (decision.kind !== 'send') throw new Error(`期望 send，实际 ${decision.kind}`)
  return decision.request
}

// ---------------------------------------------------------------------------
// 1. 初始状态与草稿序号
// ---------------------------------------------------------------------------
check(snapshotEquals(BASE, snapshot()), '相同快照判等')
check(!snapshotEquals(BASE, snapshot({ content: 'x' })), '正文变化不等')
check(!snapshotEquals(BASE, snapshot({ folder_id: 2 })), 'Folder 变化不等')
check(!snapshotEquals(BASE, snapshot({ date: '2026-10-11' })), '日期变化不等')

{
  const core = existing()
  check(core.status === 'saved', '初始为已保存')
  check(core.inputSeq === 0 && core.ackedSeq === 0, '初始序号为 0')
  check(planSave(core, true).kind === 'none', '没有输入时不提交')
}

{
  const core = applyInput(existing(), snapshot({ content: '原始正文2' }))
  check(core.inputSeq === 1, '一次输入序号 +1')
  check(core.status === 'unsaved', '有未保存输入')
  const again = applyInput(core, snapshot({ content: '原始正文2' }))
  check(again.inputSeq === 1, '相同输入不重复递增序号')
}

// ---------------------------------------------------------------------------
// 2. 单请求队列：在途时不再发第二个请求
// ---------------------------------------------------------------------------
{
  let core = applyInput(existing(), snapshot({ content: '改了' }))
  const request = sendOf(core)
  check(request.kind === 'update', '已有文件走 PATCH')
  check(request.kind === 'update' && request.expectedRevision === 3, 'PATCH 带 expected_revision')
  check(request.seq === 1, '请求携带提交时的输入序号')

  core = beginSend(core, request)
  check(core.status === 'saving', '发请求后为保存中')
  check(planSave(core, true).kind === 'wait', '单请求队列：在途时等待')

  // 在途期间继续输入：旧响应不得覆盖新输入。
  const newer = applyInput(core, snapshot({ content: '又改了' }))
  check(newer.status === 'saving', '在途期间继续输入仍是保存中')
  check(planSave(newer, true).kind === 'wait', '在途期间不排队第二个请求')
  check(newer.draft.content === '又改了', '新输入保留在草稿里')
}

// ---------------------------------------------------------------------------
// 3. 乱序 / 迟到响应
// ---------------------------------------------------------------------------
{
  let core = applyInput(existing(), snapshot({ content: '改了' }))
  core = beginSend(core, sendOf(core))
  const stale = settle(core, 99, { kind: 'ok', fileId: 7, revision: 4 })
  check(stale === core, '序号不匹配的迟到响应被忽略')
}

// ---------------------------------------------------------------------------
// 4. 成功只确认对应快照，不覆盖后来输入
// ---------------------------------------------------------------------------
{
  let core = applyInput(existing(), snapshot({ content: '第一次' }))
  core = beginSend(core, sendOf(core))
  core = applyInput(core, snapshot({ content: '第一次+后续' }))
  core = settle(core, 1, { kind: 'ok', fileId: 7, revision: 4 })

  expectEqual(core.baseline, snapshot({ content: '第一次' }), '基线与提交快照一致')
  check(core.draft.content === '第一次+后续', '较新草稿未被旧响应覆盖')
  check(core.status === 'unsaved', '仍有较新输入 → 未保存')
  check(core.ackedSeq === 1, '已确认序号推进')
  check(core.revision === 4, '版本由响应推进')

  const next = sendOf(core)
  check(next.kind === 'update' && next.expectedRevision === 4, '下一次用最新版本 PATCH')
}

// ---------------------------------------------------------------------------
// 5. 首次创建：稳定 client_create_id，成功后切换为 PATCH
// ---------------------------------------------------------------------------
{
  let core = applyInput(fresh(), snapshot({ content: '第一篇' }))
  const first = sendOf(core)
  check(first.kind === 'create', '新草稿走 POST')
  check(first.kind === 'create' && first.createKey === 'key-1', 'POST 携带稳定创建键')
  check(core.fileId === null && core.revision === null, '创建前没有身份')

  core = beginSend(core, first)
  // 首次创建失败：保留草稿与创建键，停止自动重试。
  core = settle(core, first.seq, { kind: 'error', message: '网络失败' })
  check(core.status === 'failed', '失败状态')
  expectEqual(core.draft, snapshot({ content: '第一篇' }), '失败保留草稿')
  check(core.fileId === null, '失败后仍是未创建')
  check(core.createKey === 'key-1', '失败复用同一创建键')
  const blocked = planSave(core, true)
  check(blocked.kind === 'blocked' && blocked.reason === 'failed', '失败后不再自动重试')

  // 用户显式重试：仍用首次创建键。
  const retryRequest = sendOf(clearFailure(core))
  check(retryRequest.kind === 'create' && retryRequest.createKey === 'key-1', '重试仍是同一键 POST')
  const retried = beginSend(clearFailure(core), retryRequest)

  // 创建成功但响应丢失 → 重放：换身份、不重复 POST。
  const created = settle(retried, retryRequest.seq, { kind: 'ok', fileId: 21, revision: 1 })
  check(created.fileId === 21 && created.revision === 1, '创建成功获得身份')
  check(created.status === 'saved', '创建成功后已保存')

  const followUp = applyInput(created, snapshot({ content: '第一篇 追加' }))
  const second = sendOf(followUp)
  check(second.kind === 'update', '成功后较新草稿走 PATCH')
  check(second.kind === 'update' && second.fileId === 21, 'PATCH 指向新建文件')
  check(second.kind === 'update' && second.expectedRevision === 1, 'PATCH 用创建返回的版本')
}

// ---------------------------------------------------------------------------
// 6. 两标签 409 冲突：保留草稿与服务器状态，不自动覆盖
// ---------------------------------------------------------------------------
{
  let core = applyInput(existing(), snapshot({ content: '我的改动' }))
  core = beginSend(core, sendOf(core))
  core = settle(core, 1, { kind: 'conflict', message: '版本已变化' })

  check(core.status === 'conflict', '冲突状态')
  check(core.error === '版本已变化', '保留冲突说明')
  check(core.draft.content === '我的改动', '冲突保留本地草稿')
  expectEqual(core.baseline, BASE, '冲突不改写服务器基线')
  check(core.revision === 3, '冲突不推进版本')
  const decision = planSave(core, true)
  check(decision.kind === 'blocked' && decision.reason === 'conflict', '冲突不自动覆盖')

  // 用户显式选择“以我的草稿重试”：先刷新到服务器最新版本再提交。
  const rebased = rebaseRevision(core, 7, 5)
  check(rebased.status === 'unsaved', '刷新版本后可再次保存')
  check(rebased.draft.content === '我的改动', '刷新版本保留草稿')
  const retry = planSave(rebased, true)
  check(retry.kind === 'send' && retry.request.kind === 'update' && retry.request.expectedRevision === 5,
    '刷新版本后按新版本提交')
}

// ---------------------------------------------------------------------------
// 7. 空白 / 超长输入不提交，也不创建空文件
// ---------------------------------------------------------------------------
{
  check(!isSnapshotSavable(snapshot({ content: '' })), '空正文不提交')
  check(!isSnapshotSavable(snapshot({ content: '   \n\t ' })), '纯空白不提交')
  check(isSnapshotSavable(snapshot({ content: '正文' })), '有效正文可提交')
  check(!isSnapshotSavable(snapshot({ content: 'a'.repeat(50_001) })), '超长正文不提交')
  check(!isSnapshotSavable(snapshot({ title: 't'.repeat(81), content: '正文' })), '超长标题不提交')
  check(isSnapshotSavable(snapshot({ title: '🧭'.repeat(80), content: '正文' })), 'emoji 标题按码点计数')

  const core = applyInput(fresh(), snapshot({ content: '   ' }))
  const decision = planSave(core, isSnapshotSavable(core.draft))
  check(decision.kind === 'blocked' && decision.reason === 'invalid', '空白草稿不发送')
}

// ---------------------------------------------------------------------------
// 8. flush 决策：干净→可离开，脏→先保存，失败/冲突→停留
// ---------------------------------------------------------------------------
{
  check(planSave(existing(), true).kind === 'none', '干净时无需 flush 写入')

  const dirty = applyInput(existing(), snapshot({ content: '改动' }))
  const decision = planSave(dirty, true)
  check(decision.kind === 'send', '脏时 flush 会提交')

  const failed = settle(beginSend(dirty, sendOf(dirty)), dirty.inputSeq, { kind: 'error', message: '失败' })
  const blocked = planSave(failed, true)
  check(blocked.kind === 'blocked' && blocked.reason === 'failed', '失败时 flush 停留')

  const conflicted = settle(beginSend(dirty, sendOf(dirty)), dirty.inputSeq, { kind: 'conflict', message: '冲突' })
  const conflictBlocked = planSave(conflicted, true)
  check(conflictBlocked.kind === 'blocked' && conflictBlocked.reason === 'conflict', '冲突时 flush 停留')
}

// ---------------------------------------------------------------------------
// 9. 采用服务器版本（冲突时用户选择“重新载入”）
// ---------------------------------------------------------------------------
{
  let core = applyInput(existing(), snapshot({ content: '我的改动' }))
  core = settle(beginSend(core, sendOf(core)), core.inputSeq, { kind: 'conflict', message: '冲突' })
  const adopted = adoptServer(core, { id: 7, revision: 9 }, snapshot({ content: '服务器版本' }))
  check(adopted.status === 'saved', '采用服务器版本后为已保存')
  check(adopted.draft.content === '服务器版本', '草稿换成服务器内容')
  check(adopted.revision === 9, '版本换成服务器版本')
  check(planSave(adopted, true).kind === 'none', '采用服务器版本后无需提交')
  check(adopted.inputSeq === core.inputSeq, '采用服务器版本沿用输入序号计数')
}

// ---------------------------------------------------------------------------
// 10. 快照转换：三类文件共用同一份草稿形状
// ---------------------------------------------------------------------------
{
  const fromJournal = draftToSnapshot({ title: '标题', content: '正文', folder_id: 4 }, '2026-10-10')
  expectEqual(fromJournal, { title: '标题', content: '正文', date: '2026-10-10', folder_id: 4 }, 'Journal 快照')

  const fromInbox = draftToSnapshot({ title: '', content: '正文', folder_id: null }, '2026-10-09')
  expectEqual(fromInbox, { title: '', content: '正文', date: '2026-10-09', folder_id: null }, 'Inbox 快照')

  const fromInsight = draftToSnapshot({ title: 'x', content: 'y', folder_id: 2 }, '')
  expectEqual(fromInsight, { title: 'x', content: 'y', date: '', folder_id: 2 }, 'Insight 快照')
}

// ---------------------------------------------------------------------------
// 11. PATCH 补丁只包含真正变化的字段
// ---------------------------------------------------------------------------
{
  expectEqual(snapshotPatch(snapshot(), BASE), {}, '没有变化时补丁为空')
  expectEqual(snapshotPatch(snapshot({ title: '新标题' }), BASE), { title: '新标题' }, '只改标题')
  expectEqual(snapshotPatch(snapshot({ title: '' }), snapshot({ title: '旧标题' })), { title: null }, '清空标题提交 null')
  expectEqual(snapshotPatch(snapshot({ content: '旧超长正文' + 'a', folder_id: 3 }), snapshot({ content: '旧超长正文' })),
    { content: '旧超长正文' + 'a', folder_id: 3 }, '正文与 Folder 变化')
  check(isSnapshotPatchEmpty(snapshotPatch(snapshot(), BASE)), '空补丁判定')
  // 旧超长正文只改标题：补丁里不能出现 content，避免重新校验旧正文。
  const legacyBaseline = snapshot({ content: 'a'.repeat(60_000), title: '旧' })
  expectEqual(snapshotPatch(snapshot({ ...legacyBaseline, title: '新' }), legacyBaseline), { title: '新' },
    '旧超长正文只改标题不会带上 content')
}

// ---------------------------------------------------------------------------
// 12. 状态文案（产品 §2 的五种显示）
// ---------------------------------------------------------------------------
{
  expectEqual(statusLabel('saved'), '已保存', '已保存文案')
  expectEqual(statusLabel('saving'), '保存中……', '保存中文案')
  expectEqual(statusLabel('unsaved'), '未保存', '未保存文案')
  expectEqual(statusLabel('failed'), '保存失败', '失败文案')
  expectEqual(statusLabel('conflict'), '冲突', '冲突文案')

  check(displayStatus(existing()) === 'saved', '干净核心显示已保存')
  check(displayStatus(applyInput(existing(), snapshot({ content: 'x' }))) === 'unsaved', '有输入显示未保存')
  check(displayStatus(settle(beginSend(applyInput(existing(), snapshot({ content: 'x' })), sendOf(applyInput(existing(), snapshot({ content: 'x' })))), 1, { kind: 'conflict', message: 'c' })) === 'conflict',
    '冲突优先显示')
}

// ---------------------------------------------------------------------------
// 13. D-1 回归（RED → 修复后 GREEN）：更新已有文件只校验本次补丁涉及的字段
//
// 契约依据 `docs/stage3-api.md` §2：「只改其他业务字段不重新验证旧正文」。
// 这些断言**先于修复**加入，在修复前必须失败（首次失败记录见
// `.workbuddy/s3-t02/fix-d1-d2/red-autosave-test.log`）。
// ---------------------------------------------------------------------------

/** 收集式断言：一次跑出全部失败项，不因第一条失败就中断，便于记录 RED 全貌。 */
const failures: string[] = []
function expect(condition: boolean, label: string): void {
  if (condition) passed += 1
  else failures.push(label)
}

/** 收集式的深比较，语义同 `expectEqual`，但失败不中断本轮。 */
function expectSnapshotEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  expect(actualText === expectedText, `${label}：期望 ${expectedText}，实际 ${actualText}`)
}

const LEGACY_LONG = snapshot({ title: '旧标题', content: 'a'.repeat(60_000), date: '2026-01-02' })
const LEGACY_LONG_TITLE = snapshot({ title: 't'.repeat(200), content: '旧正文', date: '2026-01-03' })

function updateCore(draft: DraftSnapshot): AutosaveCore {
  return createAutosaveCore({ draft, createKey: 'key-1', file: { id: 9, revision: 1 } })
}

/**
 * 修复后的判定口径：更新已有文件只校验补丁实际提交的字段，创建态仍校验全部字段。
 * hook 里 `savable` / `flush` / `saveNow` / 自动保存都调用同一个 `isCoreSavable`。
 */
function savableOf(core: AutosaveCore): boolean {
  return isCoreSavable(core)
}

// D-1g：口径本身（创建 vs 更新、日期要求）与补丁字段一致
{
  expect(isUpdateSavable(snapshot({ ...LEGACY_LONG, title: '新标题' }), LEGACY_LONG),
    'D-1g 更新口径：旧超长正文仅改标题合法')
  expect(isUpdateSavable(LEGACY_LONG, LEGACY_LONG), 'D-1g 更新口径：没有变化时合法（补丁为空）')
  expect(!isUpdateSavable(snapshot({ ...LEGACY_LONG, content: '  ' }), LEGACY_LONG),
    'D-1g 更新口径：把正文改成空白仍拒绝')
  expect(!isUpdateSavable(snapshot({ ...LEGACY_LONG, content: 'a'.repeat(50_001) }), LEGACY_LONG),
    'D-1g 更新口径：改后正文超限仍拒绝')
  expect(!isSnapshotSavable(LEGACY_LONG), 'D-1g 创建口径：旧超长正文仍不合法（不放宽创建）')

  const emptyDate = snapshot({ title: '', content: '正文', date: '' })
  expect(!isSavable(emptyDate, { baseline: snapshot({ content: '' }), isCreate: true, requireDate: true }),
    'D-1g 创建态要求业务日期')
  expect(isSavable(emptyDate, { baseline: snapshot({ content: '' }), isCreate: true }),
    'D-1g 不要求日期时不额外拦截')
  expect(isSavable(snapshot({ ...LEGACY_LONG, folder_id: 5 }), { baseline: LEGACY_LONG, isCreate: false }),
    'D-1g 更新态只校验补丁字段')
}

// D-1a：旧超长正文，仅改标题
{
  const edited = applyInput(updateCore(LEGACY_LONG), snapshot({ ...LEGACY_LONG, title: '新标题' }))
  expectSnapshotEqual(snapshotPatch(edited.draft, edited.baseline), { title: '新标题' }, 'D-1a 补丁只含改动的标题')
  const decision = planSave(edited, savableOf(edited))
  expect(decision.kind === 'send', 'D-1a 旧超长正文仅改标题应发出 PATCH')
  expect(decision.kind === 'send' && decision.request.kind === 'update'
    && decision.request.expectedRevision === 1, 'D-1a 请求带 expected_revision')
}

// D-1b：旧超长正文，仅改 Folder
{
  const edited = applyInput(updateCore(LEGACY_LONG), snapshot({ ...LEGACY_LONG, folder_id: 5 }))
  expectSnapshotEqual(snapshotPatch(edited.draft, edited.baseline), { folder_id: 5 }, 'D-1b 补丁只含 Folder')
  expect(planSave(edited, savableOf(edited)).kind === 'send', 'D-1b 旧超长正文仅改 Folder 应发出 PATCH')
}

// D-1c：Journal 旧超长正文，仅改日期
{
  const edited = applyInput(updateCore(LEGACY_LONG), snapshot({ ...LEGACY_LONG, date: '2026-01-09' }))
  expectSnapshotEqual(snapshotPatch(edited.draft, edited.baseline), { date: '2026-01-09' }, 'D-1c 补丁只含日期')
  expect(planSave(edited, savableOf(edited)).kind === 'send', 'D-1c 旧超长正文仅改日期应发出 PATCH')
}

// D-1d：旧超长标题不阻止其他合法字段更新
{
  const folderOnly = applyInput(updateCore(LEGACY_LONG_TITLE), snapshot({ ...LEGACY_LONG_TITLE, folder_id: 7 }))
  expect(planSave(folderOnly, savableOf(folderOnly)).kind === 'send', 'D-1d 旧超长标题不阻止改 Folder')
  const contentOnly = applyInput(updateCore(LEGACY_LONG_TITLE), snapshot({ ...LEGACY_LONG_TITLE, content: '新正文' }))
  expect(planSave(contentOnly, savableOf(contentOnly)).kind === 'send', 'D-1d 旧超长标题不阻止改正文')
}

// D-1e：真正被修改的字段仍执行既有长度 / 有效性限制
{
  const blanked = applyInput(updateCore(LEGACY_LONG), snapshot({ ...LEGACY_LONG, content: '   ' }))
  expect(planSave(blanked, savableOf(blanked)).kind === 'blocked', 'D-1e 把正文改成纯空白仍拒绝')
  const tooLong = applyInput(updateCore(LEGACY_LONG), snapshot({ ...LEGACY_LONG, content: 'a'.repeat(50_001) }))
  expect(planSave(tooLong, savableOf(tooLong)).kind === 'blocked', 'D-1e 改后正文超限仍拒绝')
  const titleTooLong = applyInput(
    updateCore(snapshot({ title: '旧', content: '正文' })),
    snapshot({ title: 't'.repeat(81), content: '正文' }),
  )
  expect(planSave(titleTooLong, savableOf(titleTooLong)).kind === 'blocked', 'D-1e 改后标题超限仍拒绝')
}

// D-1f：新建仍校验全部待创建业务字段（不因修复而放宽创建）
{
  const created = applyInput(
    createAutosaveCore({ draft: snapshot({ content: '' }), createKey: 'key-1', file: null }),
    snapshot({ content: 'a'.repeat(60_000) }),
  )
  expect(planSave(created, savableOf(created)).kind === 'blocked', 'D-1f 新建超限正文仍拒绝')
}

// ---------------------------------------------------------------------------
// 14. D-2 回归（RED → 修复后 GREEN）：创建响应丢失 + 继续输入 → 重放首次 payload
//
// 契约依据 `docs/stage3-api.md` §1：同键同 payload 重放回原文件，不同 payload 409。
// ---------------------------------------------------------------------------
{
  const first = snapshot({ title: '第一篇', content: '第一篇', date: '2026-10-10' })
  let core = applyInput(
    createAutosaveCore({ draft: snapshot({ title: '', content: '', date: '2026-10-10' }), createKey: 'key-1', file: null }),
    first,
  )
  const firstRequest = sendOf(core, savableOf(core))
  core = beginSend(core, firstRequest)

  // 失败期间继续输入：只更新最新草稿。
  core = applyInput(core, snapshot({ ...first, content: '第一篇 继续输入' }))
  // 首次 POST 的响应丢失（服务器可能已提交）。
  core = settle(core, firstRequest.seq, { kind: 'error', message: '响应丢失' })
  expect(core.status === 'failed', 'D-2 响应丢失进入失败态')
  expect(core.draft.content === '第一篇 继续输入', 'D-2 失败保留最新草稿')
  expect(core.ackedSeq === 0, 'D-2 较新输入未被提前标记为已保存')
  expect(core.pendingCreate !== null, 'D-2 失败后仍保留首次创建请求')
  expect(core.pendingCreate?.createKey === 'key-1', 'D-2 保留原创建键')
  expect(core.pendingCreate?.seq === firstRequest.seq, 'D-2 保留首次请求序号')
  expectSnapshotEqual(core.pendingCreate?.snapshot, first, 'D-2 保留首次完整业务快照（标题/正文/日期/Folder）')

  const retryRequest = sendOf(clearFailure(core), savableOf(clearFailure(core)))
  expect(retryRequest.kind === 'create', 'D-2 重试仍是创建')
  expect(retryRequest.kind === 'create' && retryRequest.createKey === 'key-1', 'D-2 重试复用首次创建键')
  expectSnapshotEqual(retryRequest.kind === 'create' ? retryRequest.snapshot : null, first,
    'D-2 重试发送首次 payload（不含后续输入）')
}

// D-2b：重放成功后只确认首次快照，较新草稿继续走 PATCH
{
  const first = snapshot({ title: '第一篇', content: '第一篇', date: '2026-10-10' })
  let core = applyInput(
    createAutosaveCore({ draft: snapshot({ title: '', content: '', date: '2026-10-10' }), createKey: 'key-1', file: null }),
    first,
  )
  const firstRequest = sendOf(core, savableOf(core))
  core = beginSend(core, firstRequest)
  core = applyInput(core, snapshot({ ...first, content: '第一篇 继续输入' }))
  core = settle(core, firstRequest.seq, { kind: 'error', message: '响应丢失' })
  const retried = clearFailure(core)
  const retryRequest = sendOf(retried, savableOf(retried))
  const replayed = settle(beginSend(retried, retryRequest), retryRequest.seq, { kind: 'ok', fileId: 21, revision: 1 })

  expect(replayed.fileId === 21 && replayed.revision === 1, 'D-2 重放取得 id / revision')
  expect(replayed.pendingCreate === null, 'D-2 重放成功后清空待重放请求')
  expectSnapshotEqual(replayed.baseline, first, 'D-2 只确认首次快照')
  expect(replayed.draft.content === '第一篇 继续输入', 'D-2 重放保留最新草稿')
  expect(replayed.status === 'unsaved', 'D-2 重放成功不把较新输入标记为已保存')
  const followUp = planSave(replayed, savableOf(replayed))
  expect(followUp.kind === 'send' && followUp.request.kind === 'update' && followUp.request.fileId === 21
    && followUp.request.expectedRevision === 1, 'D-2 后续草稿走 PATCH 指向新建文件')
  expectSnapshotEqual(snapshotPatch(replayed.draft, replayed.baseline), { content: '第一篇 继续输入' },
    'D-2 后续 PATCH 只带变化字段')
}

// D-2c：真正 Daily 唯一冲突 / 同键异体 409 仍按冲突处理，不被吞掉、不自动换键
{
  let core = applyInput(
    createAutosaveCore({ draft: snapshot({ title: '', content: '', date: '2026-10-10' }), createKey: 'daily-key', file: null }),
    snapshot({ title: '', content: 'Daily 正文', date: '2026-10-10' }),
  )
  const request = sendOf(core, savableOf(core))
  core = beginSend(core, request)
  core = settle(core, request.seq, { kind: 'conflict', message: '当日 Daily 已存在' })
  expect(core.status === 'conflict', 'D-2 Daily 409 仍是冲突')
  expect(core.error === '当日 Daily 已存在', 'D-2 冲突说明保留')
  expect(core.draft.content === 'Daily 正文', 'D-2 冲突保留草稿')
  expect(core.createKey === 'daily-key', 'D-2 冲突不自动换新键')
  expect(core.pendingCreate?.createKey === 'daily-key', 'D-2 冲突后待重放键不变（不会被同键异体吞掉）')
  const decision = planSave(core, savableOf(core))
  expect(decision.kind === 'blocked' && decision.reason === 'conflict', 'D-2 冲突不自动重试')
}

// ---------------------------------------------------------------------------
// E. 结构化正文（Stage 3 / S3-T04）：块快照、比较、校验与 payload
//    依据 `docs/stage3-api.md` §2、`docs/stage3-architecture.md` §3。
// ---------------------------------------------------------------------------

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const U3 = '33333333-3333-4333-8333-333333333333'
const U4 = '44444444-4444-4444-8444-444444444444'

function ublock(id: string, text: string): Block {
  return { id, kind: 'user', text }
}
function rblock(id: string, text: string, requestId: string): Block {
  return { id, kind: 'ai_reply', text, request_id: requestId }
}

// 含空格、空行、缩进与 emoji 的旧正文，用于验证逐字往返
const LEGACY_TEXT = '第一行\n\n  缩进两个空格\n末行 🧭\n'
const LEGACY_PLAIN = snapshot({ title: '旧标题', content: LEGACY_TEXT, date: '2026-02-01' })
const LEGACY_CONVERTED: DraftSnapshot = { ...LEGACY_PLAIN, blocks: [ublock(U1, LEGACY_TEXT)] }

// E-1 旧 NULL 正文首次结构化保存：等价转换、只发 content_blocks
{
  expect(draftProjection(LEGACY_CONVERTED) === LEGACY_TEXT, 'E-1 转换后阅读投影逐字等于旧正文')
  expect(!snapshotEquals(LEGACY_CONVERTED, LEGACY_PLAIN),
    'E-1 投影相同但普通 vs 结构化必须不相等（否则首次转换永远不会提交）')
  expectSnapshotEqual(snapshotPatch(LEGACY_CONVERTED, LEGACY_PLAIN), { blocks: [ublock(U1, LEGACY_TEXT)] },
    'E-1 首次转换的补丁只含 content_blocks，不含 content')
  expect(isUpdateSavable(LEGACY_CONVERTED, LEGACY_PLAIN), 'E-1 首次转换可提交')

  let core = createAutosaveCore({ draft: LEGACY_PLAIN, createKey: 'k1', file: { id: 9, revision: 1 } })
  core = applyInput(core, LEGACY_CONVERTED)
  expect(core.inputSeq === 1, 'E-1 结构化输入被登记为一次真实输入')
  const request = sendOf(core, savableOf(core))
  expect(request.kind === 'update' && request.snapshot.blocks?.[0]?.text === LEGACY_TEXT,
    'E-1 提交快照携带等价 user 块')
  core = beginSend(core, request)
  core = settle(core, request.seq, { kind: 'ok', fileId: 9, revision: 2 })
  expect(core.baseline.blocks?.[0]?.text === LEGACY_TEXT, 'E-1 保存成功后基线切换为结构化')
  expect(core.revision === 2, 'E-1 保存成功后版本更新')
  expect(core.status === 'saved', 'E-1 转换完成后状态为已保存')
}

// E-2 结构化文件只改标题 / 日期 / Folder：补丁不含正文
{
  const base: DraftSnapshot = snapshot({ title: '旧标题', content: LEGACY_TEXT, date: '2026-02-01', blocks: [ublock(U1, LEGACY_TEXT)] })
  expectSnapshotEqual(snapshotPatch({ ...base, title: '新标题' }, base), { title: '新标题' },
    'E-2 只改标题时补丁只有 title')
  expectSnapshotEqual(snapshotPatch({ ...base, date: '2026-02-09' }, base), { date: '2026-02-09' },
    'E-2 只改日期时补丁只有 date')
  expectSnapshotEqual(snapshotPatch({ ...base, folder_id: 5 }, base), { folder_id: 5 },
    'E-2 只改 Folder 时补丁只有 folder_id')
  expect(isUpdateSavable({ ...base, title: '新标题' }, base), 'E-2 结构化文件只改标题可提交')
}

// E-3 结构化文件编辑用户段：只发 blocks，不发 content
{
  const base: DraftSnapshot = snapshot({ title: '旧标题', content: LEGACY_TEXT, date: '2026-02-01', blocks: [ublock(U1, LEGACY_TEXT)] })
  const editedBlocks = [ublock(U1, '改过的正文')]
  const draft: DraftSnapshot = { ...base, blocks: editedBlocks, content: '改过的正文' }
  expectSnapshotEqual(snapshotPatch(draft, base), { blocks: editedBlocks },
    'E-3 编辑用户段的补丁只含 content_blocks')
  expect(isUpdateSavable(draft, base), 'E-3 编辑用户段可提交')
  // 后端只禁止重排 / 新增 AI 段 / 篡改 AI 身份，并不禁止替换 user 段 id；
  // 「块 id 稳定」是编辑器（`writingBlocks.setBlockText`）的客户端保证。
  expect(isUpdateSavable({ ...base, blocks: [ublock(U2, '改过的正文')], content: '改过的正文' }, base),
    'E-3 后端允许替换 user 段 id；稳定性由编辑器保证（见 writingBlocks 测试）')
}

// E-4 旧超长正文（结构化）只改标题：不重新校验、不截断
{
  const longText = 'a'.repeat(60_000)
  const base: DraftSnapshot = snapshot({ title: '旧标题', content: longText, date: '2026-02-02', blocks: [ublock(U1, longText)] })
  expect(isUpdateSavable({ ...base, title: '新标题' }, base), 'E-4 结构化旧超长正文只改标题仍可提交')
  expectSnapshotEqual(snapshotPatch({ ...base, title: '新标题' }, base), { title: '新标题' },
    'E-4 补丁不含超长正文（后端不会重新校验）')
  expect(!isUpdateSavable({ ...base, blocks: [ublock(U1, 'a'.repeat(50_001))], content: 'a'.repeat(50_001) }, base),
    'E-4 真正修改后的结构化正文超限则拒绝')
}

// E-5 结构违规：客户端删除 AI 段 / 篡改身份 / 改回复文本
{
  const serverBlocks = [ublock(U1, '甲'), rblock(U2, '回复', U3)]
  const base: DraftSnapshot = snapshot({ content: '甲\n\n> AI 回复\n> 回复\n\n', date: '2026-02-03', blocks: serverBlocks })
  expect(!isUpdateSavable({ ...base, blocks: [ublock(U1, '甲')], content: '甲' }, base),
    'E-5 通过普通保存删除 AI 段被拒（须走专用接口）')
  const tampered = [ublock(U1, '甲'), rblock(U2, '回复', U4)]
  expect(!isUpdateSavable({ ...base, blocks: tampered, content: draftProjection({ ...base, blocks: tampered }) }, base),
    'E-5 篡改 AI 段来源身份被拒')
  const editedReply = [ublock(U1, '甲'), rblock(U2, '改过的回复', U3)]
  expect(!isUpdateSavable({ ...base, blocks: editedReply, content: draftProjection({ ...base, blocks: editedReply }) }, base),
    'E-5 修改 ai_reply 文本被拒')
}

// E-6 新建带 blocks：需要至少一个非空 user 段
{
  expect(isSnapshotSavable(snapshot({ title: '', content: '新正文', date: '2026-02-04', blocks: [ublock(U4, '新正文')] })),
    'E-6 新建非空 user 块可创建')
  expect(!isSnapshotSavable(snapshot({ title: '', content: '', date: '2026-02-04', blocks: [] })),
    'E-6 空块数组不可创建')
  expect(!isSnapshotSavable(snapshot({ title: '', content: '  ', date: '2026-02-04', blocks: [ublock(U4, '  ')] })),
    'E-6 纯空白 user 块不可创建')
  expect(!isSnapshotSavable(snapshot({ title: '', content: '', date: '2026-02-04', blocks: [rblock(U4, '只有 AI', U3)] })),
    'E-6 客户端不能以「只有 AI 段」创建文件')
}

// E-7 块比较不依赖数组引用（避免每次渲染都判脏）
{
  const a: DraftSnapshot = snapshot({ title: 't', content: LEGACY_TEXT, date: '2026-02-05', blocks: [ublock(U1, LEGACY_TEXT)] })
  const b: DraftSnapshot = snapshot({ title: 't', content: LEGACY_TEXT, date: '2026-02-05', blocks: [ublock(U1, LEGACY_TEXT)] })
  expect(snapshotEquals(a, b), 'E-7 块内容相同则快照相等（新数组引用不影响）')
  const c: DraftSnapshot = { ...a, blocks: [ublock(U1, LEGACY_TEXT), ublock(U2, '')] }
  expect(!snapshotEquals(a, c), 'E-7 追加空续写段算作变化')
}

if (failures.length > 0) {
  throw new Error(`失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
}

console.log(`autosave: ${passed} assertions passed`)
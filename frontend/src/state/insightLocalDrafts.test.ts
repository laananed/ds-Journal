/**
 * Insight 本地草稿记录的纯逻辑测试。
 *
 * 运行：`node --experimental-strip-types src/state/insightLocalDrafts.test.ts`
 *
 * 覆盖：键命名、序列化/解析校验、坏记录不影响其它记录、排序、恢复判定
 * （同版本可恢复 / 版本不同必须走冲突 / 新建直接恢复）、存储失败不抛错。
 */

import {
  INSIGHT_DRAFT_PREFIX,
  insightDraftRecordKey,
  insightRecoveryDecision,
  parseInsightDraft,
  readInsightDrafts,
  removeInsightDraft,
  serializeInsightDraft,
  writeInsightDraft,
  type InsightDraftRecord,
  type InsightDraftStorage,
} from './insightLocalDrafts.ts'

let assertions = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  assertions += 1
  if (actual !== expected) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`)
}

function expectTrue(value: boolean, label: string): void {
  assertions += 1
  if (!value) throw new Error(`${label}：期望 true`)
}

function expectNull(value: unknown, label: string): void {
  assertions += 1
  if (value !== null) throw new Error(`${label}：期望 null，实际 ${String(value)}`)
}

/** 只实现 Storage 的读/写/删/枚举，模拟浏览器之外的确定性环境。 */
function createMemoryStorage(): InsightDraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() { return map.size },
    key(index: number) { return Array.from(map.keys())[index] ?? null },
    getItem(key: string) { return map.get(key) ?? null },
    setItem(key: string, value: string) { map.set(key, value) },
    removeItem(key: string) { map.delete(key) },
  }
}

const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] }

function record(overrides: Partial<InsightDraftRecord> = {}): InsightDraftRecord {
  return {
    v: 1,
    record_key: insightDraftRecordKey(7, 'insight:7'),
    draft_id: 'insight:7',
    file_id: 7,
    base_revision: 3,
    title: '标题',
    content_doc: document,
    folder_id: null,
    saved_at: 1000,
    ...overrides,
  }
}

// ---- 键 ----
expectEqual(
  insightDraftRecordKey(null, 'abc'),
  `${INSIGHT_DRAFT_PREFIX}create:abc`,
  '新建草稿按面板身份建键',
)
expectEqual(
  insightDraftRecordKey(7, 'insight:7'),
  `${INSIGHT_DRAFT_PREFIX}file:7`,
  '已有记录按文件建键',
)
expectTrue(
  insightDraftRecordKey(null, 'a') !== insightDraftRecordKey(null, 'b'),
  '两个新建草稿不互相覆盖',
)

// ---- 序列化 / 解析 ----
const roundTrip = parseInsightDraft(record().record_key, serializeInsightDraft(record()))
expectTrue(roundTrip !== null, '合法记录可解析')
expectEqual(roundTrip?.title, '标题', '标题原样保留')
expectEqual(roundTrip?.base_revision, 3, '基线版本保留')
expectEqual(roundTrip?.record_key, record().record_key, '解析回填存储键')

expectNull(parseInsightDraft('other.key', serializeInsightDraft(record())), '非本模块命名空间不解析')
expectNull(parseInsightDraft(record().record_key, null), '缺失内容不解析')
expectNull(parseInsightDraft(record().record_key, '{'), '坏 JSON 不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), v: 2 })), '版本不符不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), draft_id: '' })), '空草稿身份不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), file_id: 0 })), '非法文件 ID 不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), base_revision: 0 })), '非法基线版本不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), content_doc: null })), '正文缺失不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), content_doc: { type: 'text' } })), '非 doc 正文不解析')
expectNull(parseInsightDraft(record().record_key, JSON.stringify({ ...record(), saved_at: 'now' })), '非数字时间不解析')

// ---- 读取 / 排序 / 删除 ----
const storage = createMemoryStorage()
writeInsightDraft(storage, record({ record_key: insightDraftRecordKey(7, 'insight:7'), saved_at: 1000 }))
writeInsightDraft(storage, record({
  record_key: insightDraftRecordKey(8, 'insight:8'), draft_id: 'insight:8', file_id: 8, saved_at: 2000,
}))
writeInsightDraft(storage, record({
  record_key: insightDraftRecordKey(null, 'tmp'), draft_id: 'tmp', file_id: null, base_revision: null, saved_at: 3000,
}))
storage.setItem('unrelated', '{"v":1}')
storage.setItem(`${INSIGHT_DRAFT_PREFIX}file:9`, 'broken')

const listed = readInsightDrafts(storage)
expectEqual(listed.length, 3, '忽略无关键与坏记录')
expectEqual(listed[0].file_id, null, '最新记录排在最前')
expectEqual(listed[1].file_id, 8, '按时间倒序')
expectEqual(listed[2].file_id, 7, '最旧记录排最后')

removeInsightDraft(storage, insightDraftRecordKey(8, 'insight:8'))
expectEqual(readInsightDrafts(storage).length, 2, '删除只移除目标记录')

// ---- 写失败 ----
const failing: InsightDraftStorage = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => { throw new Error('SecurityError') },
}
expectEqual(writeInsightDraft(failing, record()), false, '写入失败返回 false')
expectEqual(readInsightDrafts(null).length, 0, '无存储时返回空列表')
removeInsightDraft(failing, 'x')
expectEqual(readInsightDrafts(failing).length, 0, '读取失败不抛错')

// ---- 恢复判定 ----
expectEqual(insightRecoveryDecision(record({ file_id: null, base_revision: null }), null), 'restore', '新建草稿直接恢复')
expectEqual(insightRecoveryDecision(record(), 3), 'restore', '同版本可安全恢复')
expectEqual(insightRecoveryDecision(record(), 4), 'conflict', '服务器版本更新时必须走冲突')
expectEqual(insightRecoveryDecision(record(), 2), 'conflict', '版本回退也不自动覆盖')
expectEqual(insightRecoveryDecision(record({ base_revision: null }), 3), 'conflict', '无基线版本时要求确认')

console.log(`insightLocalDrafts: ${assertions} assertions passed`)

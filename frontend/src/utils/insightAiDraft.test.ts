/**
 * Insight 草稿自主添加的纯逻辑测试（Stage 3 / S3-T10）。
 *
 * 不引入测试框架，直接运行：
 *
 *   node --experimental-strip-types src/utils/insightAiDraft.test.ts
 *
 * 断言只用 `throw`；调用 `insightAiDraft.ts` 里的真实函数。
 * 本文件只做纯逻辑验证，不代表真实 Review→Insight 接线已验证。
 */

import {
  deriveDraftKey,
  duplicateSeed,
  draftFallbackKey,
  draftSourceLabel,
  insightDraftToSeed,
  normalizeInsightDrafts,
  reviewDraftsToSeeds,
  type InsightDraftLike,
  type InsightDraftSource,
} from './insightAiDraft.ts'

let passed = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${label}：期望 ${expectedText}，实际 ${actualText}`)
  }
  passed += 1
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label)
  passed += 1
}

/** 一份草稿；只写出本文件关心的字段。 */
function draft(overrides: Partial<InsightDraftLike> = {}): InsightDraftLike {
  return {
    draft_id: '11111111-1111-5111-8111-111111111111',
    title: '我怕让人失望',
    viewpoint: '我倾向先把别人的活接回来，再考虑自己是否撑得住。',
    evidence: [{ source: { type: 'journal', id: 12 }, quote: '你前面说想休息，后面又把活接回来了。' }],
    content: '这条倾向在最近两次记录里都出现了。',
    ...overrides,
  }
}

type Case = { label: string; run: () => void }
const cases: Case[] = []
function test(label: string, run: () => void): void {
  cases.push({ label, run })
}
function runCases(): void {
  for (const item of cases) item.run()
}

// ---- 1. 搜索框默认关键词：短标题优先，保证普通搜索能真的命中 ----

test('默认关键词取标题，避免整句观点在子串搜索里永远搜空', () => {
  const keyword = draftSourceLabel(draft())
  expectEqual(keyword, '我怕让人失望', '标题优先作为可检索关键词')
  check(!keyword.includes('别人的活接回来'), '不使用整句观点')
})

test('没有标题时退回观点，且不拼依据原文与补充说明', () => {
  const keyword = draftSourceLabel(draft({ title: '' }))
  check(keyword.includes('别人的活接回来'), '无标题时退回观点原文')
  check(!keyword.includes('你前面说想休息'), '关键词不包含依据引用')
  check(!keyword.includes('最近两次记录'), '关键词不包含补充说明')
})

test('标题与观点都为空时返回空串（界面不发搜索请求）', () => {
  expectEqual(draftSourceLabel(draft({ title: '', viewpoint: '' })), '', '都为空时返回空串')
})

test('关键词按 120 码点截断且不留半个代理对', () => {
  const long = '观'.repeat(200)
  const keyword = draftSourceLabel(draft({ title: long, viewpoint: '' }))
  expectEqual([...keyword].length, 120, '关键词按 Unicode 码点截断到 120')
  const emoji = '🙂'.repeat(200)
  const emojiKeyword = draftSourceLabel(draft({ title: emoji, viewpoint: '' }))
  check(!emojiKeyword.includes('\uFFFD'), '截断不产生孤立代理对')
  expectEqual([...emojiKeyword].length, 120, 'emoji 关键词同样按码点截断')
})

// ---- 2. 创建键：从 draft_id 稳定派生，绝不跨草稿共享 ----

test('同一 draft_id 重复派生得到同一创建键', () => {
  const first = deriveDraftKey('11111111-1111-5111-8111-111111111111')
  const second = deriveDraftKey('11111111-1111-5111-8111-111111111111')
  expectEqual(first, second, '同 draft_id 派生稳定')
})

test('派生的创建键是合法 UUID 形状且不等于 draft_id', () => {
  const key = deriveDraftKey('11111111-1111-5111-8111-111111111111')
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key), '形如 UUID')
  check(key !== '11111111-1111-5111-8111-111111111111', '派生键不复用 draft_id 本身')
})

test('不同 draft_id 派生不同创建键（多草稿不共享一个键）', () => {
  const keys = new Set([
    '11111111-1111-5111-8111-111111111111',
    '22222222-2222-5222-8222-222222222222',
    '33333333-3333-5333-8333-333333333333',
  ].map((id) => deriveDraftKey(id)))
  expectEqual(keys.size, 3, '三份草稿三个不同键')
})

test('内容指纹回退键稳定且互不相同', () => {
  const a = draftFallbackKey('观点甲')
  const b = draftFallbackKey('观点乙')
  expectEqual(a, draftFallbackKey('观点甲'), '同内容回退稳定')
  check(a !== b, '不同内容回退不同键')
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a), '回退键形如 UUID')
})

test('缺 draft_id 时按内容指纹回退：同一份草稿换位置仍得到同一个键', () => {
  const target = draft({ draft_id: undefined })
  const moved = [target, draft({ draft_id: undefined, title: '别的', viewpoint: '完全不同的观点。' })]
  const seed = reviewDraftsToSeeds(moved)[0]
  const again = reviewDraftsToSeeds([target])[0]
  // 同一份草稿内容在任何位置都得到同一个键（不依赖数组下标）。
  expectEqual(seed.createKey, again.createKey, '内容相同则键稳定，与位置无关')
})

test('坏 draft_id（空串/纯空白/非 UUID）不进入创建键，且单份推导仍是合法 UUID', () => {
  for (const bad of ['', '   ', 'not-a-uuid']) {
    const seed = insightDraftToSeed(draft({ draft_id: bad }))
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(seed.createKey),
      `坏 draft_id（${JSON.stringify(bad)}）回退键形如 UUID`)
    check(seed.createKey !== bad, '不把非法 draft_id 直接当创建键')
  }
})

test('同一份坏 draft_id 草稿重复推导稳定（重试回同一文件）', () => {
  const target = draft({ draft_id: '' })
  expectEqual(insightDraftToSeed(target).createKey, insightDraftToSeed(target).createKey, '坏 draft_id 回退仍稳定')
})

test('内容不同的两份草稿即使都没有 draft_id 也不共享键', () => {
  const seeds = reviewDraftsToSeeds([
    draft({ draft_id: undefined, title: '观点甲', viewpoint: '我怕让人失望。' }),
    draft({ draft_id: undefined, title: '观点乙', viewpoint: '我不太会拒绝别人。' }),
  ])
  check(seeds[0].createKey !== seeds[1].createKey, '不同内容不共享创建键')
})

test('重复 draft_id（后端异常）仍产生不同键，不会合并成一份', () => {
  const seeds = reviewDraftsToSeeds([
    draft({ title: '观点甲' }),
    draft({ title: '观点乙', viewpoint: '另一个观点。' }),
  ])
  check(seeds[0].createKey !== seeds[1].createKey, '重复 draft_id 不共享创建键')
})

test('多草稿分别新建：每个 seed 一个键、顺序与输入一致', () => {
  const seeds = reviewDraftsToSeeds([
    draft({ title: '甲' }),
    draft({ draft_id: '22222222-2222-5222-8222-222222222222', title: '乙' }),
    draft({ draft_id: '33333333-3333-5333-8333-333333333333', title: '丙' }),
  ])
  expectEqual(seeds.map((seed) => seed.title), ['甲', '乙', '丙'], '顺序保持')
  expectEqual(new Set(seeds.map((seed) => seed.createKey)).size, 3, '三份草稿三个键')
})

// ---- 3. 编辑输入：一份草稿 = 一个观点 + 多个依据 ----

test('标题与观点进入可编辑正文，多个依据分别保留来源与原文', () => {
  const seed = insightDraftToSeed(draft({
    evidence: [
      { source: { type: 'journal', id: 12 }, quote: '你前面说想休息，后面又把活接回来了。' },
      { source: { type: 'inbox', id: 9 }, quote: '今天又把别人的事接了下来。' },
    ],
  }))
  check(seed.content.includes('别人的活接回来'), '正文保留观点')
  check(seed.content.includes('journal:12'), '正文保留第一个来源身份')
  check(seed.content.includes('inbox:9'), '正文保留第二个来源身份')
  check(seed.content.includes('你前面说想休息'), '正文保留第一条依据原文')
  check(seed.content.includes('今天又把别人的事接了下来'), '正文保留第二条依据原文')
  check(seed.title === '我怕让人失望', '标题原样带出')
  passed += 1
})

test('来源是普通 Markdown 文本，不新增强关系/外键字段', () => {
  const seed = insightDraftToSeed(draft())
  expectEqual(Object.keys(seed).sort(),
    ['content', 'createKey', 'draftId', 'evidenceCount', 'evidenceLines', 'folder_id', 'keyword', 'title',
      'userNotes', 'viewpoint'],
    'seed 只含可编辑字段、展示/搜索辅助与创建键')
  const forbidden = ['type', 'id', 'revision', 'source_ids', 'relations', 'evidence_ids', 'journal_id']
  for (const key of forbidden) {
    check(!(key in seed), `seed 不携带系统/强关系字段 ${key}`)
  }
  check(seed.content.includes('> 来源：journal:12'), '来源以普通引用文本保留')
})

test('不产生第二份重复的来源块：AI 来源区与用户笔记分开字段', () => {
  const seed = insightDraftToSeed(draft())
  const occurrences = seed.content.split('> 来源：').length - 1
  expectEqual(occurrences, 1, '正文只出现一次来源区')
  expectEqual(seed.userNotes, '这条倾向在最近两次记录里都出现了。', '补充说明单独保留供查看')
})

test('没有 evidence 的草稿不编造依据，也不报错', () => {
  const seed = insightDraftToSeed(draft({ evidence: [] }))
  check(!seed.content.includes('依据：'), '无依据时不写依据小节')
  check(seed.content.includes('别人的活接回来'), '观点仍在正文里')
})

test('缺少 content 的草稿仍能组成有效正文', () => {
  const seed = insightDraftToSeed(draft({ content: undefined }))
  check(seed.content.trim() !== '', '正文非空')
  expectEqual(seed.userNotes, '', '无补充说明时为空串')
})

test('空标题草稿不阻断编辑（由用户补标题）', () => {
  const seed = insightDraftToSeed(draft({ title: '' }))
  expectEqual(seed.title, '', '标题保持空串，交给用户填写')
  check(seed.content.includes('别人的活接回来'), '观点仍进入正文')
})

test('创建时 Folder 恒为 null，不自动塞进任何 Folder', () => {
  expectEqual(insightDraftToSeed(draft()).folder_id, null, '默认无 Folder')
})

// ---- 4. 零/多草稿归一化：仅查看不做任何写入，不语义去重 ----

test('零草稿返回空数组（允许一次复盘提炼不出观点）', () => {
  expectEqual(normalizeInsightDrafts([]), [], '空草稿列表保持为空')
  expectEqual(normalizeInsightDrafts(['']), [], '仅字符串占位一并剔除')
  expectEqual(reviewDraftsToSeeds([]), [], '零草稿没有任何 seed（也就没有创建键）')
})

test('多草稿保持数量与顺序，不做语义去重', () => {
  const similar = [
    draft({ title: '怕让人失望', viewpoint: '我怕让别人失望。' }),
    draft({
      draft_id: '22222222-2222-5222-8222-222222222222',
      title: '怕让人失望（换一种说法）',
      viewpoint: '我担心别人对我失望。',
    }),
  ]
  const seeds = reviewDraftsToSeeds(similar)
  expectEqual(seeds.length, 2, '近义草稿不自动合并')
})

test('归一化剔除缺内容的坏项，保留可编辑草稿', () => {
  const normalized = normalizeInsightDrafts([
    draft(),
    null,
    undefined,
    '',
    draft({ draft_id: '22222222-2222-5222-8222-222222222222', title: '第二份' }),
  ])
  expectEqual(normalized.length, 2, '只保留两份可编辑草稿')
})

test('归一化补齐缺失字段，供组件安全渲染', () => {
  const normalized = normalizeInsightDrafts([{ title: '只有标题' } as InsightDraftLike])
  expectEqual(normalized.length, 1, '缺字段的草稿归一化后仍可用')
  expectEqual(normalized[0].viewpoint, '', '缺观点补空串')
  expectEqual(normalized[0].evidence, [], '缺依据补空数组')
})

test('依据来源归一化只接受 journal/inbox，非法类型不进入正文', () => {
  const withBadSource = draft({
    evidence: [
      { source: { type: 'insight' as unknown as InsightDraftSource['type'], id: 3 }, quote: 'AI 回复不能当依据' },
      { source: { type: 'journal', id: 12 }, quote: '真实用户原文' },
      { source: { type: 'journal', id: 0 }, quote: '非法 id' },
    ],
  })
  const seed = insightDraftToSeed(withBadSource)
  check(!seed.content.includes('AI 回复不能当依据'), 'insight 来源不进入正文')
  check(!seed.content.includes('非法 id'), '非法 id 不进入正文')
  check(seed.content.includes('真实用户原文'), '合法依据保留')
})

test('明确另加一份仅换创建键，不修改原草稿或后续重试的键', () => {
  const original = insightDraftToSeed(draft())
  const before = JSON.stringify(original)
  const key = '33333333-3333-4333-8333-333333333333'
  const copy = duplicateSeed(original, key)
  check(copy !== original, '副本是独立 seed 对象')
  expectEqual(JSON.stringify(original), before, '原草稿完全不变')
  expectEqual(copy, { ...original, createKey: key }, '只更换创建键，保留观点和依据')
  expectEqual([copy.title, copy.content, copy.folder_id],
    [original.title, original.content, original.folder_id], '编辑器初始内容不变')
  expectEqual(copy.createKey, key, '读取与重试使用已生成的新键')
})

runCases()

console.log(`insightAiDraft: ${passed} assertions passed`)

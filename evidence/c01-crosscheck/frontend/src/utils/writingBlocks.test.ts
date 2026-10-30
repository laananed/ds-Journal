/**
 * 结构化写作纯逻辑的最小测试（Stage 3 / S3-T04）。
 *
 * 不引入测试框架：直接用 Node 内置类型剥离运行——
 *
 *   node --experimental-strip-types src/utils/writingBlocks.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，也能被 `tsc -b` 检查。
 *
 * 覆盖 `docs/stage3-tasks.md` §6、`docs/stage3-api.md` §2 与
 * `docs/stage3-architecture.md` §3 的验收点：
 * 块投影与后端 `writing/service.py::project_blocks` 对齐、旧正文等价转换逐字往返、
 * Unicode 码点、稳定块 ID、AI 段身份不可篡改/不可由客户端新增、
 * 删除只针对指定 AI 段、空尾 user 段的位置合法性、正文校验与结构校验。
 */

import {
  aiBlockIds,
  appendContinuation,
  blocksBodySavable,
  blocksEqual,
  canDeleteBlock,
  groupReadingRuns,
  hasNonBlankUserBlock,
  isAiBlock,
  isUserBlock,
  legacyBlocksFromContent,
  newBlockId,
  newUserBlock,
  projectBlocks,
  pruneBlocksToServer,
  removeAiBlock,
  setBlockText,
  validateBlocksForSave,
} from './writingBlocks.ts'
import { countCodePoints, isBlankText } from './contentValidation.ts'
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

const UID_A = '11111111-1111-4111-8111-111111111111'
const UID_B = '22222222-2222-4222-8222-222222222222'
const UID_C = '33333333-3333-4333-8333-333333333333'
const UID_D = '44444444-4444-4444-8444-444444444444'

function user(id: string, text: string): Block {
  return { id, kind: 'user', text }
}
function reply(id: string, text: string, requestId: string): Block {
  return { id, kind: 'ai_reply', text, request_id: requestId }
}
function summary(id: string, text: string, requestId: string): Block {
  return { id, kind: 'ai_summary', text, request_id: requestId }
}

// ---------------------------------------------------------------------------
// 1. 判等与类型收窄
// ---------------------------------------------------------------------------
check(blocksEqual(null, null), '两个 null 相等')
check(blocksEqual([], []), '两个空数组相等')
check(!blocksEqual(null, []), 'null 与空数组不相等（普通正文 vs 结构化）')
check(blocksEqual([user(UID_A, 'x')], [user(UID_A, 'x')]), '同 id 同文本相等')
check(!blocksEqual([user(UID_A, 'x')], [user(UID_A, 'y')]), '文本不同不相等')
check(!blocksEqual([user(UID_A, 'x')], [user(UID_B, 'x')]), 'id 不同不相等')
check(!blocksEqual([user(UID_A, 'x'), user(UID_B, 'y')], [user(UID_B, 'y'), user(UID_A, 'x')]), '顺序不同不相等')
check(!blocksEqual([reply(UID_A, 'r', UID_C)], [reply(UID_A, 'r', UID_D)]), 'request_id 不同不相等')
check(isUserBlock(user(UID_A, 'x')), 'isUserBlock 识别 user')
check(!isUserBlock(reply(UID_A, 'r', UID_C)), 'isUserBlock 拒绝 ai_reply')
check(isAiBlock(reply(UID_A, 'r', UID_C)), 'isAiBlock 识别 ai_reply')
check(isAiBlock(summary(UID_A, 's', UID_C)), 'isAiBlock 识别 ai_summary')
check(!isAiBlock(user(UID_A, 'x')), 'isAiBlock 拒绝 user')

// ---------------------------------------------------------------------------
// 2. 块投影必须与后端 project_blocks 完全一致
// ---------------------------------------------------------------------------
expectEqual(projectBlocks([]), '', '空数组投影为空串')
expectEqual(projectBlocks([user(UID_A, '今天挺累的。')]), '今天挺累的。', '单 user 段原样投影（不 trim、不加段落）')
expectEqual(projectBlocks([user(UID_A, '\n 前导空格与换行\n')]), '\n 前导空格与换行\n', 'user 段空白逐字保留')
expectEqual(
  projectBlocks([user(UID_A, '甲'), user(UID_B, '乙')]),
  '甲乙',
  '相邻 user 段直接拼接，不插分隔',
)
expectEqual(
  projectBlocks([user(UID_A, '很累。'), reply(UID_B, '哪件事最耗你呀？', UID_C)]),
  '很累。\n\n> AI 回复\n> 哪件事最耗你呀？\n\n',
  'ai_reply 投影为引用块并带 AI 回复标记',
)
expectEqual(
  projectBlocks([user(UID_A, '累。'), reply(UID_B, '第一行\n第二行', UID_C)]),
  '累。\n\n> AI 回复\n> 第一行\n> 第二行\n\n',
  'ai_reply 多行逐行加引用前缀',
)
expectEqual(
  projectBlocks([user(UID_A, '正文'), summary(UID_B, '复盘内容', UID_C)]),
  '正文\n\n---\n\nAI 复盘\n\n复盘内容',
  'ai_summary 投影为 --- 分隔 + AI 复盘标记',
)
expectEqual(
  projectBlocks([user(UID_A, 'A'), reply(UID_B, 'R', UID_C), user(UID_D, 'B')]),
  'A\n\n> AI 回复\n> R\n\nB',
  'user/AI/user 交错投影顺序正确',
)

// ---------------------------------------------------------------------------
// 3. Unicode 码点：emoji 计 1，非 UTF-16
// ---------------------------------------------------------------------------
check(countCodePoints('🧭') === 1, '单个 emoji 计 1 个码点')
check('🧭'.length === 2, 'emoji 的 UTF-16 length 是 2（对照）')
check(countCodePoints('a🧭b') === 3, '混合字符串按码点计数')
check(isBlankText('　\n\t'), '全角空格/换行/Tab 视为空白')
check(!isBlankText('🧭'), 'emoji 不是空白')
const emojiBlocks = legacyBlocksFromContent('一段🧭文字')
expectEqual(projectBlocks(emojiBlocks), '一段🧭文字', 'emoji 正文投影逐字往返')
check(countCodePoints(projectBlocks(emojiBlocks)) === 5, 'emoji 正文码点数为 5')

// ---------------------------------------------------------------------------
// 4. 旧正文等价转换：逐字保留空格、换行、Unicode
// ---------------------------------------------------------------------------
const legacy = '第一行\n\n  缩进两个空格\n末行 🧭\n'
const legacyConverted = legacyBlocksFromContent(legacy)
check(legacyConverted.length === 1, '旧正文转换成一个 user 段')
check(legacyConverted[0].kind === 'user', '旧正文转换段是 user')
expectEqual(projectBlocks(legacyConverted), legacy, '旧正文转换后投影与原文逐字相同')
check(legacyConverted[0].text === legacy, '旧正文转换段文本未 trim、未改空白')
check(legacyConverted[0].id.length > 0, '旧正文转换段有稳定 id')
const legacyEmpty = legacyBlocksFromContent('')
check(legacyEmpty.length === 1 && legacyEmpty[0].text === '', '空旧正文转换为一个空 user 段（供等价转换）')

// ---------------------------------------------------------------------------
// 5. 稳定块 ID：编辑文本不换 id，newBlockId 互不相同
// ---------------------------------------------------------------------------
const before = [user(UID_A, '甲'), reply(UID_B, 'R', UID_C)]
const edited = setBlockText(before, UID_A, '甲改了')
check(edited[0].id === UID_A, '编辑 user 文本不改变 id')
check(edited[0].kind === 'user' && edited[0].text === '甲改了', '编辑 user 文本生效')
check(before[0].text === '甲', 'setBlockText 不就地修改原数组')
const summaryEdited = setBlockText([summary(UID_B, '旧总结', UID_C)], UID_B, '新总结')
check(summaryEdited[0].id === UID_B, '编辑总结文本不改变 id')
check(summaryEdited[0].kind === 'ai_summary', '编辑总结文本保持 kind')
check(
  summaryEdited[0].kind === 'ai_summary' && summaryEdited[0].request_id === UID_C,
  '编辑总结文本保持 request_id 来源身份',
)
const replyAttempt = setBlockText([reply(UID_B, 'R', UID_C)], UID_B, '试图修改')
check(replyAttempt[0].kind === 'ai_reply' && replyAttempt[0].text === 'R', 'ai_reply 文本不可编辑（原样返回）')
const ids = new Set([newBlockId(), newBlockId(), newBlockId(), newBlockId()])
check(ids.size === 4, 'newBlockId 生成互不相同的 id')
check(/^[0-9a-f-]{36}$/i.test(newBlockId()), 'newBlockId 形如 UUID')
check(newUserBlock('x').kind === 'user' && newUserBlock('x').text === 'x', 'newUserBlock 生成 user 段')
check(newUserBlock().text === '', 'newUserBlock 默认空文本')

// ---------------------------------------------------------------------------
// 6. 删除：只影响指定 AI 段
// ---------------------------------------------------------------------------
const mixed = [user(UID_A, '用户甲'), reply(UID_B, '回复', UID_C), user(UID_D, '用户丁')]
const afterDelete = removeAiBlock(mixed, UID_B)
expectEqual(afterDelete, [user(UID_A, '用户甲'), user(UID_D, '用户丁')], '删除 ai_reply 只移除该段，保留用户段')
check(mixed.length === 3, 'removeAiBlock 不就地修改原数组')
expectEqual(removeAiBlock(mixed, UID_A), mixed, '尝试删除 user 段时原样返回（不允许）')
expectEqual(aiBlockIds(mixed), [UID_B], 'aiBlockIds 列出 AI 段 id')
check(canDeleteBlock(reply(UID_A, 'r', UID_C)), 'ai_reply 可删除')
check(canDeleteBlock(summary(UID_A, 's', UID_C)), 'ai_summary 可删除')
check(!canDeleteBlock(user(UID_A, 'x')), 'user 段不可删除')

// ---------------------------------------------------------------------------
// 7. 空尾 user 续写段：只在「最后一段是非空 user」时追加
// ---------------------------------------------------------------------------
const appended = appendContinuation([user(UID_A, '正文')])
check(appended.length === 2, '末尾非空 user 段后追加一个空 user 段')
check(appended[1].kind === 'user' && appended[1].text === '', '追加段是空 user 段')
expectEqual(appendContinuation([user(UID_A, '正文'), user(UID_B, '')]), [user(UID_A, '正文'), user(UID_B, '')], '已有空尾段时不重复追加')
expectEqual(
  appendContinuation([user(UID_A, '正文'), reply(UID_B, 'R', UID_C)]),
  [user(UID_A, '正文'), reply(UID_B, 'R', UID_C)],
  'AI 段结尾时客户端不擅自追加（交由 T07 在插入前封口）',
)
expectEqual(appendContinuation([]), [], '空数组不追加')

// ---------------------------------------------------------------------------
// 8. 正文有效性：至少一个非空 user 段，或存在服务器已有的非空总结
// ---------------------------------------------------------------------------
check(hasNonBlankUserBlock([user(UID_A, 'x')]), '非空 user 段有效')
check(!hasNonBlankUserBlock([user(UID_A, '  \n ')]), '纯空白 user 段不算有效')
check(!hasNonBlankUserBlock([reply(UID_A, 'r', UID_C)]), '只有 ai_reply 不算有效正文')
check(blocksBodySavable([user(UID_A, 'x')], new Set()), '有 user 正文可保存')
check(!blocksBodySavable([reply(UID_A, 'r', UID_C)], new Set()), '只有 AI 回复且无总结不可保存')
check(
  blocksBodySavable([summary(UID_A, '总结', UID_C)], new Set([UID_A])),
  '服务器已有的非空总结可单独构成有效正文',
)
check(
  !blocksBodySavable([summary(UID_A, '总结', UID_C)], new Set()),
  '本地新增的总结不算有效来源（须是服务器已存在）',
)
check(
  blocksBodySavable([reply(UID_A, '', UID_C), summary(UID_B, '总结', UID_C)], new Set([UID_B])),
  '空 AI 回复 + 服务器已有总结可保存',
)

// ---------------------------------------------------------------------------
// 9. 结构校验（镜像后端 validate_blocks）
// ---------------------------------------------------------------------------
const server = [user(UID_A, '甲'), reply(UID_B, '回复', UID_C)]
check(validateBlocksForSave(server, server) === undefined, '原样提交合法')
check(
  validateBlocksForSave([user(UID_A, '甲改了'), reply(UID_B, '回复', UID_C)], server) === undefined,
  '只改 user 文本合法',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), reply(UID_B, '回复', UID_C), user(UID_D, '新段')], server) === undefined,
  '末尾追加新 user 段合法',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), reply(UID_B, '回复', UID_C), user(UID_D, '')], server)?.code
    === 'empty_continuation',
  'AI 段后直接跟空 user 段会被后端拒绝（空续写段的前一段必须是 user）',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), user(UID_A, '乙')], server)?.code === 'duplicate_id',
  '重复 id 报错',
)
check(
  validateBlocksForSave([reply(UID_B, '回复', UID_C), user(UID_A, '甲')], server)?.code === 'reordered',
  '既有段重排报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), reply(UID_D, '新增', UID_C)], server)?.code === 'new_ai_block',
  '客户端新增 AI 段报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), summary(UID_B, '回复', UID_C)], server)?.code === 'kind_changed',
  '既有段 kind 改变报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), reply(UID_B, '改过了', UID_C)], server)?.code === 'ai_reply_edited',
  'ai_reply 文本被改报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), reply(UID_B, '回复', UID_D)], server)?.code === 'ai_identity_changed',
  'AI 段来源身份被改报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲')], server)?.code === 'ai_block_removed',
  '通过普通保存删除 AI 段报错（须走专用接口）',
)
check(
  validateBlocksForSave([user(UID_A, '')], null)?.code === 'empty_continuation',
  '单独一个空 user 段（非等价转换）报错',
)
check(
  validateBlocksForSave([user(UID_A, '甲'), user(UID_B, '')], null) === undefined,
  '非空 user 段后追加空续写段合法',
)

// ---------------------------------------------------------------------------
// 10. 删除后基线合并：丢弃服务器已删除的段，AI 段文本以服务器为准
// ---------------------------------------------------------------------------
const draftAfterTyping = [user(UID_A, '用户新输入'), reply(UID_B, '回复', UID_C), user(UID_D, '丁')]
const serverAfterDelete = [user(UID_A, '旧'), user(UID_D, '丁')]
expectEqual(
  pruneBlocksToServer(draftAfterTyping, serverAfterDelete),
  [user(UID_A, '用户新输入'), user(UID_D, '丁')],
  '删除期间继续输入：保留更新的 user 文本，丢弃服务器已删除的 AI 段',
)
expectEqual(
  pruneBlocksToServer([user(UID_A, 'x')], null),
  null,
  '服务器没有结构化正文时（null）返回 null',
)

// ---------------------------------------------------------------------------
// 11. 阅读分组：连续 user 段合并还原，AI 段独立
// ---------------------------------------------------------------------------
expectEqual(groupReadingRuns([]), [], '空块数组没有阅读片段')
expectEqual(groupReadingRuns([user(UID_A, '甲')]), [{ kind: 'user', text: '甲' }], '单个 user 段')
expectEqual(
  groupReadingRuns([user(UID_A, '甲'), user(UID_B, '乙')]),
  [{ kind: 'user', text: '甲乙' }],
  '连续 user 段合并为一段（跨段还原 Markdown）',
)
expectEqual(
  groupReadingRuns([user(UID_A, '甲'), reply(UID_B, 'R', UID_C), user(UID_D, '乙')]),
  [{ kind: 'user', text: '甲' }, { kind: 'ai', block: reply(UID_B, 'R', UID_C) }, { kind: 'user', text: '乙' }],
  'AI 段打断 user 合并，前后各自成段',
)
expectEqual(
  groupReadingRuns([user(UID_A, '甲'), reply(UID_B, 'R', UID_C), user(UID_D, '乙'), user(`${UID_D}9`, '丙')]),
  [{ kind: 'user', text: '甲' }, { kind: 'ai', block: reply(UID_B, 'R', UID_C) }, { kind: 'user', text: '乙丙' }],
  'AI 段之后的连续 user 段再次合并',
)
expectEqual(
  groupReadingRuns([summary(UID_A, '总结', UID_C)])[0]?.kind,
  'ai',
  '单独 summary 段是 AI 片段',
)

console.log(`writingBlocks: ${passed} assertions passed`)

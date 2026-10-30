/**
 * 自动 AI 调度的纯逻辑测试（Stage 4 / S04-T09）。
 *
 *   node --experimental-strip-types src/state/autoAi.test.ts
 *
 * 只验证客户端调度边界：时间阈值、码点口径、可见性/IME/保存在途、
 * 系统写入零触发、两模式独立与串行优先、失败快照不自动重试、Minds 范围。
 * 真实供应商调用与浏览器交互另行验证，本文件不冒充。
 */

import {
  AUTO_AI_CONFIG,
  buildDedupeTuple,
  changedCodePoints,
  computeAutoRanges,
  createAutoFileState,
  evaluateAuto,
  noteChange,
  noteScheduled,
  noteSettled,
  normalizeSettings,
  setInFlight,
  syncSettings,
  type AutoFileState,
  type AutoAiSettings,
} from './autoAi.ts'

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

const BASE = 1_000_000

const BOTH_OFF: AutoAiSettings = {
  auto_go_deeper: false,
  auto_minds_comments: false,
  mind_preset_ids: ['gentle_reflection'],
}
const GO_DEEPER_ON: AutoAiSettings = { ...BOTH_OFF, auto_go_deeper: true }
const BOTH_ON: AutoAiSettings = { ...BOTH_OFF, auto_go_deeper: true, auto_minds_comments: true }

function paragraph(id: string, text: string): Record<string, unknown> {
  return {
    type: 'paragraph',
    attrs: { id },
    content: text === '' ? [] : [{ type: 'text', text }],
  }
}

function doc(...nodes: unknown[]): Record<string, unknown> {
  return { type: 'doc', content: nodes }
}

function fileState(settings: AutoAiSettings, userText = '', document: unknown = doc(paragraph('p0', userText))): AutoFileState {
  return createAutoFileState({ fileKey: 'journal:12', settings, userText, document, now: BASE })
}

function tick(overrides: Partial<Parameters<typeof evaluateAuto>[1]> = {}) {
  return {
    now: BASE,
    visible: true,
    composing: false,
    saved: true,
    userText: '',
    document: doc(),
    available: true,
    ...overrides,
  }
}

/* ------------------------------------------------- 1. 默认关闭与开关独立 */

{
  const state = fileState(BOTH_OFF)
  const typed = noteChange(state, {
    origin: 'user_input',
    userText: 'a'.repeat(200),
    document: doc(paragraph('p0', 'a'.repeat(200))),
    now: BASE + 1_000,
  })
  const decision = evaluateAuto(typed, tick({ now: BASE + 100_000, userText: 'a'.repeat(200) }))
  expectEqual(decision.action === 'wait' && decision.reason, 'off', '两个开关默认关闭时不调度')

  // 只开 Go Deeper：Minds 不会被顺带触发。
  const mindsOnly = syncSettings(fileState(BOTH_OFF), { ...BOTH_OFF, auto_minds_comments: true }, {
    userText: '', document: doc(),
  })
  const mindsDocument = doc(paragraph('p0', 'x'.repeat(100)))
  const mindsTyped = noteChange(mindsOnly, {
    origin: 'user_input', userText: 'x'.repeat(100), document: mindsDocument, now: BASE + 1_000,
  })
  const mindsDecision = evaluateAuto(mindsTyped, tick({
    now: BASE + 100_000, userText: 'x'.repeat(100), document: mindsDocument,
  }))
  check(mindsDecision.action === 'request' && mindsDecision.plan.mode === 'minds_comments',
    '只开 Minds 时请求的是 minds_comments')
}

/* -------------------------------------- 2. 80 码点阈值（含 emoji 与中文） */

{
  const state = fileState(GO_DEEPER_ON)
  const seventyNine = 'a'.repeat(79)
  const after79 = noteChange(state, {
    origin: 'user_input', userText: seventyNine, document: doc(paragraph('p0', seventyNine)), now: BASE + 1_000,
  })
  const decision79 = evaluateAuto(after79, tick({ now: BASE + 60_000, userText: seventyNine }))
  check(decision79.action === 'wait' && decision79.reason === 'below_threshold', '79 码点不触发')

  const eighty = 'a'.repeat(80)
  const after80 = noteChange(state, {
    origin: 'user_input', userText: eighty, document: doc(paragraph('p0', eighty)), now: BASE + 1_000,
  })
  const decision80 = evaluateAuto(after80, tick({ now: BASE + 60_000, userText: eighty }))
  check(decision80.action === 'request', '80 码点恰好触发')

  // emoji：👍 是 1 个码点、2 个 UTF-16 单元；79 个 emoji 不足 80。
  const emoji79 = '👍'.repeat(79)
  const emojiAfter79 = noteChange(state, {
    origin: 'user_input', userText: emoji79, document: doc(paragraph('p0', emoji79)), now: BASE + 1_000,
  })
  check(evaluateAuto(emojiAfter79, tick({ now: BASE + 60_000, userText: emoji79 })).action === 'wait',
    '79 个 emoji（158 个 UTF-16 单元）仍不触发：按码点计数')
  const emoji80 = '👍'.repeat(80)
  const emojiAfter80 = noteChange(state, {
    origin: 'user_input', userText: emoji80, document: doc(paragraph('p0', emoji80)), now: BASE + 1_000,
  })
  check(evaluateAuto(emojiAfter80, tick({ now: BASE + 60_000, userText: emoji80 })).action === 'request',
    '80 个 emoji 触发')

  // 中文：79 个汉字不触发、80 个触发。
  const zh79 = '想'.repeat(79)
  const zhAfter79 = noteChange(state, {
    origin: 'user_input', userText: zh79, document: doc(paragraph('p0', zh79)), now: BASE + 1_000,
  })
  check(evaluateAuto(zhAfter79, tick({ now: BASE + 60_000, userText: zh79 })).action === 'wait', '79 个汉字不触发')
  const zh80 = '想'.repeat(80)
  const zhAfter80 = noteChange(state, {
    origin: 'user_input', userText: zh80, document: doc(paragraph('p0', zh80)), now: BASE + 1_000,
  })
  check(evaluateAuto(zhAfter80, tick({ now: BASE + 60_000, userText: zh80 })).action === 'request', '80 个汉字触发')
}

/* --------------------------------------------- 3. 15 秒停顿边界（14.999/15） */

{
  const text = 'b'.repeat(90)
  const state = noteChange(fileState(GO_DEEPER_ON), {
    origin: 'user_input', userText: text, document: doc(paragraph('p0', text)), now: BASE,
  })
  const before = evaluateAuto(state, tick({ now: BASE + AUTO_AI_CONFIG.pause_ms - 1, userText: text }))
  check(before.action === 'wait' && before.reason === 'pausing', '14.999 秒仍在停顿窗口内')
  if (before.action === 'wait') expectEqual(before.readyInMs, 1, '还差 1ms 的提示值')

  const at = evaluateAuto(state, tick({ now: BASE + AUTO_AI_CONFIG.pause_ms, userText: text }))
  check(at.action === 'request', '整 15 秒时允许调度')

  // 继续输入会把停顿重新计时。
  const typingAgain = noteChange(state, {
    origin: 'user_input', userText: `${text}c`, document: doc(paragraph('p0', `${text}c`)), now: BASE + 14_000,
  })
  const afterTyping = evaluateAuto(typingAgain, tick({ now: BASE + 20_000, userText: `${text}c` }))
  check(afterTyping.action === 'wait' && afterTyping.reason === 'pausing', '新输入重置停顿计时')
}

/* --------------------------------------------- 4. 60 秒冷却边界（59.999/60） */

{
  const text = 'c'.repeat(90)
  let state = noteChange(fileState(GO_DEEPER_ON), {
    origin: 'user_input', userText: text, document: doc(paragraph('p0', text)), now: BASE,
  })
  const first = evaluateAuto(state, tick({ now: BASE + 15_000, userText: text }))
  check(first.action === 'request', '首次调度成立')
  if (first.action !== 'request') throw new Error('unreachable')
  state = noteScheduled(state, first.plan, {
    userText: text, document: doc(paragraph('p0', text)), now: BASE + 15_000, dedupeTuple: first.dedupeTuple,
  })

  // 落定后再写 90 个字符：增量够，但冷却未到。
  const more = `${text}${'d'.repeat(90)}`
  state = noteSettled(state, 'go_deeper', { dedupeTuple: first.dedupeTuple, blocked: false, userText: text })
  state = noteChange(state, {
    origin: 'user_input', userText: more, document: doc(paragraph('p0', more)), now: BASE + 20_000,
  })
  const cooling = evaluateAuto(state, tick({ now: BASE + 15_000 + AUTO_AI_CONFIG.cooldown_ms - 1, userText: more }))
  check(cooling.action === 'wait' && cooling.reason === 'cooling', '59.999 秒仍在冷却')
  if (cooling.action === 'wait') expectEqual(cooling.readyInMs, 1, '冷却剩余 1ms')

  const ready = evaluateAuto(state, tick({ now: BASE + 15_000 + AUTO_AI_CONFIG.cooldown_ms, userText: more }))
  check(ready.action === 'request', '整 60 秒允许再次调度')
}

/* -------------------------------- 5. 可见性 / IME / 未保存 / 同源在途 */

{
  const text = 'e'.repeat(100)
  const state = noteChange(fileState(GO_DEEPER_ON), {
    origin: 'user_input', userText: text, document: doc(paragraph('p0', text)), now: BASE,
  })
  const now = BASE + 60_000
  check((() => {
    const d = evaluateAuto(state, tick({ now, userText: text, visible: false }))
    return d.action === 'wait' && d.reason === 'hidden'
  })(), '页面隐藏时不调度')

  check((() => {
    const d = evaluateAuto(state, tick({ now, userText: text, composing: true }))
    return d.action === 'wait' && d.reason === 'ime'
  })(), 'IME 组合中不调度')

  check((() => {
    const d = evaluateAuto(state, tick({ now, userText: text, saved: false }))
    return d.action === 'wait' && d.reason === 'unsaved'
  })(), '未保存完成时不调度')

  const inFlight = setInFlight(state, 'go_deeper', true)
  const d = evaluateAuto(inFlight, tick({ now, userText: text }))
  check(d.action === 'wait' && d.reason === 'in_flight', '同源在途时不叠加第二次请求')

  // IME 组合中的中间输入不推进增量。
  const composing = noteChange(fileState(GO_DEEPER_ON), {
    origin: 'user_input', userText: 'nihao', document: doc(), now: BASE, composing: true,
  })
  expectEqual(composing.modes.go_deeper.increment, 0, '组合中的半截拼音不推进增量')
}

/* -------------------------------------------- 6. 系统写入零触发（防循环） */

{
  let state = fileState(GO_DEEPER_ON, '', doc())
  // 载入、AI 回写、模板插入、目标同步、恢复复制全部按 system 计入。
  for (let index = 0; index < 20; index += 1) {
    state = noteChange(state, {
      origin: 'system',
      userText: 'x'.repeat((index + 1) * 100),
      document: doc(paragraph('p0', 'x'.repeat((index + 1) * 100))),
      now: BASE + index * 1_000,
    })
  }
  expectEqual(state.modes.go_deeper.increment, 0, '系统写入不推进自动增量')
  expectEqual(state.modes.go_deeper.lastInputAt, null, '系统写入不算真实用户输入')
  const decision = evaluateAuto(state, tick({ now: BASE + 600_000, userText: 'x'.repeat(2_000) }))
  check(decision.action === 'wait' && decision.reason === 'no_input', '只有系统写入时永远不发请求')
}

/* -------------------------------- 7. 打开旧文不算新输入；开关打开重建基线 */

{
  const oldText = 'y'.repeat(5_000)
  const state = fileState(GO_DEEPER_ON, oldText, doc(paragraph('p0', oldText)))
  expectEqual(state.modes.go_deeper.increment, 0, '打开已有旧文时增量为 0')
  const decision = evaluateAuto(state, tick({ now: BASE + 600_000, userText: oldText, document: doc(paragraph('p0', oldText)) }))
  check(decision.action === 'wait' && decision.reason === 'no_input', '旧文不冒充刚输入的 80 码点')

  // 先关闭再打开：基线重置到当下，之前的输入不算。
  const off = syncSettings(state, BOTH_OFF, { userText: oldText, document: doc(paragraph('p0', oldText)) })
  const typed = noteChange(off, {
    origin: 'user_input', userText: `${oldText}${'z'.repeat(200)}`,
    document: doc(paragraph('p0', `${oldText}${'z'.repeat(200)}`)), now: BASE + 1_000,
  })
  const reopened = syncSettings(typed, GO_DEEPER_ON, {
    userText: `${oldText}${'z'.repeat(200)}`, document: doc(paragraph('p0', `${oldText}${'z'.repeat(200)}`)),
  })
  expectEqual(reopened.modes.go_deeper.increment, 0, '重新打开开关时基线取当下文本')
  const after = evaluateAuto(reopened, tick({ now: BASE + 600_000, userText: `${oldText}${'z'.repeat(200)}` }))
  check(after.action === 'wait' && after.reason === 'no_input', '开关打开本身不触发请求（设置变化不是输入）')
}

/* --------------------------- 8. 两模式：Go Deeper 优先、同源串行、独立基线 */

{
  const text = 'f'.repeat(120)
  const document = doc(paragraph('p0', text))
  let state = noteChange(fileState(BOTH_ON), {
    origin: 'user_input', userText: text, document, now: BASE,
  })
  const decision = evaluateAuto(state, tick({ now: BASE + 30_000, userText: text, document }))
  check(decision.action === 'request' && decision.plan.mode === 'go_deeper', '两模式同时满足时 Go Deeper 优先')

  if (decision.action !== 'request') throw new Error('unreachable')
  state = noteScheduled(state, decision.plan, {
    userText: text, document, now: BASE + 30_000, dedupeTuple: decision.dedupeTuple,
  })
  expectEqual(state.modes.go_deeper.increment, 0, 'Go Deeper 调度后自己的增量归零')
  expectEqual(state.modes.minds_comments.increment, 120, 'Minds 的基线不被 Go Deeper 推进')
  const blocked = evaluateAuto(state, tick({ now: BASE + 200_000, userText: text, document }))
  check(blocked.action === 'wait' && blocked.reason === 'in_flight', '同源串行：Go Deeper 在途时不启动 Minds')

  state = noteSettled(state, 'go_deeper', { dedupeTuple: decision.dedupeTuple, blocked: false, userText: text })
  const minds = evaluateAuto(state, tick({ now: BASE + 200_000, userText: text, document }))
  check(minds.action === 'request' && minds.plan.mode === 'minds_comments', 'Go Deeper 落定后才轮到 Minds')
  if (minds.action === 'request') {
    expectEqual(minds.plan.presets, ['gentle_reflection'], 'Minds 使用设置里的预置集合')
    expectEqual(minds.plan.ranges, [{ node_id: 'p0', start: 0, end: 120 }], 'Minds 范围覆盖新块全文')
  }
}

/* --------------------------------- 9. 失败/冲突/unknown 同一快照不自动重试 */

{
  const text = 'g'.repeat(100)
  const document = doc(paragraph('p0', text))
  let state = noteChange(fileState(GO_DEEPER_ON), { origin: 'user_input', userText: text, document, now: BASE })
  const decision = evaluateAuto(state, tick({ now: BASE + 20_000, userText: text, document }))
  if (decision.action !== 'request') throw new Error('首次调度应成立')
  state = noteScheduled(state, decision.plan, {
    userText: text, document, now: BASE + 20_000, dedupeTuple: decision.dedupeTuple,
  })
  state = noteSettled(state, 'go_deeper', { dedupeTuple: decision.dedupeTuple, blocked: true, userText: text })

  // 冷却已过、增量仍然不够时先看阈值；补足增量但快照未变 → same_snapshot。
  const sameSnapshot = noteChange(state, {
    origin: 'user_input', userText: `${text}${'h'.repeat(100)}`,
    document: doc(paragraph('p0', `${text}${'h'.repeat(100)}`)), now: BASE + 100_000,
  })
  const blocked = evaluateAuto(sameSnapshot, tick({
    now: BASE + 300_000, userText: text, document,
  }))
  // 用户文本回到被冻结的那份快照：不再自动重试。
  check(blocked.action === 'wait' && blocked.reason === 'same_snapshot', '同一快照失败后不自动重试')

  const changed = evaluateAuto(sameSnapshot, tick({
    now: BASE + 300_000, userText: `${text}${'h'.repeat(100)}`,
    document: doc(paragraph('p0', `${text}${'h'.repeat(100)}`)),
  }))
  check(changed.action === 'request', '新的真实输入形成新快照后允许再次调度')
}

/* ------------------------------------------- 10. 范围计算与去重元组 */

{
  const before = doc(paragraph('p1', 'aaaa'), paragraph('p2', 'bbbb'))
  const after = doc(paragraph('p1', 'aaaaZZ'), paragraph('p2', 'bbbb'), paragraph('p3', '新的一段'))
  expectEqual(computeAutoRanges(before, after), [
    { node_id: 'p1', start: 4, end: 6 },
    { node_id: 'p3', start: 0, end: 4 },
  ], '范围只覆盖改动段与新增块，按 Unicode 码点')

  expectEqual(computeAutoRanges(before, before), null, '没有变化时不算出范围')
  expectEqual(computeAutoRanges(doc(paragraph('p1', 'abc')), doc(paragraph('p1', '') ))
  , null, '整段删除不产生范围（删除不需要 AI 重新分析）')

  // 受保护容器不是用户事实：aiReply 内的文字不进范围。
  const withReply = doc(paragraph('p1', 'aaaa'), {
    type: 'aiReply', attrs: { id: 'r1', request_id: '11111111-1111-4111-8111-111111111111' },
    content: [paragraph('inner', 'AI 写的内容')],
  })
  expectEqual(computeAutoRanges(before, withReply), null, 'AI 回复不计入自动范围')

  const tuple = buildDedupeTuple({
    fileKey: 'journal:12', mode: 'go_deeper', userText: 'abc', ranges: null, presets: [],
  })
  const same = buildDedupeTuple({
    fileKey: 'journal:12', mode: 'go_deeper', userText: 'abc', ranges: null, presets: [],
  })
  const other = buildDedupeTuple({
    fileKey: 'journal:12', mode: 'go_deeper', userText: 'abcd', ranges: null, presets: [],
  })
  check(tuple === same && tuple !== other, '去重元组对同一快照稳定、对新输入变化')

  // 预置集合归一：去重、拒绝非法值、最多 3 个。
  expectEqual(normalizeSettings({
    auto_go_deeper: true, auto_minds_comments: true,
    mind_preset_ids: ['thinking_traps', 'thinking_traps', 'gentle_reflection', 'alternative_perspectives'],
  }).mind_preset_ids, ['thinking_traps', 'gentle_reflection', 'alternative_perspectives'], '预置去重后最多 3 个')
  expectEqual(normalizeSettings({
    auto_go_deeper: false, auto_minds_comments: false, mind_preset_ids: [],
  }).mind_preset_ids, ['gentle_reflection'], '空预置集合回退默认值')

  // changedCodePoints：中间改写只算改动段，纯删除算 0。
  expectEqual(changedCodePoints('abcdef', 'abcXef'), 1, '中间替换只算 1 个码点')
  expectEqual(changedCodePoints('abcdef', 'abc'), 0, '纯删除算 0')
  expectEqual(changedCodePoints('', '👍👍'), 2, 'emoji 按码点计数')
}

console.log(`autoAi: ${passed} 项通过`)

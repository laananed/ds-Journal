/**
 * 自动 AI 调度的**纯逻辑**（Stage 4 / S04-T09）。
 *
 * 权威依据：
 * - `docs/stage4-api.md` §8：两个开关默认 `false`、三个初始参数（15s / 80 码点 / 60s）、
 *   只有真实用户文本变更才调度、开关启用与打开会话记录调度基线、
 *   `(journal_id,kind,快照hash,范围,预置集合)` 去重键、切页只取消未执行调度；
 * - `docs/stage4-architecture.md` §7.3：`origin=user_input|system` 的来源区分、
 *   两模式各自基线/冷却、同源串行且 Go Deeper 优先、Minds 消费范围独立；
 * - `docs/stage4-tasks.md` §3.10：79/80 码点、14.999/15s、59.999/60s、
 *   emoji 与中文按 Unicode 码点、系统事件零循环。
 *
 * 本文件不依赖 React、不发请求、不读时钟，全部时间都由调用方传入，
 * 因此可以用
 *
 *   node --experimental-strip-types src/state/autoAi.test.ts
 *
 * 用确定时钟逐条验证边界。**服务端仍然按冻结快照重新计算**范围与去重键：
 * 这里的 `dedupeTuple` 只是客户端「同一快照不重复触发」的本地护栏，
 * 不是后端 `auto_dedupe_key` 的替代，也不证明输入事件来源。
 */

/* ------------------------------------------------------------------ 常量 */

/** 初始技术参数唯一来源（API §8）；改这里必须同时改 `stage4-api.md` §8 与测试。 */
export const AUTO_AI_CONFIG = {
  /** 输入停顿阈值：最后一次真实用户输入后至少静置这么久。 */
  pause_ms: 15_000,
  /** 本次新增/修订的 Unicode 码点下限。 */
  min_increment_code_points: 80,
  /** 同一模式两次实际执行登记之间的最小间隔。 */
  cooldown_ms: 60_000,
} as const

/** 固定预置（本期没有自定义 Mind CRUD，API §8）。 */
/** 固定预置的中文名与说明；顺序即界面顺序（设置页与 Minds 侧栏共用，不各写一份）。 */
export const MIND_PRESETS: { id: MindPresetId; label: string; hint: string }[] = [
  { id: 'gentle_reflection', label: '温和陪伴', hint: '先接住情绪，再给一个温和的视角。' },
  { id: 'alternative_perspectives', label: '换个角度', hint: '指出被你略过的其他可能解释。' },
  { id: 'thinking_traps', label: '思维陷阱', hint: '指出可能存在的以偏概全、读心、灾难化。' },
]

export const MIND_PRESET_IDS = [
  'gentle_reflection',
  'alternative_perspectives',
  'thinking_traps',
] as const
export type MindPresetId = typeof MIND_PRESET_IDS[number]

/** 两种自动模式；同时开启时严格按此顺序串行，Go Deeper 优先（架构 §7.3）。 */
export const AUTO_AI_MODES = ['go_deeper', 'minds_comments'] as const
export type AutoAiMode = typeof AUTO_AI_MODES[number]

/** 后端允许的最大范围数（API §7：含 1～100 个范围）。 */
export const MAX_AUTO_RANGES = 100

/** 两个开关的默认值：一律关闭（API §8）。 */
export const AUTO_AI_DEFAULTS = {
  auto_go_deeper: false,
  auto_minds_comments: false,
  mind_preset_ids: ['gentle_reflection'] as MindPresetId[],
} as const

export interface AutoAiSettings {
  auto_go_deeper: boolean
  auto_minds_comments: boolean
  mind_preset_ids: MindPresetId[]
}

/* ------------------------------------------------------------------ 类型 */

/** 节点内 Unicode 码点半开区间（API §7，与评论锚点同一口径）。 */
export interface AutoRange {
  node_id: string
  start: number
  end: number
}

export interface AutoModeState {
  enabled: boolean
  /**
   * 该模式的**调度基线文本**：开关启用 / 会话激活 / 上次成功调度时的用户文本。
   * 已有旧文不会冒充「刚刚输入的 80 码点」（API §8）。
   */
  scheduledText: string
  /** 同一时刻的调度基线文档，用于计算 Minds 的自动范围。 */
  scheduledDocument: unknown
  /** 自调度基线以来新增/修订的码点数（只算正向变化）。 */
  increment: number
  /** 最后一次**真实用户输入**的时间；系统写入不更新它。 */
  lastInputAt: number | null
  /** 该模式上次实际执行登记（prepare 成功）的时间，冷却计时起点。 */
  lastRequestAt: number | null
  /** 同源在途调用（prepare 已登记、尚未落定）。 */
  inFlight: boolean
  /** 失败/冲突/unknown 时冻结的快照元组：同快照不再自动重试。 */
  blockedTuple: string | null
  /**
   * 本次调度前的基线副本。失败时回滚基线，让「同一快照」能被识别出来，
   * 而不是因为基线已经前进就误以为还有新的增量。
   */
  beforeSchedule: { text: string; document: unknown; lastInputAt: number | null } | null
}

export interface AutoFileState {
  /** `journal:<id>`；新建未取得服务器身份时为空串，此时不允许自动请求。 */
  fileKey: string
  settings: AutoAiSettings
  modes: Record<AutoAiMode, AutoModeState>
  /** 会话激活时间（诊断用，不参与判定）。 */
  activatedAt: number
}

export interface AutoTick {
  now: number
  /** 页面可见；隐藏时只停止**未执行**的调度，不影响已登记请求。 */
  visible: boolean
  /** IME 组合中：组合结束前不调度（产品 §10、架构 §4.1）。 */
  composing: boolean
  /** 最新输入已保存成功且没有在途保存。 */
  saved: boolean
  /** 当前用户投影文本 U（不含 AI/系统节点）。 */
  userText: string
  /** 当前文档 JSON（只用于计算 Minds 的自动范围）。 */
  document: unknown
  /** 文件是否仍然有效（软删/替换后由调用方置 false）。 */
  available?: boolean
}

export type AutoWaitReason =
  | 'off'
  | 'no_file'
  | 'unavailable'
  | 'hidden'
  | 'ime'
  | 'unsaved'
  | 'in_flight'
  | 'no_input'
  | 'below_threshold'
  | 'pausing'
  | 'cooling'
  | 'same_snapshot'

export interface AutoPlan {
  mode: AutoAiMode
  /** Go Deeper 为 null（分析范围由后端按 C 计算）；Minds 为真实覆盖范围。 */
  ranges: AutoRange[] | null
  /** 仅 Minds 有值。 */
  presets: MindPresetId[]
}

export type AutoDecision =
  | { action: 'request'; plan: AutoPlan; dedupeTuple: string }
  | { action: 'wait'; reason: AutoWaitReason; readyInMs: number; mode: AutoAiMode | null }

/* ------------------------------------------------------------------ 小工具 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 按 Unicode 码点计数（`Array.from` 把代理对还原成单个码点，emoji 只算 1）。 */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

function codePoints(text: string): string[] {
  return Array.from(text)
}

/**
 * `current` 相对 `previous` 新增/修订的码点数。
 *
 * 口径是「最长公共前缀 + 最长公共后缀之外的那一段」，因此：
 * - 末尾续写 → 新增字符数；
 * - 中间改写 → 改动段长度（不是整篇长度）；
 * - 纯删除 / 纯移动 → 0（删除不需要 AI 重新分析）。
 */
export function changedCodePoints(previous: string, current: string): number {
  if (previous === current) return 0
  const left = codePoints(previous)
  const right = codePoints(current)
  let prefix = 0
  const limit = Math.min(left.length, right.length)
  while (prefix < limit && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < limit - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
    suffix += 1
  }
  const changed = right.length - prefix - suffix
  return changed > 0 ? changed : 0
}

/** FNV-1a 32 位：只用于客户端本地去重比较，**不是**密码学摘要。 */
function localHash(text: string): string {
  let hash = 0x811c9dc5
  for (const unit of codePoints(text)) {
    const code = unit.codePointAt(0) ?? 0
    hash ^= code
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function modeEnabled(settings: AutoAiSettings, mode: AutoAiMode): boolean {
  return mode === 'go_deeper' ? settings.auto_go_deeper : settings.auto_minds_comments
}

function emptyMode(): AutoModeState {
  return {
    enabled: false,
    scheduledText: '',
    scheduledDocument: null,
    increment: 0,
    lastInputAt: null,
    lastRequestAt: null,
    inFlight: false,
    blockedTuple: null,
    beforeSchedule: null,
  }
}

function modeOf(state: AutoFileState, mode: AutoAiMode): AutoModeState {
  return state.modes[mode]
}

/* ------------------------------------------------------------- 状态构造 */

/**
 * 打开编辑会话 / 启用开关时记录调度基线。
 *
 * 「已有旧文不冒充刚输入的 80 码点」就落在这里：基线文本与基线文档都取当前值，
 * 增量从 0 开始。这不是后端 C（检查点），不会把未分析旧文标成已消费。
 */
export function createAutoFileState(input: {
  fileKey: string
  settings: AutoAiSettings
  userText: string
  document: unknown
  now: number
}): AutoFileState {
  const modes = {} as Record<AutoAiMode, AutoModeState>
  for (const mode of AUTO_AI_MODES) {
    modes[mode] = {
      ...emptyMode(),
      enabled: modeEnabled(input.settings, mode),
      scheduledText: input.userText,
      scheduledDocument: input.document,
    }
  }
  return {
    fileKey: input.fileKey,
    settings: normalizeSettings(input.settings),
    modes,
    activatedAt: input.now,
  }
}

/** 预置集合归一：去重、只保留合法值、最多 3 个（API §7 的 1～3 个唯一预置）。 */
export function normalizeSettings(settings: AutoAiSettings): AutoAiSettings {
  const seen = new Set<MindPresetId>()
  const presets: MindPresetId[] = []
  for (const preset of settings.mind_preset_ids) {
    if (!MIND_PRESET_IDS.includes(preset) || seen.has(preset)) continue
    seen.add(preset)
    presets.push(preset)
    if (presets.length === 3) break
  }
  return {
    auto_go_deeper: settings.auto_go_deeper === true,
    auto_minds_comments: settings.auto_minds_comments === true,
    mind_preset_ids: presets.length > 0 ? presets : [...AUTO_AI_DEFAULTS.mind_preset_ids],
  }
}

/**
 * 设置变化：只有「开关从关到开」才重建该模式的基线；**设置变化本身不触发**请求
 * （架构 §7.3）。关掉开关只是停止后续调度，保留在途请求与恢复索引。
 */
export function syncSettings(
  state: AutoFileState,
  settings: AutoAiSettings,
  context: { userText: string; document: unknown },
): AutoFileState {
  const next = normalizeSettings(settings)
  const modes = {} as Record<AutoAiMode, AutoModeState>
  for (const mode of AUTO_AI_MODES) {
    const current = state.modes[mode]
    const enabled = modeEnabled(next, mode)
    const turningOn = enabled && !current.enabled
    modes[mode] = {
      ...current,
      enabled,
      ...(turningOn
        ? {
            scheduledText: context.userText,
            scheduledDocument: context.document,
            increment: 0,
            lastInputAt: null,
          }
        : {}),
    }
  }
  return { ...state, settings: next, modes }
}

/**
 * 记录一次变化。
 *
 * `origin='user_input'` 才更新基线增量与静置时间；`system`（载入、AI 回写、
 * 模板插入、目标同步、恢复复制、格式化）直接返回原状态——这是「系统事件零循环」
 * 的落点：系统写入再多也不会让 `increment` 变大，更不会产生付费请求。
 */
export function noteChange(
  state: AutoFileState,
  input: {
    origin: 'user_input' | 'system'
    userText: string
    document: unknown
    now: number
    composing?: boolean
  },
): AutoFileState {
  if (input.origin !== 'user_input') return state
  // IME 组合中的中间态（半截拼音）不算一次完成的用户输入。
  if (input.composing === true) return state
  let changed = false
  const modes = {} as Record<AutoAiMode, AutoModeState>
  for (const mode of AUTO_AI_MODES) {
    const current = state.modes[mode]
    if (!current.enabled) {
      modes[mode] = current
      continue
    }
    const increment = changedCodePoints(current.scheduledText, input.userText)
    if (increment === current.increment && current.lastInputAt !== null) {
      modes[mode] = current
      continue
    }
    changed = true
    modes[mode] = { ...current, increment, lastInputAt: input.now }
  }
  if (!changed) return state
  return { ...state, modes }
}

/** 记一次同源在途状态（prepare 已登记 / 已落定）。 */
export function setInFlight(state: AutoFileState, mode: AutoAiMode, inFlight: boolean): AutoFileState {
  const current = modeOf(state, mode)
  if (current.inFlight === inFlight) return state
  return { ...state, modes: { ...state.modes, [mode]: { ...current, inFlight } } }
}

/**
 * 一次 prepare 已成功登记：该模式的基线文本/文档前进到当前值、增量归零、
 * 冷却从现在开始计时。另一个模式的基线**不动**（Minds 消费范围独立，
 * 不能因为 Go Deeper 推进 C 就跳过）。
 */
export function noteScheduled(
  state: AutoFileState,
  plan: AutoPlan,
  context: { userText: string; document: unknown; now: number; dedupeTuple: string },
): AutoFileState {
  const current = modeOf(state, plan.mode)
  const next: AutoModeState = {
    ...current,
    beforeSchedule: {
      text: current.scheduledText,
      document: current.scheduledDocument,
      lastInputAt: current.lastInputAt,
    },
    scheduledText: context.userText,
    scheduledDocument: context.document,
    increment: 0,
    lastInputAt: null,
    lastRequestAt: context.now,
    inFlight: true,
    blockedTuple: null,
  }
  return { ...state, modes: { ...state.modes, [plan.mode]: next } }
}

/**
 * 一次自动请求落定。
 *
 * 失败 / 冲突 / unknown：**回滚**调度前的基线并冻结本次快照元组，
 * 同一快照不再自动重试（否则基线已经前进，看起来「永远有新增量」）；
 * 只有新的真实输入形成新快照后才允许再次调度（架构 §7.3）。
 */
export function noteSettled(
  state: AutoFileState,
  mode: AutoAiMode,
  input: { dedupeTuple: string | null; blocked: boolean; userText: string },
): AutoFileState {
  const current = modeOf(state, mode)
  if (!input.blocked) {
    return {
      ...state,
      modes: { ...state.modes, [mode]: { ...current, inFlight: false, blockedTuple: null, beforeSchedule: null } },
    }
  }
  const restored = current.beforeSchedule ?? {
    text: current.scheduledText,
    document: current.scheduledDocument,
    lastInputAt: current.lastInputAt,
  }
  return {
    ...state,
    modes: {
      ...state.modes,
      [mode]: {
        ...current,
        inFlight: false,
        blockedTuple: input.dedupeTuple,
        beforeSchedule: null,
        scheduledText: restored.text,
        scheduledDocument: restored.document,
        lastInputAt: restored.lastInputAt,
        increment: changedCodePoints(restored.text, input.userText),
      },
    },
  }
}

/* --------------------------------------------------------------- 判定 */

/**
 * 服务端 `auto_dedupe_key` 的本地镜像元组：同文件 + 同模式 + 同用户快照 +
 * 同范围 + 同预置集合。只用于「同一快照不重复触发」，不改写服务端判定。
 */
export function buildDedupeTuple(input: {
  fileKey: string
  mode: AutoAiMode
  userText: string
  ranges: AutoRange[] | null
  presets: MindPresetId[]
}): string {
  const scope = input.ranges === null
    ? 'all'
    : input.ranges.map((range) => `${range.node_id}:${range.start}-${range.end}`).join(',')
  return [input.fileKey, input.mode, localHash(input.userText), scope,
    input.presets.join('+')].join('|')
}

function wait(reason: AutoWaitReason, mode: AutoAiMode | null, readyInMs = 0): AutoDecision {
  return { action: 'wait', reason, readyInMs: Math.max(0, Math.ceil(readyInMs)) , mode }
}

/**
 * 现在要不要发一次自动 prepare。
 *
 * 顺序对应契约：页面可见 → IME 已结束 → 已保存 → 同源无在途 → 有真实输入
 * （增量 ≥ 80 码点）→ 停顿 ≥ 15s → 该模式冷却 ≥ 60s → 快照不是上次失败的同一份。
 * 两模式都满足时返回 Go Deeper（`AUTO_AI_MODES` 的顺序即优先级）。
 */
export function evaluateAuto(state: AutoFileState, tick: AutoTick): AutoDecision {
  if (state.fileKey === '') return wait('no_file', null)
  if (tick.available === false) return wait('unavailable', null)
  const enabled = AUTO_AI_MODES.filter((mode) => modeOf(state, mode).enabled)
  if (enabled.length === 0) return wait('off', null)
  if (!tick.visible) return wait('hidden', null)
  if (tick.composing) return wait('ime', null)
  if (!tick.saved) return wait('unsaved', null)

  // 同源串行：任一模式在途时两种模式都不再启动新一轮（Go Deeper 优先由下一轮再看）。
  const activeMode = AUTO_AI_MODES.find((mode) => modeOf(state, mode).inFlight) ?? null
  if (activeMode !== null) return wait('in_flight', activeMode)

  // 依次评估；第一个真正满足条件的模式即本轮计划（Go Deeper 在数组前面）。
  let best: { decision: AutoDecision; mode: AutoAiMode } | null = null
  for (const mode of enabled) {
    const decision = evaluateMode(state, tick, mode)
    if (decision.action === 'request') return decision
    if (best === null) best = { decision, mode }
  }
  return best?.decision ?? wait('off', null)
}

function evaluateMode(state: AutoFileState, tick: AutoTick, mode: AutoAiMode): AutoDecision {
  const current = modeOf(state, mode)
  if (current.lastInputAt === null) return wait('no_input', mode)
  if (current.increment < AUTO_AI_CONFIG.min_increment_code_points) {
    return wait('below_threshold', mode)
  }
  const paused = tick.now - current.lastInputAt
  if (paused < AUTO_AI_CONFIG.pause_ms) {
    return wait('pausing', mode, AUTO_AI_CONFIG.pause_ms - paused)
  }
  if (current.lastRequestAt !== null) {
    const cooled = tick.now - current.lastRequestAt
    if (cooled < AUTO_AI_CONFIG.cooldown_ms) {
      return wait('cooling', mode, AUTO_AI_CONFIG.cooldown_ms - cooled)
    }
  }
  const plan = planAutoRequest(state, tick, mode)
  if (plan === null) return wait('same_snapshot', mode)
  const dedupeTuple = buildDedupeTuple({
    fileKey: state.fileKey,
    mode,
    userText: tick.userText,
    ranges: plan.ranges,
    presets: plan.presets,
  })
  // 上次同一份快照已经失败/冲突/unknown：不再自动重复，等真实新输入改写快照。
  if (current.blockedTuple !== null && current.blockedTuple === dedupeTuple) {
    return wait('same_snapshot', mode)
  }
  return { action: 'request', plan, dedupeTuple }
}

/**
 * 构造本轮计划。
 *
 * Go Deeper 不传范围（后端按检查点 C 计算增量）；Minds 由真实输入计算
 * `ranges`，覆盖本次实际新增/修订的块。范围算不出来时返回 null（本轮不发），
 * **不**退化成「整篇重扫」——那会把旧文伪装成新输入。
 */
export function planAutoRequest(
  state: AutoFileState,
  tick: AutoTick,
  mode: AutoAiMode,
): AutoPlan | null {
  const current = modeOf(state, mode)
  if (mode === 'go_deeper') return { mode, ranges: null, presets: [] }
  const ranges = computeAutoRanges(current.scheduledDocument, tick.document)
  if (ranges === null || ranges.length === 0) return null
  return { mode, ranges, presets: state.settings.mind_preset_ids }
}

/* ----------------------------------------------------------- 范围计算 */

interface TextBlock {
  id: string
  text: string
}

function nodeId(node: unknown): string | null {
  if (!isRecord(node)) return null
  const attrs = node.attrs
  if (!isRecord(attrs)) return null
  return typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : null
}

/** 一个段/标题块自己的文字（hardBreak 记 1 个换行，与后端 `_plain` 口径一致）。 */
function blockText(node: unknown): string {
  if (!isRecord(node)) return ''
  let text = ''
  for (const child of Array.isArray(node.content) ? node.content : []) {
    if (!isRecord(child)) continue
    if (child.type === 'text' && typeof child.text === 'string') text += child.text
    else if (child.type === 'hardBreak') text += '\n'
  }
  return text
}

function collectBlocks(document: unknown): TextBlock[] {
  const blocks: TextBlock[] = []
  if (!isRecord(document) || !Array.isArray(document.content)) return blocks
  for (const node of document.content) {
    if (!isRecord(node)) continue
    if (node.type !== 'paragraph' && node.type !== 'heading') continue
    const id = nodeId(node)
    if (id === null) continue
    blocks.push({ id, text: blockText(node) })
  }
  return blocks
}

/**
 * 由「调度基线文档 → 当前文档」算出覆盖真实新增/修订范围的节点内码点区间。
 *
 * 只输出用户 paragraph / heading（受保护容器与原子节点不是用户事实，后端也会拒绝）；
 * 未变化块不输出；新增块输出整个可见区间；改动块输出最长公共前后缀之间的那一段。
 */
export function computeAutoRanges(previousDocument: unknown, currentDocument: unknown): AutoRange[] | null {
  const before = new Map<string, string>()
  for (const block of collectBlocks(previousDocument)) before.set(block.id, block.text)
  const ranges: AutoRange[] = []
  for (const block of collectBlocks(currentDocument)) {
    const previous = before.get(block.id)
    if (previous === undefined) {
      if (block.text.trim() !== '') {
        ranges.push({ node_id: block.id, start: 0, end: countCodePoints(block.text) })
      }
      continue
    }
    if (previous === block.text) continue
    const left = codePoints(previous)
    const right = codePoints(block.text)
    let prefix = 0
    const limit = Math.min(left.length, right.length)
    while (prefix < limit && left[prefix] === right[prefix]) prefix += 1
    let suffix = 0
    while (suffix < limit - prefix
      && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) {
      suffix += 1
    }
    const end = right.length - suffix
    if (end > prefix) ranges.push({ node_id: block.id, start: prefix, end })
  }
  if (ranges.length === 0) return null
  if (ranges.length > MAX_AUTO_RANGES) return null
  return ranges
}

/* --------------------------------------------------------------- 展示 */

/** 等待原因的中文说明；用于「自动 AI」状态行，不承诺具体时间以外的行为。 */
export function describeWait(reason: AutoWaitReason): string {
  switch (reason) {
    case 'off': return '两个自动开关都关闭：不会自动请求，只有手动点击才会调用。'
    case 'no_file': return '这篇还没有服务器版本：自动 AI 需要先保存成功。'
    case 'unavailable': return '这篇已不可用（可能已删除或替换）：自动 AI 不会附着结果。'
    case 'hidden': return '页面不在前台：暂停尚未执行的自动调度。'
    case 'ime': return '正在输入法组合中：组合结束并停稳后才调度。'
    case 'unsaved': return '最新输入还没保存成功：先保存再调度，避免分析旧版本。'
    case 'in_flight': return '同源已有在途 AI 请求：两种模式串行，等它落定。'
    case 'no_input': return '还没有真实用户输入：已有旧文不会被当成新输入。'
    case 'below_threshold': return `新增内容不足 ${AUTO_AI_CONFIG.min_increment_code_points} 个字符：继续写才会触发。`
    case 'pausing': return `输入还没停稳（需 ${Math.round(AUTO_AI_CONFIG.pause_ms / 1000)} 秒）。`
    case 'cooling': return `该模式还在冷却（${Math.round(AUTO_AI_CONFIG.cooldown_ms / 1000)} 秒）。`
    case 'same_snapshot': return '这份快照已经请求过并失败/冲突：同一快照不会自动重试，改写后再试。'
    default: return ''
  }
}

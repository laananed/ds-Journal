/**
 * 独立日程（C01）的表单与错误纯逻辑。
 *
 * 契约依据 `docs/stage4-api.md` §13：
 * - `title` 非空、最多 **80 Unicode 码点**（不是 `string.length` 的 UTF-16 长度）；
 * - `starts_at` 必填，带时区 ISO；`ends_at` 可为 null，若有须**晚于** `starts_at`；
 * - `PATCH` 只带**变化字段**，实际变化才增版；无变化不提交；
 * - 创建带 `client_create_id` 幂等键，重试必须复用同一个键；
 * - 缺失/非法时间要由用户补充，不能替用户猜。
 *
 * 本文件不 import 运行时依赖（只有类型导入与同目录纯函数），
 * 可直接用 `node --experimental-strip-types` 跑测试。
 */

import type {
  Schedule,
  ScheduleCreateInput,
  ScheduleSuggestionCandidate,
  ScheduleUpdateInput,
} from '../types/schedule.ts'
import { inputToUtcIso, utcIsoToShanghaiInput } from './scheduleTime.ts'

/** §13：标题上限按 Unicode 码点计。 */
export const SCHEDULE_TITLE_MAX_CODE_POINTS = 80

/** 表单草稿：时间用 `datetime-local` 的上海本地值，提交时再转 UTC ISO。 */
export type ScheduleDraft = {
  title: string
  startsAtInput: string
  endsAtInput: string
  completed: boolean
}

/** 字段级错误；为空对象表示通过。 */
export type ScheduleDraftErrors = {
  title?: string
  startsAt?: string
  endsAt?: string
}

/** 通过校验后可直接提交的字段（不含幂等键与版本号）。 */
export type ScheduleDraftPayload = {
  title: string
  starts_at: string
  ends_at: string | null
  completed: boolean
}

/** 按码点计数：`😀` 是 1 个码点、2 个 UTF-16 单元，不能用 `.length` 冒充。 */
export function countCodePoints(value: string): number {
  return Array.from(value).length
}

export function emptyScheduleDraft(): ScheduleDraft {
  return { title: '', startsAtInput: '', endsAtInput: '', completed: false }
}

/**
 * 生成一次新的幂等键。
 * **只有用户显式开始一次新建（或显式重置）时才调用**：网络失败重试必须沿用原键，
 * 否则同一日程可能在服务端落两条。
 */
export function newClientCreateId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : ((random & 0x3) | 0x8)
    return value.toString(16)
  })
}

/**
 * 只校验「结束 vs 开始」的时间关系，返回可直接展示的中文提示（合法或不完整时返回 null）。
 *
 * 比较用**时刻**（`Date.parse` 后的毫秒）而不是字符串：
 * 同一时刻的不同写法（`…T06:30:00Z` 与 `…T06:30:00+08:00`）不能因为字面不同就判成
 * 「结束晚于开始」或「有改动」。两端只要有一端缺失/无法解析就不报区间错误，
 * 由各自的字段错误（缺开始时间、时间不合法）负责说明。
 *
 * 单独导出是因为页面需要**即时**提示：用户改完结束时间就能看到中文错误，
 * 而不是等点保存后才出现（D3）。
 */
export function describeRangeIssue(draft: ScheduleDraft): string | null {
  const startInput = draft.startsAtInput.trim()
  const endInput = draft.endsAtInput.trim()
  if (startInput === '' || endInput === '') return null
  const startIso = inputToUtcIso(startInput)
  const endIso = inputToUtcIso(endInput)
  if (startIso === null || endIso === null) return null
  return Date.parse(endIso) <= Date.parse(startIso) ? '结束时间必须晚于开始时间。' : null
}

/**
 * 校验草稿并归一成提交字段。
 *
 * 失败时 `payload` 为 null，且**不返回任何猜测值**：缺时间就报缺时间，
 * 让用户自己补，避免把「没解析出来的时间」写成一个错的日程。
 */
export function validateScheduleDraft(draft: ScheduleDraft): {
  errors: ScheduleDraftErrors
  payload: ScheduleDraftPayload | null
} {
  const errors: ScheduleDraftErrors = {}
  const title = draft.title.trim()
  if (title === '') {
    errors.title = '标题不能为空。'
  } else if (countCodePoints(title) > SCHEDULE_TITLE_MAX_CODE_POINTS) {
    errors.title = `标题最多 ${SCHEDULE_TITLE_MAX_CODE_POINTS} 个字符（当前 ${countCodePoints(title)} 个）。`
  }

  let startsAt: string | null = null
  if (draft.startsAtInput.trim() === '') {
    errors.startsAt = '需要开始时间。'
  } else {
    startsAt = inputToUtcIso(draft.startsAtInput.trim())
    if (startsAt === null) errors.startsAt = '开始时间不合法，请重新选择。'
  }

  let endsAt: string | null = null
  if (draft.endsAtInput.trim() !== '') {
    endsAt = inputToUtcIso(draft.endsAtInput.trim())
    if (endsAt === null) {
      errors.endsAt = '结束时间不合法，请重新选择。'
    } else if (startsAt !== null) {
      const rangeIssue = describeRangeIssue(draft)
      if (rangeIssue !== null) errors.endsAt = rangeIssue
    }
  }

  if (Object.keys(errors).length > 0 || startsAt === null) {
    return { errors, payload: null }
  }
  return {
    errors: {},
    payload: { title, starts_at: startsAt, ends_at: endsAt, completed: draft.completed },
  }
}

/** 资源 → 草稿（编辑时用；时间按 Asia/Shanghai 回填）。 */
export function draftFromSchedule(schedule: Schedule): ScheduleDraft {
  return {
    title: schedule.title,
    startsAtInput: utcIsoToShanghaiInput(schedule.starts_at) ?? '',
    endsAtInput: schedule.ends_at === null ? '' : (utcIsoToShanghaiInput(schedule.ends_at) ?? ''),
    completed: schedule.completed,
  }
}

/** 创建请求体：草稿 payload + 幂等键。 */
export function buildCreateInput(payload: ScheduleDraftPayload, clientCreateId: string): ScheduleCreateInput {
  return { ...payload, client_create_id: clientCreateId }
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left === right
  return leftMs === rightMs
}

/**
 * 只提交真实变化：没有变化返回 null，页面据此跳过 PATCH。
 *
 * 时间比较用**时刻**而不是字符串：`…T06:30:00Z` 与 `…T06:30:00.000Z`
 * 是同一时刻，按字符串比会误判成「改过」，白白增版。
 */
export function draftToUpdateInput(draft: ScheduleDraft, baseline: Schedule): ScheduleUpdateInput | null {
  const { payload } = validateScheduleDraft(draft)
  if (payload === null) return null

  const patch: ScheduleUpdateInput = { expected_revision: baseline.revision }
  let changed = false
  if (payload.title !== baseline.title) {
    patch.title = payload.title
    changed = true
  }
  if (!sameInstant(payload.starts_at, baseline.starts_at)) {
    patch.starts_at = payload.starts_at
    changed = true
  }
  if (!sameInstant(payload.ends_at, baseline.ends_at)) {
    patch.ends_at = payload.ends_at
    changed = true
  }
  if (payload.completed !== baseline.completed) {
    patch.completed = payload.completed
    changed = true
  }
  return changed ? patch : null
}

/** 候选 → 草稿。返回值里的 `issues` 是要用户补/改的地方，不是错误弹窗。 */
export function candidateToDraft(candidate: ScheduleSuggestionCandidate): {
  draft: ScheduleDraft
  issues: string[]
} {
  const issues: string[] = []
  const title = candidate.title.trim()
  if (title === '') issues.push('候选没有标题，需要你补充。')
  else if (countCodePoints(title) > SCHEDULE_TITLE_MAX_CODE_POINTS) {
    issues.push(`候选标题超过 ${SCHEDULE_TITLE_MAX_CODE_POINTS} 个字符，需要你缩短。`)
  }

  const startsAtInput = candidate.starts_at === null
    ? ''
    : (utcIsoToShanghaiInput(candidate.starts_at) ?? '')
  if (candidate.starts_at === null) {
    issues.push('候选没有给出开始时间，需要你补充后才能保存。')
  } else if (startsAtInput === '') {
    issues.push('候选的开始时间无法解析，需要你重新填写。')
  }

  const endsAtInput = candidate.ends_at === null
    ? ''
    : (utcIsoToShanghaiInput(candidate.ends_at) ?? '')
  if (candidate.ends_at !== null && endsAtInput === '') {
    issues.push('候选的结束时间无法解析，需要你重新填写或清空。')
  }
  if (startsAtInput !== '' && endsAtInput !== '') {
    const startMs = Date.parse(inputToUtcIso(startsAtInput) ?? '')
    const endMs = Date.parse(inputToUtcIso(endsAtInput) ?? '')
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs <= startMs) {
      issues.push('候选的结束时间不晚于开始时间，需要你修改。')
    }
  }

  return {
    draft: { title, startsAtInput, endsAtInput, completed: false },
    issues,
  }
}

/* ------------------------------------------------------------------ 错误 */

export type ScheduleFailureKind =
  | 'not_found'
  | 'revision_conflict'
  | 'validation'
  | 'missing_revision'
  | 'network'
  | 'unknown'

export type ScheduleFailure = {
  kind: ScheduleFailureKind
  /** 可直接展示的中文说明；不回显正文、凭据或供应商原始响应。 */
  message: string
  /** 为 true 时页面应重新读取列表（状态已与服务端不一致）。 */
  needsReload: boolean
}

export type ScheduleAction = 'list' | 'get' | 'create' | 'update' | 'delete' | 'toggle'

function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

function readServerMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 把错误整理成「用户能懂 + 页面该怎么恢复」。
 *
 * 只按状态码判断，不 import HTTP 错误类：
 * Mock 与 HTTP 两种客户端抛出的都是带 `status` 的错误，页面不需要区分来源。
 */
export function describeScheduleFailure(error: unknown, action: ScheduleAction): ScheduleFailure {
  const status = readStatus(error)
  const serverMessage = readServerMessage(error)

  if (status === null) {
    return {
      kind: 'network',
      message: action === 'create'
        ? '网络中断，无法确认是否已保存；稍后重试会沿用同一个创建键，不会重复创建。'
        : '网络中断，改动未确认；请稍后重新读取确认结果。',
      needsReload: action !== 'create',
    }
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: '这条日程已不存在（可能已被删除）。',
      needsReload: true,
    }
  }
  if (status === 409) {
    return {
      kind: 'revision_conflict',
      message: action === 'create'
        ? '同一个创建请求已提交过不同内容（409）；请重新读取列表确认是否已存在。要按当前内容新建，请取消后重新点「新建日程」（会使用新的创建键）。'
        : '这条日程已被其他操作修改（版本冲突）；已重新读取，请基于最新内容再改。',
      needsReload: true,
    }
  }
  if (status === 422) {
    return {
      kind: 'validation',
      message: serverMessage ?? '提交内容不合法，请检查标题与时间。',
      needsReload: false,
    }
  }
  if (status === 428) {
    return {
      kind: 'missing_revision',
      message: '缺少版本号，无法安全提交；请重新读取后再试。',
      needsReload: true,
    }
  }
  return {
    kind: 'unknown',
    message: serverMessage ?? `请求失败（HTTP ${status}）。`,
    needsReload: false,
  }
}

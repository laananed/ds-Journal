/**
 * 独立日程（C01）的**本地 Mock 注入实现**。
 *
 * 用途只有两个：让页面组件现在就能开发/演示交互；让后续接真实后端时只换一个工厂。
 *
 * 明确边界（不得被描述成别的意思）：
 * - 数据只存在**当前页面的内存**里，刷新即丢，**不是持久化**，也不写数据库；
 * - 没有经过任何真实 HTTP 往返，**不能**用来声称后端接口可用；
 * - 自然语言建议是**固定桩**，不做真实解析、不调用真实模型，**不是模型通过**；
 * - 不触碰 Set / 目标关联：这里没有、也不会有任何相关调用。
 *
 * 但语义尽量贴着 §13 走（分页 20、按开始时间与 ID 排序、`client_create_id` 幂等、
 * `expected_revision` CAS、404/409/422/428、硬删除且无变化不增版），
 * 这样页面在 Mock 下验证过的交互，换成 HTTP 客户端后行为一致。
 */

import type {
  Schedule,
  ScheduleCreateInput,
  ScheduleId,
  ScheduleListPage,
  ScheduleSuggestionProvider,
  ScheduleSuggestionResult,
  ScheduleUpdateInput,
  SchedulesClient,
} from '../types/schedule.ts'
import { ScheduleApiError } from './schedules.ts'
import { compareSchedulesByStartThenId, scheduleKey } from '../utils/scheduleTime.ts'
import { SCHEDULE_TITLE_MAX_CODE_POINTS, countCodePoints } from '../utils/scheduleForm.ts'

/** §13：固定每页 20。 */
const PAGE_SIZE = 20

type CreateRecord = {
  fingerprint: string
  id: ScheduleId
}

type MockOptions = {
  /** 预置数据（会被复制，调用方后续改动不影响 Mock 内部状态）。 */
  initial?: Schedule[]
  /** 仅用于让 `created_at`/`updated_at` 可预测；默认取当前时间。 */
  now?: () => Date
}

function fail(status: number, message: string, code?: string): never {
  throw new ScheduleApiError(status, message, code)
}

function requireTitle(title: unknown): string {
  if (typeof title !== 'string') fail(422, '请求内容不合法：title 必须是字符串。')
  const trimmed = title.trim()
  if (trimmed === '') fail(422, '标题不能为空。')
  if (countCodePoints(trimmed) > SCHEDULE_TITLE_MAX_CODE_POINTS) {
    fail(422, `标题最多 ${SCHEDULE_TITLE_MAX_CODE_POINTS} 个字符。`)
  }
  return title
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(422, `请求内容不合法：${field} 必须是带时区的 ISO 时间。`)
  }
  if (Number.isNaN(Date.parse(value))) {
    fail(422, `请求内容不合法：${field} 无法解析为时间。`)
  }
  return value
}

/**
 * 校验「开始 + 结束」这一对字段（已存在的另一端沿用当前值）。
 * 结束时间必须**严格晚于**开始时间，相等也算不合法。
 */
function requireRange(startsAt: string, endsAt: string | null): void {
  if (endsAt === null) return
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    fail(422, '结束时间必须晚于开始时间。')
  }
}

/**
 * 创建 Mock 客户端。
 *
 * 返回的 `source` 恒为 `'mock'`，页面据此显示 Mock 横幅——这不是可选提示，
 * 是「不能把 Mock 当成真实后端」的结构性保证。
 */
export function createMockSchedulesClient(options: MockOptions = {}): SchedulesClient {
  const now = options.now ?? ((): Date => new Date())
  let items: Schedule[] = (options.initial ?? []).map((item) => ({ ...item }))
  const creates = new Map<string, CreateRecord>()
  let nextId = items.reduce((max, item) => {
    const numeric = typeof item.id === 'number' ? item.id : Number(item.id)
    return Number.isFinite(numeric) ? Math.max(max, numeric + 1) : max
  }, 1)

  function find(id: ScheduleId): Schedule {
    const key = scheduleKey(id)
    const found = items.find((item) => scheduleKey(item.id) === key)
    if (found === undefined) fail(404, '日程不存在。', 'not_found')
    return found
  }

  function touch(target: Schedule): void {
    target.updated_at = now().toISOString()
  }

  return {
    source: 'mock',

    async list(page: number, signal?: AbortSignal): Promise<ScheduleListPage> {
      if (signal?.aborted === true) throw new DOMException('已取消', 'AbortError')
      const safePage = Number.isInteger(page) && page >= 1 ? page : 1
      const sorted = [...items].sort(compareSchedulesByStartThenId)
      const start = (safePage - 1) * PAGE_SIZE
      return {
        items: sorted.slice(start, start + PAGE_SIZE).map((item) => ({ ...item })),
        page: safePage,
        has_next: start + PAGE_SIZE < sorted.length,
      }
    },

    async get(id: ScheduleId, signal?: AbortSignal): Promise<Schedule> {
      if (signal?.aborted === true) throw new DOMException('已取消', 'AbortError')
      return { ...find(id) }
    },

    async create(input: ScheduleCreateInput): Promise<Schedule> {
      if (typeof input.client_create_id !== 'string' || input.client_create_id.trim() === '') {
        fail(422, '请求内容不合法：缺少 client_create_id。')
      }
      const title = requireTitle(input.title)
      const startsAt = requireInstant(input.starts_at, 'starts_at')
      const endsAt = input.ends_at === null ? null : requireInstant(input.ends_at, 'ends_at')
      requireRange(startsAt, endsAt)
      if (typeof input.completed !== 'boolean') {
        fail(422, '请求内容不合法：completed 必须是布尔值。')
      }

      // 幂等：同键同 payload 返回同一资源；同键不同 payload 报 409。
      const fingerprint = JSON.stringify({ title, starts_at: startsAt, ends_at: endsAt, completed: input.completed })
      const recorded = creates.get(input.client_create_id)
      if (recorded !== undefined) {
        if (recorded.fingerprint === fingerprint) return { ...find(recorded.id) }
        fail(409, '同一个 client_create_id 已提交过不同内容。', 'client_create_conflict')
      }

      const timestamp = now().toISOString()
      const created: Schedule = {
        id: nextId,
        title,
        starts_at: startsAt,
        ends_at: endsAt,
        completed: input.completed,
        revision: 1,
        created_at: timestamp,
        updated_at: timestamp,
      }
      nextId += 1
      items = [...items, created]
      creates.set(input.client_create_id, { fingerprint, id: created.id })
      return { ...created }
    },

    async update(id: ScheduleId, input: ScheduleUpdateInput): Promise<Schedule> {
      const target = find(id)
      if (typeof input.expected_revision !== 'number' || !Number.isInteger(input.expected_revision)) {
        fail(428, '缺少 expected_revision。', 'revision_required')
      }
      if (input.expected_revision !== target.revision) {
        fail(409, '版本已过期。', 'revision_conflict')
      }

      const nextStartsAt = input.starts_at === undefined
        ? target.starts_at
        : requireInstant(input.starts_at, 'starts_at')
      let nextEndsAt = target.ends_at
      if (input.ends_at !== undefined) {
        nextEndsAt = input.ends_at === null ? null : requireInstant(input.ends_at, 'ends_at')
      }
      requireRange(nextStartsAt, nextEndsAt)
      const nextTitle = input.title === undefined ? target.title : requireTitle(input.title)
      if (input.completed !== undefined && typeof input.completed !== 'boolean') {
        fail(422, '请求内容不合法：completed 必须是布尔值。')
      }

      // 无实际变化：200 返回原资源，不增版、不改时间。
      const changed = nextTitle !== target.title
        || Date.parse(nextStartsAt) !== Date.parse(target.starts_at)
        || (nextEndsAt === null ? target.ends_at !== null : (target.ends_at === null || Date.parse(nextEndsAt) !== Date.parse(target.ends_at)))
        || (input.completed !== undefined && input.completed !== target.completed)
      if (!changed) return { ...target }

      target.title = nextTitle
      target.starts_at = nextStartsAt
      target.ends_at = nextEndsAt
      if (input.completed !== undefined) target.completed = input.completed
      target.revision += 1
      touch(target)
      return { ...target }
    },

    async remove(id: ScheduleId, expectedRevision: number): Promise<void> {
      const target = find(id)
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
        fail(428, '缺少 If-Match 版本。', 'revision_required')
      }
      if (expectedRevision !== target.revision) {
        fail(409, '版本已过期。', 'revision_conflict')
      }
      // 硬删除，只删这一条；不触碰 Set / 目标关联。
      items = items.filter((item) => scheduleKey(item.id) !== scheduleKey(target.id))
    },
  }
}

type SuggestionMockOptions = {
  /** 模拟「模型不可用」：请求直接失败，用来验证手动日程仍可操作。 */
  fail?: boolean
  /** 给候选一个开始时间（UTC ISO），用来走「完整可保存」的路径；默认 null。 */
  candidateStartsAt?: string | null
}

/**
 * **固定桩**建议提供者：不做自然语言时间解析，不调用真实模型。
 *
 * 默认返回「缺少时间」的候选，用来把 §13 的规则摆到台面上：
 * 时间不足的候选必须由用户补充，页面不得替用户编时间。
 * 情绪字段是写死的假数据，界面会标成「推测」并注明不保存。
 */
export function createMockScheduleSuggestionProvider(
  options: SuggestionMockOptions = {},
): ScheduleSuggestionProvider {
  return async (input): Promise<ScheduleSuggestionResult> => {
    if (options.fail === true) {
      throw new ScheduleApiError(503, 'Mock：模型不可用（模拟故障）。', 'provider_unavailable')
    }
    const text = input.text.trim()
    if (text === '') return { candidates: [], mood: null }
    return {
      candidates: [
        {
          candidate_id: 'mock-candidate-1',
          title: text,
          starts_at: options.candidateStartsAt ?? null,
          ends_at: null,
        },
      ],
      mood: {
        label: '平静',
        note: 'Mock 固定值，非真实模型输出',
        confidence: 'low',
      },
    }
  }
}

/**
 * 独立日程（Stage 4 结题 C01）的前端类型 —— **仅 C01 专属**。
 *
 * 权威契约：`docs/stage4-api.md` §13「结题日程 C01 的边界草案」。
 * 本文件只描述前端消费的最小形状，**不代表后端已实现**：
 * C01 后端（`backend/app/schedule/`）、迁移与公共类型由 Codex 持有，
 * 后端交付前本文件的字段以 §13 草案为准，属待对齐项（见交付简报「已知问题」）。
 *
 * 刻意不做的事：
 * - 不 import 任何既有公共类型（journal/document/ritual 等），避免与 T02/T06/T10 交叉；
 * - 不引入「情绪」「关联目标」等 §13 未定义的字段——情绪推测只存在于建议候选，
 *   不落日程字段，接口也没有对应字段，不能靠前端伪造。
 */

/**
 * 日程 ID。
 *
 * §13 只写了 `{id}`，没有规定是整数还是 UUID；而 `client_create_id` 明确是 UUID。
 * C01 后端未交付前**不猜具体类型**：这里按联合类型声明，前端一律用
 * `scheduleKey()` 归一成字符串做列表 key / Map 键 / URL 片段，两种实现都能工作。
 * 后端确认后由 Codex 收窄为单一类型，本文件随之简化。
 */
export type ScheduleId = number | string

/** 日程资源。时间字段为**带时区** ISO 字符串，存储 UTC，展示按 Asia/Shanghai。 */
export type Schedule = {
  id: ScheduleId
  /** 非空，最多 80 Unicode 码点（按码点计，不是 UTF-16 长度）。 */
  title: string
  /** 开始时间，带时区 ISO。 */
  starts_at: string
  /** 结束时间，同格式或 null；非 null 时必须晚于 `starts_at`。 */
  ends_at: string | null
  completed: boolean
  /** CAS 版本号；PATCH/DELETE 必须带上，实际变化才增版。 */
  revision: number
  created_at: string
  updated_at: string
}

/** `GET /api/schedules?page=N`：按开始时间与 ID 稳定排序、每页 20。 */
export type ScheduleListPage = {
  items: Schedule[]
  page: number
  has_next: boolean
}

/**
 * `POST /api/schedules` 请求体。
 *
 * `client_create_id` 是幂等键：同一键 + 相同首次 payload 返回同一资源，
 * 同键不同 payload 返回 409。因此**重试必须复用同一个键**，不能每次点击都换。
 */
export type ScheduleCreateInput = {
  title: string
  starts_at: string
  ends_at: string | null
  completed: boolean
  client_create_id: string
}

/**
 * `PATCH /api/schedules/{id}` 请求体：只带**变化字段**。
 *
 * `expected_revision` 缺失 428、无效字段 422、版本过期 409。
 */
export type ScheduleUpdateInput = {
  expected_revision: number
  title?: string
  starts_at?: string
  ends_at?: string | null
  completed?: boolean
}

/**
 * 注入式数据访问接口。
 *
 * 页面组件只依赖这个接口，因此：
 * - 现在可以接 `schedulesMock.ts` 的**本地内存 Mock** 开发与演示；
 * - C01 后端交付后，换成 `schedules.ts` 的 HTTP 实现即可，页面无需改动；
 * - 入口（`App.tsx`）与真实后端接线由 Codex 负责，本组件不自带全局单例。
 *
 * `source` 是给界面展示用的**来源标识**：Mock 必须在界面上明示，
 * 不能让人误以为已连上数据库或真实模型。
 */
export type SchedulesClient = {
  readonly source: 'http' | 'mock'
  list(page: number, signal?: AbortSignal): Promise<ScheduleListPage>
  get(id: ScheduleId, signal?: AbortSignal): Promise<Schedule>
  create(input: ScheduleCreateInput): Promise<Schedule>
  update(id: ScheduleId, input: ScheduleUpdateInput): Promise<Schedule>
  /** 硬删除，只需目标日程自身的版本；不触碰 Set / 目标关联。 */
  remove(id: ScheduleId, expectedRevision: number): Promise<void>
}

/**
 * 建议候选：自然语言解析出的**待确认**结果。
 *
 * 它只是本地候选对象，**不是**日程资源：确认前不产生任何写入，
 * 确认后也要用户点保存、走上面的 `create`。
 */
export type ScheduleSuggestionCandidate = {
  /** 候选本地标识，仅用于渲染 key，不发给后端。 */
  candidate_id: string
  title: string
  /** 解析不到时间时为 null —— 此时必须由用户补充，不能替用户编一个时间。 */
  starts_at: string | null
  ends_at: string | null
}

/**
 * 情绪推测结果。
 *
 * §13 只允许 AI「推测」情绪供用户参考，日程资源也没有情绪字段；
 * 因此这里的数据**只用于展示**，标为推测、不作诊断、不写入。
 */
export type MoodInference = {
  /** 例如「平静」；由模型给出，前端不解释成任何医学/心理结论。 */
  label: string
  /** 可选的简短依据，前端原样展示，不改写。 */
  note?: string
  confidence?: 'low' | 'medium' | 'high'
}

/** 一次建议请求的结果：候选 + 可选情绪推测。 */
export type ScheduleSuggestionResult = {
  candidates: ScheduleSuggestionCandidate[]
  mood: MoodInference | null
}

/**
 * 建议提供者（注入）。
 *
 * §13 明确「具体建议端点和付费预算在 C01 实施前单独补充」，
 * 所以后端建议接口尚未定型；这里只是一个**前端占位契约**，
 * 不等于后端已同意该请求/响应形状。未注入时页面只保留手动日程。
 */
export type ScheduleSuggestionProvider = (input: {
  text: string
  signal?: AbortSignal
}) => Promise<ScheduleSuggestionResult>

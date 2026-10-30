/**
 * C01 独立日程组件的浏览器夹具（交叉测试专用，不是产品代码）。
 *
 * 只在 `.workbuddy/` 证据目录内，属于 git 忽略范围，不改产品实现。
 * 目的：把未接线的 SchedulePage 单独挂起来，注入本地内存 Mock + 调用记录，
 * 让测试者能在真实浏览器里核对交互、无障碍与窄屏表现。
 *
 * 明确边界：这里的数据来自 `createMockSchedulesClient()`，只存在页面内存，
 * 不写数据库、不发真实 HTTP、不调用真实模型。任何结论都不得表述为真实服务验证。
 */

import { createRoot } from 'react-dom/client'
import SchedulePage from '../src/pages/SchedulePage.tsx'
import {
  createMockScheduleSuggestionProvider,
  createMockSchedulesClient,
} from '../src/api/schedulesMock.ts'
import type {
  Schedule,
  ScheduleCreateInput,
  ScheduleId,
  ScheduleListPage,
  SchedulesClient,
  ScheduleUpdateInput,
} from '../src/types/schedule.ts'

type Call = { method: string; detail?: unknown }
type HarnessWindow = Window & {
  __calls: Call[]
  __failNextCreate: boolean
  __failNextUpdate: boolean
}

const harnessWindow = window as HarnessWindow
const calls: Call[] = []
harnessWindow.__calls = calls
;(window as any).__failNextList = false
harnessWindow.__failNextCreate = false
harnessWindow.__failNextUpdate = false

/** 记录每一次数据访问，用于判定「候选显示/取消是否零写」。 */
function wrap(base: SchedulesClient): SchedulesClient {
  return {
    source: 'mock',
    async list(page: number, signal?: AbortSignal): Promise<ScheduleListPage> {
      calls.push({ method: 'list', detail: page }); if ((window as any).__failNextList) { (window as any).__failNextList = false; throw new TypeError('Failed to fetch') }
      return base.list(page, signal)
    },
    async get(id: ScheduleId, signal?: AbortSignal): Promise<Schedule> {
      calls.push({ method: 'get', detail: String(id) })
      return base.get(id, signal)
    },
    async create(input: ScheduleCreateInput): Promise<Schedule> {
      calls.push({
        method: 'create',
        detail: { key: input.client_create_id, payload: input, keys: Object.keys(input).sort() },
      })
      if (harnessWindow.__failNextCreate) {
        harnessWindow.__failNextCreate = false
        // 模拟浏览器 fetch 网络中断：抛无 status 的错误。
        throw new TypeError('Failed to fetch')
      }
      return base.create(input)
    },
    async update(id: ScheduleId, input: ScheduleUpdateInput): Promise<Schedule> {
      calls.push({ method: 'update', detail: { id: String(id), input } })
      if (harnessWindow.__failNextUpdate) {
        harnessWindow.__failNextUpdate = false
        throw new TypeError('Failed to fetch')
      }
      return base.update(id, input)
    },
    async remove(id: ScheduleId, expectedRevision: number): Promise<void> {
      calls.push({ method: 'remove', detail: { id: String(id), expectedRevision } })
      return base.remove(id, expectedRevision)
    },
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 合成数据：全部是固定的 UTC 时刻，便于核对上海展示。 */
function seedItems(count: number): Schedule[] {
  const items: Schedule[] = []
  for (let index = 0; index < count; index += 1) {
    const day = 30 + Math.floor(index / 20)
    const hourUtc = index % 20
    const startsAt = `2026-10-${pad(day)}T${pad(hourUtc)}:00:00.000Z`
    items.push({
      id: index + 1,
      title: `合成日程 ${index + 1}`,
      starts_at: startsAt,
      ends_at: index % 3 === 0 ? `2026-10-${pad(day)}T${pad(hourUtc)}:30:00.000Z` : null,
      completed: index % 5 === 0,
      revision: 1,
      created_at: '2026-10-29T00:00:00.000Z',
      updated_at: '2026-10-29T00:00:00.000Z',
    })
  }
  return items
}

const params = new URLSearchParams(window.location.search)
const seed = Number(params.get('seed') ?? '3')
const suggestMode = params.get('suggest') ?? 'ok'
const candidateStart = params.get('candidateStart')

const client = wrap(createMockSchedulesClient({ initial: seedItems(Number.isFinite(seed) ? seed : 0) }))

const suggest = suggestMode === 'none'
  ? undefined
  : createMockScheduleSuggestionProvider({
    fail: suggestMode === 'fail',
    candidateStartsAt: candidateStart,
  })

const root = document.getElementById('root')
if (root === null) throw new Error('夹具缺少 #root')

createRoot(root).render(
  <SchedulePage client={client} suggest={suggest} />,
)




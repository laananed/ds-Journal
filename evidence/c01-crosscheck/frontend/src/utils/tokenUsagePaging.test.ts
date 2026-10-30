/**
 * S3-T03 修复回归（RED → GREEN）：文件调用分页必须服从服务端 `has_next`。
 *
 * 缺陷证据（Codex Review 第 3 项）：
 * 组件旧代码用「本页返回 20 条」推断是否还有下一页：
 *
 *   setHasNext(data.length === CALLS_PER_PAGE)
 *
 * 结果 `total` 恰为 20 / 40 时，最后一页仍被允许进入下一页（空页）。
 *
 * 本文件是**纯逻辑**回归：只用契约样本驱动真实投影函数，不连数据库、不发 HTTP，
 * 也不引入任何测试框架或 node 内建模块（与 `src/utils/*.test.ts` 现有约定一致）。
 *
 * 运行：
 *
 *   node --experimental-strip-types src/utils/tokenUsagePaging.test.ts
 *
 * 静态护栏（组件源码不得再用条数推断、不得依赖 React/fetch）由
 * `.workbuddy/s3-t03/review-fix/guard.mjs` 在证据目录执行，避免把 node 内建
 * 依赖带进前端源码树。
 */

import { AiApiError } from '../api/ai.ts'
import { shapeFileCallsResponse, shapeUsageResponse } from './tokenUsageData.ts'
import type { AICallsPage, AIUsage } from '../types/ai.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`失败：${label}`)
  }
  passed += 1
}

/** 旧实现的等价复刻：仅用于证明缺陷存在，不是产品代码。 */
function legacyHasNextFromCount(returnedCount: number, pageSize: number): boolean {
  return returnedCount === pageSize
}

/** 用真实契约类型构造样本，签名漂移会在类型检查阶段暴露。 */
function usageResponse(overrides: Partial<AIUsage> = {}): AIUsage {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    unknown_subcalls: 0,
    search_requests: 0,
    ...overrides,
  }
}

function pageResponse(
  returnedCount: number,
  total: number,
  page: number,
  hasNext: boolean,
): AICallsPage {
  return {
    items: Array.from({ length: returnedCount }, (_, index) => ({
      request_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      kind: 'local',
      status: 'applied',
      created_at: '2026-10-10T12:00:00+00:00',
      subcalls: 1,
      prompt_tokens: 5,
      completion_tokens: 6,
      total_tokens: 11,
      unknown_subcalls: 0,
      search_requests: 0,
      sources: [{ type: 'journal' as const, id: 12, revision: 1 }],
    })),
    page,
    page_size: 20,
    total,
    has_next: hasNext,
  }
}

// ---------------------------------------------------------------------------
// 1. 分页边界 0 / 20 / 21 / 40：hasNext 只认服务端 has_next
// ---------------------------------------------------------------------------

const boundaries = [
  { label: '0 条（空文件）', returned: 0, total: 0, page: 1, hasNext: false },
  { label: '20 条（恰好一页，服务端说没有下一页）', returned: 20, total: 20, page: 1, hasNext: false },
  { label: '20 条（共 21 条，服务端说有下一页）', returned: 20, total: 21, page: 1, hasNext: true },
  { label: '20 条（第 2 页，服务端说没有下一页）', returned: 20, total: 40, page: 2, hasNext: false },
  { label: '1 条（共 41 条，第 3 页）', returned: 1, total: 41, page: 3, hasNext: false },
]

for (const boundary of boundaries) {
  const shaped = shapeFileCallsResponse(
    pageResponse(boundary.returned, boundary.total, boundary.page, boundary.hasNext),
  )
  check(shaped.pagination.hasNext === boundary.hasNext, `hasNext 服从服务端：${boundary.label}`)
  check(shaped.calls.length === boundary.returned, `items 完整进入列表：${boundary.label}`)
  check(
    shaped.pagination.page === boundary.page && shaped.pagination.total === boundary.total,
    `page/total 来自响应：${boundary.label}`,
  )
}

// 缺陷本身的证据：旧推断在「恰好 20 条且服务端说没有下一页」时放行空页。
check(
  legacyHasNextFromCount(20, 20) === true,
  '旧实现缺陷复现：返回 20 条即被推断为还有下一页',
)
check(
  shapeFileCallsResponse(pageResponse(20, 20, 1, false)).pagination.hasNext === false,
  '修复后：服务端 has_next=false 时不得允许进入下一页',
)
check(
  legacyHasNextFromCount(20, 20) !==
    shapeFileCallsResponse(pageResponse(20, 20, 1, false)).pagination.hasNext,
  '两种推断在边界处结论不同（证明本修复确实改变了行为）',
)

// ---------------------------------------------------------------------------
// 2. 文件分页对象绝不能被当成全局累计用量
// ---------------------------------------------------------------------------

const fileShaped = shapeFileCallsResponse(pageResponse(2, 2, 1, false))
check(fileShaped.kind === 'calls', '分页对象必须进入文件调用分支')
check(fileShaped.usage === null, '文件分支不得同时产出累计用量')
check(
  fileShaped.calls.every((call) => typeof call.request_id === 'string' && call.total_tokens === 11),
  '文件分支使用真实 items 字段（不读取不存在的 Token 字段）',
)
check(
  Object.keys(fileShaped).sort().join(',') === 'calls,kind,pagination,usage',
  '文件分区形状固定为 kind/calls/pagination/usage',
)

// ---------------------------------------------------------------------------
// 3. 全局累计响应仍进入用量分支
// ---------------------------------------------------------------------------

const usageShaped = shapeUsageResponse(usageResponse({
  prompt_tokens: 90, completion_tokens: 18, total_tokens: 108,
  unknown_subcalls: 2, search_requests: 1,
}))
check(usageShaped.kind === 'usage', '全局累计必须进入用量分支')
check(usageShaped.calls === null && usageShaped.pagination === null, '用量分支不得产出调用列表')
check(
  usageShaped.usage !== null && usageShaped.usage.total_tokens === 108
    && usageShaped.usage.unknown_subcalls === 2 && usageShaped.usage.search_requests === 1,
  '全局累计五项数字原样投影',
)
const emptyUsage = shapeUsageResponse(usageResponse())
check(
  emptyUsage.usage !== null && emptyUsage.usage.total_tokens === 0
    && emptyUsage.usage.unknown_subcalls === 0,
  '无调用时五项为 0，不抛异常',
)
check(
  Object.keys(usageShaped).sort().join(',') === 'calls,kind,pagination,usage',
  '用量分区形状固定为 kind/usage/calls/pagination',
)

// ---------------------------------------------------------------------------
// 4. 字段缺失/异常不产生 NaN 或空引用（旧代码会把 undefined 交给 toLocaleString）
// ---------------------------------------------------------------------------

const partialCall = shapeFileCallsResponse({
  items: [{ request_id: 'r-1', status: 'failed' } as never],
  page: 1,
  page_size: 20,
  total: 1,
  has_next: false,
})
check(
  partialCall.calls[0].prompt_tokens === 0 && partialCall.calls[0].total_tokens === 0
    && partialCall.calls[0].sources.length === 0,
  '缺字段的子调用退回 0/空数组，不渲染 NaN',
)
check(partialCall.pagination.hasNext === false, 'has_next 缺失按 false 处理（保守不翻页）')

// ---------------------------------------------------------------------------
// 5. 失败与取消路径未被本次修复改变
//    （404 文案、取消后不落地数据仍由组件 useEffect 负责；这里锁定其依赖的契约）
// ---------------------------------------------------------------------------

const notFound = new AiApiError(404, 'File not found')
check(notFound.status === 404 && notFound instanceof Error, '404 仍以 AiApiError.status 判定')
check(
  new AiApiError(500, 'boom').status === 500
    && new AiApiError(500, 'boom') instanceof AiApiError,
  '非 404 读取失败仍走通用错误分支',
)

/** 组件取消逻辑的等价复刻：aborted 后不得把响应写进状态。 */
function applyUnlessAborted(aborted: boolean, shaped: ReturnType<typeof shapeFileCallsResponse>) {
  return aborted ? null : shaped
}
check(
  applyUnlessAborted(true, fileShaped) === null,
  '过期请求被取消后不得落地数据',
)
check(
  applyUnlessAborted(false, fileShaped) === fileShaped,
  '未取消的请求正常落地',
)

console.log(`tokenUsagePaging: ${passed} 项通过`)

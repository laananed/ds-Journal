/**
 * 日程分页收敛测试（C01 / D2）。
 *
 * 运行：`node --experimental-strip-types src/utils/schedulePaging.test.ts`
 *
 * 交叉测试 D2 的复现条件：共 21 条 → 第 2 页只有 1 条 → 删掉它，
 * 页面留在第 2 页并显示「还没有日程」，而第 1 页其实还有 20 条。
 * 这里既测**判定函数**，也用 Mock 客户端走一遍「删除 → 读空 → 回退 → 再读」的真实顺序，
 * 证明回退后拿到的是第 1 页的数据，而不是空列表。
 *
 * 边界说明：Mock 只验证组件侧的分页收敛；真实后端的分页/越界行为未验证（C01 后端未交付）。
 */

import { createMockSchedulesClient } from '../api/schedulesMock.ts'
import { pageAfterEmptyRead } from './schedulePaging.ts'
import { scheduleKey } from './scheduleTime.ts'

let assertions = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  assertions += 1
  if (actual !== expected) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`)
}

function expectTrue(value: boolean, label: string): void {
  assertions += 1
  if (!value) throw new Error(`${label}：期望 true`)
}

/* ------------------------------------------------ 纯判定 */

expectEqual(pageAfterEmptyRead({ page: 2, items: [] }), 1, '末页删空回退到上一页')
expectEqual(pageAfterEmptyRead({ page: 3, items: [] }), 2, '只退一页，不直接跳回第一页')
expectEqual(pageAfterEmptyRead({ page: 1, items: [] }), null, '第一页为空是真正的空列表')
expectEqual(pageAfterEmptyRead({ page: 2, items: [{}] }), null, '本页有数据不回退')
expectEqual(pageAfterEmptyRead({ page: 0, items: [] }), null, '非法页码（0）不回退，避免死循环')
expectEqual(pageAfterEmptyRead({ page: Number.NaN, items: [] }), null, '非法页码（NaN）不回退')

/* ------------------------------------------------ 21 条：末页删空 */

function isoAt(day: number, hour: number, minute = 0): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `2026-10-${pad(day)}T${pad(hour)}:${pad(minute)}:00.000Z`
}

const client = createMockSchedulesClient()
for (let index = 0; index < 21; index += 1) {
  await client.create({
    title: `日程 ${index}`,
    starts_at: isoAt(30, index % 24, index),
    ends_at: null,
    completed: false,
    client_create_id: `paging-${index}`,
  })
}

const firstPage = await client.list(1)
expectEqual(firstPage.items.length, 20, '第 1 页 20 条')
expectEqual(firstPage.has_next, true, '第 1 页有下一页')

const lastPage = await client.list(2)
expectEqual(lastPage.items.length, 1, '第 2 页只有 1 条')
expectEqual(lastPage.page, 2, '页码回显为 2')

const onlyOnLastPage = lastPage.items[0]
expectTrue(onlyOnLastPage !== undefined, '末页存在唯一一条')

// 删除末页唯一一条（真实顺序：先删成功，再刷新当前页）。
if (onlyOnLastPage !== undefined) {
  await client.remove(onlyOnLastPage.id, onlyOnLastPage.revision)
}

const emptiedPage = await client.list(2)
expectEqual(emptiedPage.items.length, 0, '删除后第 2 页确实为空')
expectEqual(pageAfterEmptyRead(emptiedPage), 1, '空页判定要求回退到第 1 页')

const fallbackPage = pageAfterEmptyRead(emptiedPage)
const targetPage = fallbackPage ?? emptiedPage.page
const afterFallback = await client.list(targetPage)
expectEqual(afterFallback.items.length, 20, '回退后第 1 页仍有 20 条（不是空列表）')
expectEqual(afterFallback.page, 1, '回退后的页码为 1')
expectEqual(afterFallback.has_next, false, '总量降到 20 条后没有下一页')
expectTrue(
  afterFallback.items.every((item) => scheduleKey(item.id) !== scheduleKey(onlyOnLastPage?.id ?? -1)),
  '被删的那条不再出现',
)

// 不重复删除：同一条再删一次必须是 404，而不是「成功」。
if (onlyOnLastPage !== undefined) {
  assertions += 1
  try {
    await client.remove(onlyOnLastPage.id, onlyOnLastPage.revision)
    throw new Error('重复删除应该失败')
  } catch (error) {
    const status = (error as { status?: unknown }).status
    if (status !== 404) throw new Error(`重复删除：期望 404，实际 ${String(status)}`)
  }
}

// 不重复创建：删除后不会有额外条目被悄悄补回。
expectEqual((await client.list(1)).items.length, 20, '删除后总量为 20，没有重复创建')

/* ------------------------------------------------ 第一页唯一一条 */

const single = createMockSchedulesClient()
const only = await single.create({
  title: '唯一一条',
  starts_at: isoAt(30, 9),
  ends_at: null,
  completed: false,
  client_create_id: 'only-one',
})
await single.remove(only.id, only.revision)

const emptyFirstPage = await single.list(1)
expectEqual(emptyFirstPage.items.length, 0, '第一页唯一一条被删后为空')
expectEqual(pageAfterEmptyRead(emptyFirstPage), null, '第一页为空不回退（整体确实没有日程）')

/* ------------------------------------------------ 多页末页（不足 20 条的尾页） */

const manyPages = createMockSchedulesClient()
for (let index = 0; index < 41; index += 1) {
  await manyPages.create({
    title: `批量 ${index}`,
    starts_at: isoAt(30, index % 24, index % 60),
    ends_at: null,
    completed: false,
    client_create_id: `bulk-${index}`,
  })
}

const thirdPage = await manyPages.list(3)
expectEqual(thirdPage.items.length, 1, '41 条时第 3 页 1 条')
const tail = thirdPage.items[0]
if (tail !== undefined) await manyPages.remove(tail.id, tail.revision)

const emptiedThird = await manyPages.list(3)
expectEqual(pageAfterEmptyRead(emptiedThird), 2, '第 3 页删空回退到第 2 页')
const secondAfterFallback = await manyPages.list(2)
expectEqual(secondAfterFallback.items.length, 20, '第 2 页仍有 20 条')

console.log(`schedulePaging: ${assertions} assertions passed`)

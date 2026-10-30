/**
 * Mock 日程客户端的契约行为测试（C01）。
 *
 * 运行：`node --experimental-strip-types src/api/schedulesMock.test.ts`
 *
 * 为什么测 Mock 也要认真：页面在 Mock 下验证到的交互（完成/删除/冲突提示）
 * 只有在 Mock 也遵守 §13 语义时才有意义。这里覆盖
 * 分页 20、开始时间排序、`client_create_id` 幂等、`expected_revision` CAS、
 * 404/409/422/428 与「无变化不增版」。
 *
 * 注意：这不证明任何后端行为，只证明**本地 Mock** 的语义；真实 HTTP 闭环待 C01 后端交付。
 */

import { createMockSchedulesClient, createMockScheduleSuggestionProvider } from './schedulesMock.ts'

let assertions = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  assertions += 1
  if (actual !== expected) throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`)
}

function expectTrue(value: boolean, label: string): void {
  assertions += 1
  if (!value) throw new Error(`${label}：期望 true`)
}

/** 断言 Promise 以指定 HTTP 状态失败。 */
async function expectStatus(run: () => Promise<unknown>, status: number, label: string): Promise<void> {
  assertions += 1
  try {
    await run()
  } catch (error) {
    const actual = (error as { status?: unknown }).status
    if (actual !== status) throw new Error(`${label}：期望状态 ${status}，实际 ${String(actual)}`)
    return
  }
  throw new Error(`${label}：期望抛出 ${status}，实际成功`)
}

function isoAt(day: number, hour: number, minute = 0): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `2026-10-${pad(day)}T${pad(hour)}:${pad(minute)}:00.000Z`
}

/* ------------------------------------------------ 分页与排序 */

const paging = createMockSchedulesClient()
for (let index = 0; index < 25; index += 1) {
  await paging.create({
    title: `日程 ${index}`,
    // 故意倒序写入，验证读取时按开始时间排序。
    starts_at: isoAt(30, 23 - (index % 20), index % 60),
    ends_at: null,
    completed: false,
    client_create_id: `key-${index}`,
  })
}

const firstPage = await paging.list(1)
expectEqual(firstPage.items.length, 20, '首页 20 条')
expectEqual(firstPage.has_next, true, '首页还有下一页')
const secondPage = await paging.list(2)
expectEqual(secondPage.items.length, 5, '第二页 5 条')
expectEqual(secondPage.has_next, false, '第二页没有下一页')
expectEqual(secondPage.page, 2, '页码回显')

const startsAtValues = firstPage.items.map((item) => Date.parse(item.starts_at))
const sortedAscending = startsAtValues.every((value, index) => index === 0 || (startsAtValues[index - 1] ?? 0) <= value)
expectTrue(sortedAscending, '列表按开始时间升序')

/* ------------------------------------------------ 创建幂等 */

const idem = createMockSchedulesClient()
const payload = {
  title: '晨跑',
  starts_at: isoAt(30, 0),
  ends_at: null,
  completed: false,
  client_create_id: 'fixed-key',
}
const createdFirst = await idem.create(payload)
const createdAgain = await idem.create(payload)
expectEqual(createdAgain.id, createdFirst.id, '同键同 payload 返回同一资源')
expectEqual((await idem.list(1)).items.length, 1, '幂等重放不产生第二条')
expectEqual(createdFirst.revision, 1, '创建为版本 1')

await expectStatus(
  async () => idem.create({ ...payload, title: '换标题' }),
  409,
  '同键不同 payload 报 409',
)

await expectStatus(
  async () => idem.create({ ...payload, client_create_id: 'other', title: '   ' }),
  422,
  '空标题报 422',
)
await expectStatus(
  async () => idem.create({
    ...payload,
    client_create_id: 'range-1',
    starts_at: isoAt(30, 10),
    ends_at: isoAt(30, 9),
  }),
  422,
  '结束早于开始报 422',
)
await expectStatus(
  async () => idem.create({
    ...payload,
    client_create_id: 'range-2',
    starts_at: isoAt(30, 10),
    ends_at: isoAt(30, 10),
  }),
  422,
  '结束等于开始报 422',
)
await expectStatus(
  async () => idem.create({ ...payload, client_create_id: 'bad-time', starts_at: '不是时间' }),
  422,
  '非法时间报 422',
)

/* ------------------------------------------------ 更新 CAS */

const cas = createMockSchedulesClient()
const target = await cas.create({
  title: '写周报',
  starts_at: isoAt(30, 2),
  ends_at: null,
  completed: false,
  client_create_id: 'cas-key',
})

await expectStatus(
  async () => cas.update(target.id, { expected_revision: 99, title: '旧版本' }),
  409,
  '过期版本报 409',
)

const completedUpdate = await cas.update(target.id, { expected_revision: 1, completed: true })
expectEqual(completedUpdate.completed, true, '完成状态已更新')
expectEqual(completedUpdate.revision, 2, '实际变化后增版')

const noChange = await cas.update(target.id, { expected_revision: 2, completed: true })
expectEqual(noChange.revision, 2, '无变化不增版')

const retitled = await cas.update(target.id, { expected_revision: 2, title: '写周报（终稿）' })
expectEqual(retitled.title, '写周报（终稿）', '标题已更新')
expectEqual(retitled.revision, 3, '标题变化增版')

await expectStatus(
  async () => cas.update(target.id, { expected_revision: 3, ends_at: isoAt(30, 1) }),
  422,
  '结束早于已有开始时间报 422',
)

await expectStatus(
  async () => cas.update(9999, { expected_revision: 1, completed: true }),
  404,
  '更新不存在的日程报 404',
)

await expectStatus(
  async () => cas.update(target.id, { expected_revision: undefined as unknown as number, completed: false }),
  428,
  '缺版本号报 428',
)

/* ------------------------------------------------ 硬删除 */

const removal = createMockSchedulesClient()
const keep = await removal.create({
  title: '保留',
  starts_at: isoAt(30, 1),
  ends_at: null,
  completed: false,
  client_create_id: 'keep',
})
const drop = await removal.create({
  title: '删除我',
  starts_at: isoAt(30, 2),
  ends_at: null,
  completed: false,
  client_create_id: 'drop',
})

await expectStatus(async () => removal.remove(drop.id, 99), 409, '删除版本过期报 409')
await removal.remove(drop.id, 1)
const afterDelete = await removal.list(1)
expectEqual(afterDelete.items.length, 1, '只删掉目标那一条')
expectEqual(afterDelete.items[0]?.id, keep.id, '相邻日程不受影响')
await expectStatus(async () => removal.get(drop.id), 404, '硬删除后再读报 404')
await expectStatus(async () => removal.remove(drop.id, 1), 404, '重复删除报 404')

/* ------------------------------------------------ 来源标识与建议桩 */

const mockClient = createMockSchedulesClient()
expectEqual(mockClient.source, 'mock', 'Mock 客户端必须自报 mock 来源')

const suggestions = createMockScheduleSuggestionProvider()
const suggestionResult = await suggestions({ text: '明天下午三点和导师讨论' })
expectEqual(suggestionResult.candidates.length, 1, '建议桩返回 1 条候选')
expectEqual(suggestionResult.candidates[0]?.starts_at, null, '建议桩不编造时间')
expectEqual(suggestionResult.mood?.label, '平静', '情绪为推测字段')
expectTrue((suggestionResult.mood?.note ?? '').includes('Mock'), '情绪注明是 Mock 固定值')

const failingSuggestions = createMockScheduleSuggestionProvider({ fail: true })
await expectStatus(async () => failingSuggestions({ text: '任意' }), 503, '模拟模型不可用报 503')

console.log(`schedulesMock: ${assertions} assertions passed`)

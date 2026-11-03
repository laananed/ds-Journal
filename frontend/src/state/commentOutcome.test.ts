import * as requests from './writingRequests.ts'

const outcome = (requests as unknown as { commentApplyMessage?: (comments: Array<{ anchor_state: string }> | undefined) => string }).commentApplyMessage
function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label)
}
check(typeof outcome === 'function', '评论应用结果应按实际数量生成状态提示')
check(/没有生成评论/.test(outcome!([])), '空结果不能显示已写入')
check(/1 条/.test(outcome!([{ anchor_state: 'available' }])), '显示实际生成数量')
check(/无法定位/.test(outcome!([{ anchor_state: 'unavailable' }])), '失锚时保留侧栏提示')
check(/无法确认/.test(outcome!(undefined)), '缺少数量时不能声称成功')
console.log('comment outcomes: passed')

const lastPage = (requests as unknown as { lastCommentsPage?: (total: number, pageSize: number) => number }).lastCommentsPage
check(typeof lastPage === 'function', '新增评论应展示最新一页')
check(lastPage!(0, 20) === 1 && lastPage!(20, 20) === 1 && lastPage!(21, 20) === 2, '按总数计算评论末页')

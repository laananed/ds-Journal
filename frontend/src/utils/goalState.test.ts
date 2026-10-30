import { goalsForDisplay, reviewSourceAvailable } from './goalState.ts'

const goals = [
  { id: 'a', checked: true, answer: { text: '保留' } },
  { id: 'b', checked: false, answer: { text: '回答' } },
  { id: 'c', checked: true, answer: { text: '不变' } },
  { id: 'd', checked: false, answer: { text: '原样' } },
]
const before = JSON.stringify(goals)
const displayed = goalsForDisplay(goals)
if (displayed.map(goal => goal.id).join(',') !== 'b,d,a,c') throw new Error('展示顺序应为未完成在前，同状态保持原顺序')
if (JSON.stringify(goals) !== before) throw new Error('派生排序不能改写原正文或回答')
if (displayed[0] !== goals[1]) throw new Error('排序不能重建或改写目标及回答')
if (goalsForDisplay([]).length !== 0) throw new Error('空列表应保持为空')
if (!reviewSourceAvailable({ link_id: 'a' })) throw new Error('有效链接应显示来源可用')
if (reviewSourceAvailable({ link_id: null })) throw new Error('解除关联后应显示来源不可用')

/**
 * `goalItem`：开始今天里的目标节点（API §2 节点表）。
 *
 * 目标 canonical 文字与完成状态由服务端按跨文件规则维护，本任务只做
 * 呈现：T07 才接入双向同步与勾选写入，所以这里的复选框是**只读镜像**，
 * 不提供本地切换，避免出现「界面改了但没同步」的假状态。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome, SYSTEM_HINT } from './support.ts'

export const GoalItem = Node.create({
  name: 'goalItem',
  group: 'block',
  atom: true,
  defining: true,
  isolating: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => (typeof attributes.id === 'string' ? { 'data-id': attributes.id } : {}),
      },
      goal_id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-goal-id'),
        renderHTML: (attributes) => (typeof attributes.goal_id === 'string' ? { 'data-goal-id': attributes.goal_id } : {}),
      },
      text: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-goal-text') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({ 'data-goal-text': attributes.text }),
      },
      checked: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-goal-checked') === 'true',
        renderHTML: (attributes) => ({ 'data-goal-checked': String(attributes.checked === true) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-stage4-node="goalItem"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'goalItem', class: 's4-node s4-node-goalItem' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' }, ['span', { class: 's4-node-label' }, '目标']],
      ['div', { class: 's4-node-body' }, ['p', { class: 's4-node-text' }, String(node.attrs.text ?? '')]],
    ]
  },

  addNodeView() {
    return ({ node }) => {
      const { dom, body } = createChrome({ className: 's4-node-goalItem', label: '目标', hint: SYSTEM_HINT })
      const row = document.createElement('div')
      row.className = 's4-goal-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 's4-goal-check'
      box.disabled = true
      box.tabIndex = -1
      const text = document.createElement('span')
      text.className = 's4-goal-text'
      row.append(box, text)
      body.append(row)

      const render = (attrs: Record<string, unknown>) => {
        box.checked = attrs.checked === true
        text.textContent = String(attrs.text ?? '')
        box.setAttribute('aria-label', `目标${attrs.checked === true ? '已完成' : '未完成'}（只读镜像）`)
      }
      render(node.attrs)

      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'goalItem') return false
          render(updated.attrs)
          return true
        },
      }
    }
  },
})

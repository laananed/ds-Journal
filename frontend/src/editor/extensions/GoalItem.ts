/**
 * `goalItem`：开始今天里的目标节点（API §2 节点表）。
 *
 * 目标 canonical 文字与完成状态由服务端按跨文件规则维护，本任务只做
 * 呈现：T07 才接入双向同步与勾选写入，所以这里的复选框是**只读镜像**，
 * 不提供本地切换，避免出现「界面改了但没同步」的假状态。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome, SYSTEM_HINT } from './support.ts'

export const GoalItem = Node.create<{ onGoalTextChange: ((goalId: string, text: string) => void) | null; onGoalCursorChange: ((nodeId: string, offset: number) => void) | null }>({
  name: 'goalItem',
  addOptions() { return { onGoalTextChange: null, onGoalCursorChange: null } },
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
    const onGoalTextChange = this.options.onGoalTextChange
    const onGoalCursorChange = this.options.onGoalCursorChange
    return ({ node, editor, getPos }) => {
      const { dom, body } = createChrome({ className: 's4-node-goalItem', label: '目标', ...(onGoalTextChange ? {} : { hint: SYSTEM_HINT }) })
      const row = document.createElement('div')
      row.className = 's4-goal-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 's4-goal-check'
      box.disabled = true
      box.tabIndex = -1
      const text = document.createElement(onGoalTextChange ? 'textarea' : 'span')
      text.className = 's4-goal-text'
      if (text instanceof HTMLTextAreaElement) {
        text.rows = 1
        text.setAttribute('aria-label', '编辑目标')
        const reportCursor = () => {
          const position = getPos()
          const current = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null
          if (current?.type.name !== 'goalItem' || typeof current.attrs.id !== 'string') return
          onGoalCursorChange?.(current.attrs.id, Array.from(text.value.slice(0, text.selectionStart ?? 0)).length)
        }
        for (const name of ['focus', 'click', 'keyup', 'select']) text.addEventListener(name, reportCursor)
        const resize = () => { text.style.height = 'auto'; text.style.height = `${Math.max(text.scrollHeight, 28)}px` }
        text.addEventListener('beforeinput', (event) => { if (!editor.isEditable) event.preventDefault() })
        text.addEventListener('input', () => {
          resize()
          if (!editor.isEditable) return
          const position = getPos()
          if (typeof position !== 'number') return
          const current = editor.state.doc.nodeAt(position)
          if (current?.type.name !== 'goalItem') return
          const value = text.value
          if (value === current.attrs.text) return
          editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, text: value })
            .setMeta('stage4System', true))
          onGoalTextChange?.(String(current.attrs.goal_id), value)
          reportCursor()
        })
      }
      row.append(box, text)
      body.append(row)

      const render = (attrs: Record<string, unknown>) => {
        box.checked = attrs.checked === true
        const value = String(attrs.text ?? '')
        if (text instanceof HTMLTextAreaElement) {
          if (text.value !== value && document.activeElement !== text) text.value = value
          text.style.height = 'auto'
          text.style.height = `${Math.max(text.scrollHeight, 28)}px`
        } else text.textContent = value
        box.setAttribute('aria-label', `目标${attrs.checked === true ? '已完成' : '未完成'}（只读镜像）`)
      }
      render(node.attrs)

      return {
        dom,
        stopEvent: (event) => event.target === text,
        ignoreMutation: () => true,
        update(updated) {
          if (updated.type.name !== 'goalItem') return false
          render(updated.attrs)
          return true
        },
      }
    }
  },
})

/**
 * `aiPlaceholder`：Go Deeper prepare 阶段的稳定占位（API §2、§7）。
 *
 * 原子节点、没有正文：占位只标记「这里有一次已登记的请求」，在它之后
 * 用户可以继续写。真正替换占位由 T08 的 apply 完成，本任务不做 AI 调用。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome, setBodyText } from './support.ts'

export const AiPlaceholder = Node.create({
  name: 'aiPlaceholder',
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
      request_id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-request-id'),
        renderHTML: (attributes) => (typeof attributes.request_id === 'string' ? { 'data-request-id': attributes.request_id } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-stage4-node="aiPlaceholder"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'aiPlaceholder', class: 's4-node s4-node-aiPlaceholder' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' }, ['span', { class: 's4-node-label' }, 'AI 生成中']],
      ['div', { class: 's4-node-body' }, ['p', { class: 's4-node-text' }, '已登记请求，等待回应。可继续在下方书写。']],
    ]
  },

  addNodeView() {
    return () => {
      const { dom, body } = createChrome({
        className: 's4-node-aiPlaceholder',
        label: 'AI 生成中',
        hint: '占位 · 可继续在下方书写',
      })
      setBodyText(body, '已登记请求，等待回应。')
      return { dom }
    }
  },
})

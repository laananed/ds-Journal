/**
 * `aiSummary`：完整复盘保存的 AI 总结（架构 §3.1、API §2 节点表）。
 *
 * 与 `aiReply` 的差别只有一条：**正文可编辑，但来源（id / request_id）不可改**。
 * 对应服务端规则 `validate_author_changes` 中 `aiSummary` 只比较 attrs 的分支，
 * 因此这里必须提供 contentDOM 让用户改字，身份保护交给事务层守卫。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { AI_AUTHOR_HINT, createChrome } from './support.ts'

export const AiSummary = Node.create({
  name: 'aiSummary',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  isolating: true,

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
    return [{ tag: 'div[data-stage4-node="aiSummary"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'aiSummary', class: 's4-node s4-node-aiSummary' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' }, ['span', { class: 's4-node-label' }, 'AI 复盘'],
        ['span', { class: 's4-node-hint' }, AI_AUTHOR_HINT]],
      ['div', { class: 's4-node-body' }, 0],
    ]
  },

  addNodeView() {
    return () => {
      const { dom, body } = createChrome({
        className: 's4-node-aiSummary',
        label: 'AI 复盘（可编辑，来源不变）',
        hint: AI_AUTHOR_HINT,
      })
      return { dom, contentDOM: body }
    }
  },
})

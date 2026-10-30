/**
 * `aiReply`：Go Deeper 的局部 AI 回复（架构 §3.1、API §2 节点表）。
 *
 * 身份：`id` 与 `request_id` 都由服务端创建，普通写入不得改内容或来源，
 * 删除必须走专用接口。因此本节点在呈现上只是「AI 蓝色容器」，
 * 真正的边界由 `../schema.ts` 的 `DocumentGuards` 在事务层拒绝修改；
 * 这里不额外用 contentEditable=false 与 ProseMirror 争抢选区。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { AI_AUTHOR_HINT, createChrome } from './support.ts'

export const AiReply = Node.create({
  name: 'aiReply',
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
    return [{ tag: 'div[data-stage4-node="aiReply"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'aiReply', class: 's4-node s4-node-aiReply' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' }, ['span', { class: 's4-node-label' }, 'AI 回复']],
      ['div', { class: 's4-node-body' }, 0],
    ]
  },

  addNodeView() {
    return () => {
      const { dom, body } = createChrome({ className: 's4-node-aiReply', label: 'AI 回复', hint: AI_AUTHOR_HINT })
      return { dom, contentDOM: body }
    }
  },
})

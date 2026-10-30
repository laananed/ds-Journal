/**
 * `goalReview`：结束今天里的目标回顾镜像（API §2 节点表）。
 *
 * 结构是「系统标题 + 用户答案子树」：`review_title`、`goal_snapshot`、
 * `checked_snapshot`、`link_id` 只由服务维护，content 里的段落是用户答案，
 * **必须可编辑**。展示置底属于 T07 的派生视图，这里保持正文顺序。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome } from './support.ts'

export const GoalReview = Node.create({
  name: 'goalReview',
  group: 'block',
  content: 'paragraph*',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => (typeof attributes.id === 'string' ? { 'data-id': attributes.id } : {}),
      },
      link_id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-link-id'),
        renderHTML: (attributes) => (typeof attributes.link_id === 'string' ? { 'data-link-id': attributes.link_id } : {}),
      },
      goal_snapshot: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-goal-snapshot') ?? '',
        renderHTML: (attributes) => ({ 'data-goal-snapshot': attributes.goal_snapshot }),
      },
      checked_snapshot: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-goal-checked') === 'true',
        renderHTML: (attributes) => ({ 'data-goal-checked': String(attributes.checked_snapshot === true) }),
      },
      review_title: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-review-title') ?? '',
        renderHTML: (attributes) => ({ 'data-review-title': attributes.review_title }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-stage4-node="goalReview"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'goalReview', class: 's4-node s4-node-goalReview' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' },
        ['span', { class: 's4-node-label' }, '回顾'],
        ['span', { class: 's4-node-hint' }, String(node.attrs.goal_snapshot ?? '')]],
      ['div', { class: 's4-node-body' }, 0],
    ]
  },

  addNodeView() {
    return ({ node }) => {
      const { dom, body } = createChrome({ className: 's4-node-goalReview', label: '回顾' })
      const title = document.createElement('p')
      title.className = 's4-goal-review-title'
      title.contentEditable = 'false'
      const snapshot = document.createElement('p')
      snapshot.className = 's4-goal-review-snapshot'
      snapshot.contentEditable = 'false'
      const sourceStatus = document.createElement('p')
      sourceStatus.className = 's4-goal-review-source-status'
      sourceStatus.contentEditable = 'false'
      sourceStatus.setAttribute('role', 'status')
      body.before(title, snapshot, sourceStatus)

      const render = (attrs: Record<string, unknown>) => {
        title.textContent = String(attrs.review_title ?? '')
        snapshot.textContent = String(attrs.goal_snapshot ?? '')
        snapshot.dataset.checked = attrs.checked_snapshot === true ? 'true' : 'false'
        sourceStatus.textContent = attrs.link_id === null ? '目标来源不可用，已保留回顾和回答。' : ''
        sourceStatus.hidden = attrs.link_id !== null
      }
      render(node.attrs)

      return {
        dom,
        contentDOM: body,
        update(updated) {
          if (updated.type.name !== 'goalReview') return false
          render(updated.attrs)
          return true
        },
      }
    }
  },
})

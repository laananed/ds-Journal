/**
 * `ritualQuestion`：插入正文的问题模板快照（API §2 节点表）。
 *
 * 插入时保存当时文字，之后改模板不回写正文；它不是用户事实，
 * 不进投影 U。用户要在问题后面写答案，所以它是原子块而不是容器。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome, SYSTEM_HINT, setBodyText } from './support.ts'

export const RitualQuestion = Node.create({
  name: 'ritualQuestion',
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
      template_question_id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-template-question-id'),
        renderHTML: (attributes) => (typeof attributes.template_question_id === 'string'
          ? { 'data-template-question-id': attributes.template_question_id }
          : {}),
      },
      question_snapshot: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-question') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({ 'data-question': attributes.question_snapshot }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-stage4-node="ritualQuestion"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'ritualQuestion', class: 's4-node s4-node-ritualQuestion' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' }, ['span', { class: 's4-node-label' }, '问题模板']],
      ['div', { class: 's4-node-body' }, ['p', { class: 's4-node-text' }, String(node.attrs.question_snapshot ?? '')]],
    ]
  },

  addNodeView() {
    return ({ node }) => {
      const { dom, body } = createChrome({ className: 's4-node-ritualQuestion', label: '问题模板', hint: SYSTEM_HINT })
      setBodyText(body, String(node.attrs.question_snapshot ?? ''))
      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'ritualQuestion') return false
          setBodyText(body, String(updated.attrs.question_snapshot ?? ''))
          return true
        },
      }
    }
  },
})

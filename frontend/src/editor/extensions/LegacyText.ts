/**
 * `legacyText`：无法证明安全转换的旧正文段（架构 §10.1、API §2）。
 *
 * 旧 blocks 记录在本轮**保持 legacy**：这个节点只保证原文逐字可读，
 * 不假装它已经被转换成可编辑结构。
 *
 * 作者规则与服务端 `validate_author_changes` 对齐：
 * - `author: "user"`：可改 `raw_text`，但 `id` / `author` 不可变；
 * - `author: "ai"`：整段受保护，只读呈现，也不进入用户投影 U。
 */

import { mergeAttributes, Node } from '@tiptap/core'
import { createChrome, LEGACY_HINT } from './support.ts'

const isUserAuthor = (author: unknown) => author === 'user'

export const LegacyText = Node.create({
  name: 'legacyText',
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
      raw_text: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-raw-text') ?? element.textContent ?? '',
        renderHTML: (attributes) => ({ 'data-raw-text': attributes.raw_text }),
      },
      author: {
        default: 'user',
        parseHTML: (element) => (element.getAttribute('data-author') === 'ai' ? 'ai' : 'user'),
        renderHTML: (attributes) => ({ 'data-author': attributes.author }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-stage4-node="legacyText"]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-stage4-node': 'legacyText', class: 's4-node s4-node-legacyText' }),
      ['div', { class: 's4-node-head', contenteditable: 'false' },
        ['span', { class: 's4-node-label' }, node.attrs.author === 'ai' ? '旧格式 · AI 原文' : '旧格式原文'],
        ['span', { class: 's4-node-hint' }, LEGACY_HINT]],
      ['div', { class: 's4-node-body' }, ['pre', { class: 's4-legacy-pre' }, String(node.attrs.raw_text ?? '')]],
    ]
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const user = isUserAuthor(node.attrs.author)
      const { dom, body } = createChrome({
        className: 's4-node-legacyText',
        label: user ? '旧格式原文（可编辑）' : '旧格式 · AI 原文（只读）',
        hint: LEGACY_HINT,
      })

      let control: HTMLTextAreaElement | null = null
      let pre: HTMLPreElement | null = null

      if (user) {
        control = document.createElement('textarea')
        control.className = 's4-legacy-input'
        control.rows = Math.min(12, Math.max(3, String(node.attrs.raw_text ?? '').split('\n').length))
        control.value = String(node.attrs.raw_text ?? '')
        control.setAttribute('aria-label', '旧格式原文（可编辑，作者身份不变）')
        control.addEventListener('input', () => {
          const position = typeof getPos === 'function' ? getPos() : undefined
          if (typeof position !== 'number' || control === null) return
          const value = control.value
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, raw_text: value }),
          )
        })
        body.append(control)
      } else {
        pre = document.createElement('pre')
        pre.className = 's4-legacy-pre'
        pre.textContent = String(node.attrs.raw_text ?? '')
        body.append(pre)
      }

      return {
        dom,
        update(updated) {
          if (updated.type.name !== 'legacyText') return false
          current = updated
          const raw = String(updated.attrs.raw_text ?? '')
          if (control !== null && document.activeElement !== control) control.value = raw
          if (pre !== null) pre.textContent = raw
          return true
        },
        // 旧文控件的手势与输入完全由 textarea 自己处理，不让 ProseMirror 介入。
        stopEvent: (event) => control !== null && event.target instanceof HTMLElement && control.contains(event.target),
        ignoreMutation: () => true,
      }
    }
  },
})

import { Node } from '@tiptap/core'

type Block = { id: string; kind: string; text: string; request_id?: string }

export const LegacyBlocks = Node.create({
  name: 'legacyBlocks', group: 'block', atom: true, defining: true, isolating: true,
  addAttributes() { return { id: { default: null }, format_version: { default: 1 }, blocks: { default: [] } } },
  parseHTML() { return [] },
  renderHTML() { return ['div', { 'data-stage4-node': 'legacyBlocks' }] },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node
      const dom = document.createElement('div')
      const draw = () => {
        dom.replaceChildren()
        const blocks = current.attrs.blocks as Block[]
        blocks.forEach((block, index) => {
          const field = document.createElement(block.kind === 'user' || block.kind === 'ai_summary' ? 'textarea' : 'pre')
          field.setAttribute('aria-label', block.kind === 'user' ? '旧格式用户正文' : '旧格式 AI 正文')
          if (field instanceof HTMLTextAreaElement) {
            field.value = block.text
            field.readOnly = !editor.isEditable
            field.addEventListener('input', () => {
              const pos = typeof getPos === 'function' ? getPos() : undefined
              if (typeof pos !== 'number') return
              const next = (current.attrs.blocks as Block[]).map((item, i) => i === index ? { ...item, text: field.value } : item)
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, blocks: next }))
            })
          } else field.textContent = block.text
          dom.append(field)
        })
      }
      draw()
      return { dom, update(updated) { if (updated.type.name !== 'legacyBlocks') return false; current = updated; if (!dom.contains(document.activeElement)) draw(); return true },
        stopEvent(event) { return event.target instanceof HTMLTextAreaElement }, ignoreMutation: () => true }
    }
  },
})

/**
 * Stage 4 / S04-T03：统一的 `RichTextEditor`（编辑 + 只读共用一套基础）。
 *
 * 对外只有五个约定（`docs/stage4-tasks.md` §3.4、§3.12）：
 * - `doc`：服务端 `content_doc`；受控输入，外部换版本时整体替换；
 * - `readOnly`：只读，不建 ID、不发 `onUserChange`（Trash/阅读态复用）；
 * - `onUserChange`：**只**在真实用户输入后上报，载荷已按服务端白名单归一；
 * - `onSelection`：当前选区对应的用户段落 ID 与 Unicode 码点区间，
 *   供后续 Minds 范围分析使用（ProseMirror 是 UTF-16，必须显式换算）；
 * - `onLink`：正文里 `[[显示标题]]` 被用户点击时上报标题（T11 内部链接）。
 *   只认普通文本位置，代码块与行内代码里不激活；编辑态需要 Ctrl/⌘ + 点击，
 *   避免抢走普通点击的定位光标语义。注册了回调才可能拦截点击。
 *
 * 不在这里做保存、不做会话、不做 AI 调用：写队列属于 T02，
 * 目标同步属于 T07，AI 执行/应用属于 T08。本组件是纯受控视图。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { Extension, type Editor, type JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { EditorContent, useEditor } from '@tiptap/react'
import type { ContentDocument } from '../types/document.ts'
import { DOCUMENT_SCHEMA_VERSION, SYSTEM_ORIGIN, buildExtensions, isSafeHref, toEditorDocument, toServerDocument } from './schema.ts'
import { findInternalLinkAt, internalLinkTokens } from '../utils/internalLinks.ts'
import './RichTextEditor.css'

/** 选区信息；`start`/`end` 是块内 Unicode 码点半开区间（API §2.1）。 */
export interface EditorSelectionInfo {
  empty: boolean
  /** 选区块的稳定 ID；跨块或落在非段落块时为 null。 */
  blockId: string | null
  start: number
  end: number
  text: string
}

export interface RichTextEditorProps {
  doc: ContentDocument | null
  readOnly?: boolean
  onUserChange?: (document: ContentDocument, schemaVersion: number) => void
  onSelection?: (selection: EditorSelectionInfo | null) => void
  /** 点击正文内部链接（`[[显示标题]]`）时上报标题；不传则不拦截任何点击。 */
  onLink?: (title: string) => void
  /** 可访问名称，例如「正文」「日记正文」。 */
  label?: string
  className?: string
}

const TEXTBLOCKS = new Set(['paragraph', 'heading'])
const codePointLength = (text: string) => Array.from(text).length

/* ------------------------------------------------- 内部链接 `[[标题]]` */

/**
 * 内部链接 `[[标题]]`（S04-T11 D2）。
 *
 * 不新增 schema 节点：`[[标题]]` 在 JSON 里就是普通文字，这里只做两件事。
 *
 * 1. **落点**：命中位置换算成「文本块 + 块内偏移」，再在块文本里找 token；
 * 2. **装饰**：给命中的文字加 `s4-internal-link` 类与 `data-internal-title`，
 *    让阅读态看得出「这是链接」，也给浏览器测试一个稳定的落点。
 *
 * 代码块直接跳过；行内代码按 `code` mark 判定跳过——「代码区域不激活」是产品契约。
 * 点击激活本身在组件里用 DOM 事件处理（见下方 effect）。
 */

/** 文本块 + 点击位置在块内的偏移；不在可激活的文本块内返回 null。 */
function textBlockAt(doc: PMNode, pos: number): { node: PMNode; offset: number } | null {
  const $pos = doc.resolve(pos)
  let depth = $pos.depth
  while (depth > 0 && !TEXTBLOCKS.has($pos.node(depth).type.name)) depth -= 1
  if (depth === 0) return null
  const node = $pos.node(depth)
  if (node.type.name === 'codeBlock') return null
  // 只处理「位置就落在该文本块的文字里」的情况；块边界不猜偏移。
  if (node !== $pos.parent) return null
  return { node, offset: $pos.textOffset }
}

function hasCodeMark(node: PMNode, start: number, end: number): boolean {
  const code = node.type.schema.marks.code
  return code !== undefined && node.rangeHasMark(start, end, code)
}

function internalLinkTitleAt(doc: PMNode, pos: number): string | null {
  const block = textBlockAt(doc, pos)
  if (block === null) return null
  const text = block.node.textBetween(0, block.node.content.size, '\n', '\n')
  const token = findInternalLinkAt(text, block.offset)
  if (token === null) return null
  if (hasCodeMark(block.node, token.start, token.end)) return null
  return token.title
}

function internalLinkDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false
    if (!TEXTBLOCKS.has(node.type.name)) return true
    const text = node.textBetween(0, node.content.size, '\n', '\n')
    for (const token of internalLinkTokens(text)) {
      if (hasCodeMark(node, token.start, token.end)) continue
      decorations.push(Decoration.inline(pos + 1 + token.start, pos + 1 + token.end, {
        class: 's4-internal-link',
        'data-internal-title': token.title,
      }))
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * 只做装饰的扩展：`[[标题]]` 的点击激活在组件里按 DOM 事件处理，
 * 这样回调可以随 props 变化重新绑定，不需要把 ref 在渲染期交给插件。
 */
const InternalLinkDecorations = Extension.create({
  name: 'internalLinkDecorations',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('internalLinkDecorations'),
        props: {
          decorations(state) {
            return internalLinkDecorations(state.doc)
          },
        },
      }),
    ]
  },
})

function describeSelection(editor: Editor): EditorSelectionInfo | null {
  const { from, to, empty } = editor.state.selection
  const $from = editor.state.doc.resolve(from)
  let depth = $from.depth
  while (depth > 0 && !TEXTBLOCKS.has($from.node(depth).type.name)) depth -= 1
  if (depth === 0) return { empty, blockId: null, start: 0, end: 0, text: '' }

  const block = $from.node(depth)
  const blockStart = $from.start(depth)
  const $to = editor.state.doc.resolve(to)
  const sameBlock = $to.depth >= depth && $to.start(depth) === blockStart
  if (!sameBlock) return { empty, blockId: null, start: 0, end: 0, text: '' }

  const offsetFrom = from - blockStart
  const offsetTo = to - blockStart
  const before = block.textBetween(0, offsetFrom, '\n', '\n')
  const selected = block.textBetween(offsetFrom, offsetTo, '\n', '\n')
  const id = typeof block.attrs.id === 'string' ? block.attrs.id : null
  return {
    empty,
    blockId: id,
    start: codePointLength(before),
    end: codePointLength(before + selected),
    text: selected,
  }
}

/** 系统来源地整篇替换；不走用户输入通道，也不进撤销栈。 */
function replaceDocument(editor: Editor, next: JSONContent): boolean {
  let parsed
  try {
    parsed = editor.schema.nodeFromJSON(next)
  } catch {
    return false
  }
  const transaction = editor.state.tr
  transaction.replaceWith(0, editor.state.doc.content.size, parsed.content)
  transaction.setMeta(SYSTEM_ORIGIN, true)
  transaction.setMeta('addToHistory', false)
  editor.view.dispatch(transaction)
  return true
}

function requestLink(editor: Editor): void {
  const previous = editor.getAttributes('link').href
  const input = window.prompt('链接地址（http / https / mailto）', typeof previous === 'string' ? previous : 'https://')
  if (input === null) return
  const href = input.trim()
  if (href === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  if (!isSafeHref(href)) {
    window.alert('只接受 http、https 或 mailto 链接。')
    return
  }
  editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
}

function Toolbar({ editor }: { editor: Editor }) {
  const [, bump] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    const update = () => bump()
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor, bump])

  const buttons: { label: string; title: string; active?: boolean; disabled?: boolean; run: () => void }[] = [
    { label: 'B', title: '粗体', active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'I', title: '斜体', active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'S', title: '删除线', active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: '</>', title: '行内代码', active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    {
      label: 'H2', title: '二级标题', active: editor.isActive('heading', { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: 'H3', title: '三级标题', active: editor.isActive('heading', { level: 3 }),
      run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    { label: '• 列表', title: '无序列表', active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: '1. 列表', title: '有序列表', active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: '☑ 清单', title: '任务清单', active: editor.isActive('taskList'), run: () => editor.chain().focus().toggleTaskList().run() },
    { label: '引用', title: '引用块', active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: '代码块', title: '代码块', active: editor.isActive('codeBlock'), run: () => editor.chain().focus().toggleCodeBlock().run() },
    { label: '链接', title: '插入或移除链接', active: editor.isActive('link'), run: () => requestLink(editor) },
    { label: '撤销', title: '撤销', disabled: !editor.can().undo(), run: () => editor.chain().focus().undo().run() },
    { label: '重做', title: '重做', disabled: !editor.can().redo(), run: () => editor.chain().focus().redo().run() },
  ]

  return (
    <div className="s4-toolbar" role="toolbar" aria-label="正文格式">
      {buttons.map((button) => (
        <button
          key={button.title}
          type="button"
          className={`s4-toolbar-button${button.active === true ? ' is-active' : ''}`}
          title={button.title}
          aria-label={button.title}
          aria-pressed={button.active === true}
          disabled={button.disabled === true}
          // 不抢编辑器焦点，避免点按钮时选区丢失。
          onMouseDown={(event) => event.preventDefault()}
          onClick={button.run}
        >
          {button.label}
        </button>
      ))}
    </div>
  )
}

function RichTextEditor({
  doc, readOnly = false, onUserChange, onSelection, onLink, label, className,
}: RichTextEditorProps) {
  const changeHandler = useRef(onUserChange)
  const selectionHandler = useRef(onSelection)
  useEffect(() => {
    changeHandler.current = onUserChange
    selectionHandler.current = onSelection
  }, [onUserChange, onSelection])

  // 同一次按键会先派发用户事务、再派发 UniqueID 补 ID 的合成事务；
  // 合并成一次上报，避免把「还没有 ID」的中间文档发出去。
  const emitScheduled = useRef(false)

  const scheduleEmit = useCallback((instance: Editor) => {
    if (emitScheduled.current) return
    emitScheduled.current = true
    queueMicrotask(() => {
      emitScheduled.current = false
      const handler = changeHandler.current
      if (handler === undefined || instance.isDestroyed) return
      handler(toServerDocument(instance.getJSON()), DOCUMENT_SCHEMA_VERSION)
    })
  }, [])

  const reportSelection = useCallback((instance: Editor) => {
    selectionHandler.current?.(describeSelection(instance))
  }, [])

  const editor = useEditor(
    {
      extensions: [
        ...buildExtensions({ readOnly }),
        InternalLinkDecorations,
      ],
      content: toEditorDocument(doc),
      editable: !readOnly,
      editorProps: {
        attributes: {
          class: 's4-editor-content',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label ?? '正文',
        },
      },
      onUpdate: ({ editor: instance, transaction }) => {
        if (transaction.getMeta(SYSTEM_ORIGIN) === true) return
        scheduleEmit(instance)
      },
      onSelectionUpdate: ({ editor: instance }) => {
        reportSelection(instance)
      },
    },
    [readOnly],
  )

  useEffect(() => {
    if (editor === null || editor.isDestroyed) return
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  /**
   * 内部链接点击：只读时普通点击激活；编辑时 Ctrl/⌘ + 点击（普通点击仍用于定位光标）。
   * 用 DOM 事件而不是 ProseMirror 的 `handleClick`，这样回调可以直接跟随 props，
   * 不必把最新回调塞进 ref；命中位置用 `posAtCoords` 换回文档坐标。
   */
  useEffect(() => {
    if (editor === null || editor.isDestroyed || onLink === undefined) return
    const dom = editor.view.dom
    function handleClick(event: MouseEvent): void {
      if (editor === null || editor.isDestroyed || onLink === undefined) return
      if (!readOnly && !event.ctrlKey && !event.metaKey) return
      const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
      if (hit === null) return
      const title = internalLinkTitleAt(editor.state.doc, hit.pos)
      if (title === null) return
      event.preventDefault()
      onLink(title)
    }
    dom.addEventListener('click', handleClick)
    return () => { dom.removeEventListener('click', handleClick) }
  }, [editor, onLink, readOnly])

  // 外部换版本（切换文件 / 服务端重载 / AI apply）时整篇替换；
  // 内容等价则不打断用户输入。
  useEffect(() => {
    if (editor === null || editor.isDestroyed) return
    const incoming = toEditorDocument(doc)
    const incomingKey = JSON.stringify(toServerDocument(incoming))
    if (incomingKey === JSON.stringify(toServerDocument(editor.getJSON()))) return
    replaceDocument(editor, incoming)
  }, [editor, doc])

  if (editor === null) return null

  return (
    <div className={`s4-editor${readOnly ? ' is-readonly' : ''}${className === undefined ? '' : ` ${className}`}`}>
      {!readOnly && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  )
}

export default RichTextEditor

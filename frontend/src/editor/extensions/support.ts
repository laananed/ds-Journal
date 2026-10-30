/**
 * Stage 4 / S04-T03：编辑器 NodeView 共用的 DOM 外壳。
 *
 * 这里是**呈现层**的公共部分：AI、系统与旧文兼容节点都需要一致的
 * 「标题条 + 正文」结构与可访问标注，各扩展只声明自己属于哪一类、
 * 显示什么标签，不各写一套 div 拼装。
 *
 * 不在本文件放业务规则：作者/身份保护在 `../schema.ts` 的
 * `protectedSignature` 与 `DocumentGuards` 插件里，本文件只生成 DOM。
 */

/** AI 段统一说明：这些内容不计入用户事实投影 U（架构 §3.3）。 */
export const AI_AUTHOR_HINT = 'AI 内容 · 不计入用户正文'

/** 系统生成的容器（模板问题、目标镜像、系统标题）的说明。 */
export const SYSTEM_HINT = '系统内容 · 由服务维护'

/** 旧格式兼容节点的说明。 */
export const LEGACY_HINT = '旧格式原文 · 未转换为可编辑结构'

export interface ChromeOptions {
  /** 与 schema 节点名一致的 CSS 修饰类，例如 `s4-node-aiReply`。 */
  className: string
  label: string
  hint?: string
}

export interface Chrome {
  /** NodeView 根元素。 */
  dom: HTMLDivElement
  /** 正文容器；有 content 的节点把它作为 `contentDOM`。 */
  body: HTMLDivElement
}

/**
 * 生成 `<div.s4-node><div.s4-node-head/><div.s4-node-body/></div>`。
 *
 * 标题条固定 `contenteditable=false`：光标不能落进标签文字里，
 * 否则用户「编辑」的会是展示文案而不是正文。
 */
export function createChrome({ className, label, hint }: ChromeOptions): Chrome {
  const dom = document.createElement('div')
  dom.className = `s4-node ${className}`
  dom.setAttribute('data-stage4-node', className.replace('s4-node-', ''))

  const head = document.createElement('div')
  head.className = 's4-node-head'
  head.contentEditable = 'false'
  const labelEl = document.createElement('span')
  labelEl.className = 's4-node-label'
  labelEl.textContent = label
  head.append(labelEl)
  if (hint !== undefined) {
    const hintEl = document.createElement('span')
    hintEl.className = 's4-node-hint'
    hintEl.textContent = hint
    head.append(hintEl)
  }

  const body = document.createElement('div')
  body.className = 's4-node-body'

  dom.append(head, body)
  return { dom, body }
}

/** 原子节点（无 contentDOM）往 body 里写只读文字。 */
export function setBodyText(body: HTMLElement, text: string, className?: string): void {
  body.textContent = ''
  const paragraph = document.createElement('p')
  paragraph.className = className ?? 's4-node-text'
  paragraph.textContent = text
  body.append(paragraph)
}

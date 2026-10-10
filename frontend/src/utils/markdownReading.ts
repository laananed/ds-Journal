import { createElement, type ReactElement } from 'react'
import Markdown, { defaultUrlTransform, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface ReadingNode {
  type: string
  value?: string
  children?: ReadingNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

/** Small remark transform over the renderer's existing tree, not a separate parser. */
function remarkInternalLinks() {
  return (tree: ReadingNode, file: { value: unknown }) => {
    const source = String(file.value)
    function visit(parent: ReadingNode) {
      if (!parent.children || ['link', 'linkReference', 'code', 'inlineCode', 'html'].includes(parent.type)) return
      // CommonMark represents inline HTML tags and their inner text as siblings.
      // Keep their text literal until the corresponding closing tag is reached.
      const htmlTags: string[] = []
      const children: ReadingNode[] = []
      for (const child of parent.children) {
        if (child.type === 'html') {
          for (const tag of (child.value ?? '').matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
            const name = tag[1].toLowerCase()
            if (tag[0].startsWith('</')) {
              const index = htmlTags.lastIndexOf(name)
              if (index !== -1) htmlTags.splice(index)
            } else if (!/\/\s*>$/.test(tag[0]) && !['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'embed', 'source', 'track', 'col', 'param'].includes(name)) {
              htmlTags.push(name)
            }
          }
          children.push(child)
          continue
        }
        if (htmlTags.length) {
          children.push(child)
          continue
        }
        if (child.type !== 'text' || child.value === undefined) {
          visit(child)
          children.push(child)
          continue
        }
        const raw = source.slice(child.position?.start.offset, child.position?.end.offset)
        const escaped = new Set<number>()
        let plain = ''
        for (let index = 0; index < raw.length; index++) {
          if (raw[index] === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(raw[index + 1] ?? '')) {
            escaped.add(plain.length)
            plain += raw[++index]
          } else {
            plain += raw[index]
          }
        }
        let cursor = 0
        for (const match of child.value.matchAll(/(?<!\[)\[\[([^\]\r\n[]+)\]\](?!\])/g)) {
          // Escaped Markdown delimiters are text, not internal-link syntax.
          if (plain === child.value
            ? [match.index, match.index + 1, match.index + match[0].length - 2, match.index + match[0].length - 1].some(index => escaped.has(index))
            : raw !== child.value) continue
          children.push({ type: 'text', value: child.value.slice(cursor, match.index) })
          children.push({
            type: 'link', url: '#internal-link',
            data: { hProperties: { 'data-internal-title': match[1] } },
            children: [{ type: 'text', value: match[0] }],
          } as ReadingNode)
          cursor = match.index + match[0].length
        }
        children.push({ type: 'text', value: child.value.slice(cursor) })
      }
      parent.children = children
    }
    visit(tree)
  }
}

/**
 * S2-T12「最小 Markdown 阅读」的全部渲染配置。
 *
 * 为什么单独放在这个无 JSX 的 .ts 模块里：本项目的纯逻辑测试统一用
 * `node --experimental-strip-types` 直跑，该机制不解析 JSX。把「渲染配置 +
 * 元素构造」放在这里，渲染测试就能直接渲染组件真正使用的那棵树，
 * 而不需要引入测试框架或自建 Markdown 解析器。
 *
 * 三条边界（docs/stage2-architecture.md §8）：
 *
 * 1. 不传 `rehypePlugins`，尤其**不传 rehype-raw**：react-markdown 默认把
 *    原始 HTML 节点降级为普通文本，React 再转义输出；本项目也**永不**使用
 *    `dangerouslySetInnerHTML`，因此 raw HTML 不会被执行。
 * 2. 显式写死默认的 `defaultUrlTransform`（协议白名单 https / http / irc /
 *    ircs / mailto / xmpp），其余带冒号的 URL（`javascript:`、`data:` 等）
 *    会被替换成空串，链接不可执行；显式写法也是防止以后被误改成不安全实现。
 * 3. 只做阅读呈现，不把渲染结果写回数据库：源码仍是数据库里的原始 Markdown，
 *    编辑态仍是普通 textarea。
 *
 * 已批准的依赖：react-markdown@10.1.0、remark-gfm@4.0.1（均为 MIT）。
 * remark-gfm 只为 `- [ ]` / `- [x]` Checklist；标题与数字列表是 CommonMark 核心语法。
 */

/** Checklist 与本地内部链接文本转换；其余语法由 react-markdown 核心提供。 */
export const markdownReadingRemarkPlugins: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkInternalLinks]

/**
 * 构造阅读用的 React 元素。
 *
 * T13 在现有 remark 树的文本节点识别链接，components.a 将带标记的节点
 * 展现为按钮。代码、HTML 和已有链接保持原语义，不修改源字符串。
 */
export function buildMarkdownReadingElement(source: string, onLink?: (title: string) => void, disabled = false): ReactElement {
  return createElement(
    Markdown,
    {
      remarkPlugins: markdownReadingRemarkPlugins,
      urlTransform: defaultUrlTransform,
      components: {
        a: ({ node, children, ...props }) => {
          const title = node?.properties['data-internal-title']
          if (typeof title === 'string') {
            return createElement('button', { type: 'button', className: 'internal-link',
              disabled: disabled || !onLink, onClick: () => onLink?.(title) }, children)
          }
          return createElement('a', props, children)
        },
      },
    },
    source,
  )
}

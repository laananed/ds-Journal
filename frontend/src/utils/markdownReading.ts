import { createElement, type ReactElement } from 'react'
import Markdown, { defaultUrlTransform, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

/** 必需扩展只有 remark-gfm（Checklist）；其余语法由 react-markdown 核心提供。 */
export const markdownReadingRemarkPlugins: NonNullable<Options['remarkPlugins']> = [remarkGfm]

/**
 * 构造阅读用的 React 元素。
 *
 * T13（`[[标题]]` 内部链接）的扩展位置就在这里：链接在阅读文本节点上识别、
 * 跳过 code / fenced code，届时补 `components.a` 即可，不引入 AST 平台。
 * 本任务不实现链接解析，也不引入引用表。
 */
export function buildMarkdownReadingElement(source: string): ReactElement {
  return createElement(
    Markdown,
    {
      remarkPlugins: markdownReadingRemarkPlugins,
      urlTransform: defaultUrlTransform,
    },
    source,
  )
}

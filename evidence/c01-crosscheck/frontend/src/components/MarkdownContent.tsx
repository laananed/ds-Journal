import { buildMarkdownReadingElement } from '../utils/markdownReading'

interface MarkdownContentProps {
  /** 数据库里的原始 Markdown 源码。只读展现，绝不写回。 */
  source: string
  onLink?: (title: string) => void
  disabled?: boolean
}

/**
 * 只读正文的 Markdown 阅读外壳（S2-T12）。
 *
 * Journal / Inbox / Insight 的正常详情与 Trash 详情共用这一个组件，
 * 替换原先的 `<p className="detail-content">{content}</p>`。
 *
 * - 只替换「怎么显示」：保存、Dirty、busy、请求与刷新逻辑仍由各页面自己负责；
 * - 渲染配置全部在 `utils/markdownReading.ts`（无 JSX，便于用既有 node 测试机制断言）；
 * - 外层保留 `detail-content` 原有的卡片样式，另加 `markdown-body` 阅读排版。
 */
function MarkdownContent({ source, onLink, disabled }: MarkdownContentProps) {
  return (
    <div className="detail-content markdown-body">
      {buildMarkdownReadingElement(source, onLink, disabled)}
    </div>
  )
}

export default MarkdownContent

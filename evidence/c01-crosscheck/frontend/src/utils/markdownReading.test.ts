import { renderToStaticMarkup } from 'react-dom/server'
import { buildMarkdownReadingElement, markdownReadingRemarkPlugins } from './markdownReading.ts'

/**
 * S2-T12 渲染测试：用真实依赖（react-markdown@10.1.0 + remark-gfm@4.0.1）
 * 把阅读元素渲染成 HTML 字符串后断言，不引入测试框架，
 * 与其它 `src/utils/*.test.ts` 一样用
 * `node --experimental-strip-types` 直跑。
 *
 * 覆盖的是组件真正渲染的那棵树（MarkdownContent.tsx 只多包一层 div）。
 */

let passed = 0

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(label)
  passed += 1
}

function render(source: string): string {
  return renderToStaticMarkup(buildMarkdownReadingElement(source))
}

function inputTags(html: string): string[] {
  return html.match(/<input\b[^>]*>/g) ?? []
}

// A. 指定语法：一/二/三级标题
const headings = render('# 一级标题\n\n## 二级标题\n\n### 三级标题\n')
check(headings.includes('<h1>一级标题</h1>'), `h1 missing: ${headings}`)
check(headings.includes('<h2>二级标题</h2>'), `h2 missing: ${headings}`)
check(headings.includes('<h3>三级标题</h3>'), `h3 missing: ${headings}`)

// B. Checklist：只读、零事件处理
const tasks = render('- [ ] 未完成\n- [x] 已完成\n')
const boxes = inputTags(tasks)
check(boxes.length === 2, `expected 2 checkbox inputs, got ${boxes.length}: ${tasks}`)
check(boxes.every((tag) => tag.includes('type="checkbox"')), `checkbox type missing: ${tasks}`)
check(boxes.every((tag) => tag.includes('disabled')), `checkbox must be disabled: ${tasks}`)
check(!boxes[0].includes('checked'), `first checkbox must be unchecked: ${boxes[0]}`)
check(boxes[1].includes('checked'), `second checkbox must be checked: ${boxes[1]}`)
check(!/\son(change|click|input|submit)=/i.test(tasks), `checklist must not carry event handlers: ${tasks}`)

// C. 数字列表
const ordered = render('1. 第一项\n2. 第二项\n')
check(ordered.includes('<ol>'), `ol missing: ${ordered}`)
check((ordered.match(/<li>/g) ?? []).length === 2, `expected 2 li, got: ${ordered}`)
check(ordered.includes('第一项') && ordered.includes('第二项'), `ordered items missing: ${ordered}`)

// D. 缩进、空行、换行按源码保留：围栏代码块内不得被折叠
const fenced = render('```\nif (a) {\n  缩进两格\n\n空行之后\n}\n```\n')
check(
  fenced.includes('if (a) {\n  缩进两格\n\n空行之后\n}'),
  `fenced code must keep indentation, blank lines and newlines: ${fenced}`,
)
// 四空格缩进代码块（Markdown 语义即缩进），空行分段为两个段落
const indented = render('前一段\n\n    const a = 1\n\n后一段\n')
check(indented.includes('<pre><code>const a = 1'), `indented code block missing: ${indented}`)
check((indented.match(/<p>/g) ?? []).length === 2, `blank line must split paragraphs: ${indented}`)

// E. raw HTML 不执行：只作为转义后的普通文本出现
const rawHtml = render(
  '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<div class="note">注</div>\n\n<b>粗体</b>\n',
)
check(!rawHtml.includes('<script'), `script element must not be created: ${rawHtml}`)
check(!rawHtml.includes('<img'), `img element from raw HTML must not be created: ${rawHtml}`)
check(!rawHtml.includes('<div'), `div element from raw HTML must not be created: ${rawHtml}`)
check(!rawHtml.includes('<b>'), `b element from raw HTML must not be created: ${rawHtml}`)
check(rawHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), `raw HTML must appear escaped: ${rawHtml}`)
check(!/<[a-z][^>]*\sonerror=/i.test(rawHtml), `no real tag may carry onerror: ${rawHtml}`)

// F. 危险协议与空目标（S2-F01）：只显示文字，不生成可导航锚点——
//    defaultUrlTransform 把危险协议转成空串后，旧实现仍输出 <a href="">，
//    点击会重载应用、丢失导航状态；现在空 href 一律渲染为纯文字。
const unsafeLinks = render(
  '[点我](javascript:alert(1))\n\n[数据](data:text/html;base64,PHNjcmlwdD4=)\n\n[旧式](vbscript:msgbox)\n\n[大小写](JaVaScRiPt:alert(1))\n',
)
check(
  !/href="(?:javascript|data|vbscript):/i.test(unsafeLinks),
  `dangerous protocols must not survive in href: ${unsafeLinks}`,
)
check(!unsafeLinks.includes('<a'), `dangerous links must not render as anchors: ${unsafeLinks}`)
check(!unsafeLinks.includes('href=""'), `no empty href may remain: ${unsafeLinks}`)
check(
  unsafeLinks.includes('点我') && unsafeLinks.includes('数据') && unsafeLinks.includes('旧式') && unsafeLinks.includes('大小写'),
  `dangerous link text must still display: ${unsafeLinks}`,
)
const emptyTarget = render('[空目标]()\n')
check(!emptyTarget.includes('<a'), `empty-target link must not render as an anchor: ${emptyTarget}`)
check(emptyTarget.includes('空目标'), `empty-target text must still display: ${emptyTarget}`)
const mixed = render('[坏](javascript:alert(1)) 和 [好](https://example.com)\n')
check((mixed.match(/<a /g) ?? []).length === 1, `only the legal link may stay an anchor: ${mixed}`)
check(mixed.includes('href="https://example.com"'), `legal link must keep its href: ${mixed}`)
const safeLinks = render(
  '[开放](https://example.com/a?b=1)\n\n[邮件](mailto:someone@example.com)\n\n[相对](/local/path)\n',
)
check(safeLinks.includes('href="https://example.com/a?b=1"'), `https href must be kept: ${safeLinks}`)
check(safeLinks.includes('href="mailto:someone@example.com"'), `mailto href must be kept: ${safeLinks}`)
check(safeLinks.includes('href="/local/path"'), `relative href must be kept: ${safeLinks}`)
// F2. 内部链接保持 T13 按钮行为：S2-F01 只针对普通锚点，不得影响内部链接。
const internal = render('[[标题]]\n')
check(internal.includes('<button'), `internal link must stay a button: ${internal}`)
check(internal.includes('class="internal-link"'), `internal link button class kept: ${internal}`)
check(!internal.includes('<a'), `internal link must not render an anchor: ${internal}`)
// 文本中的特殊字符仍由 React 转义（说明渲染器没有绕过 React 输出原始 HTML）
check(render('a & b < c\n').includes('a &amp; b &lt; c'), 'text must be escaped by React')

// G. 结构保证：元素树里不存在 dangerouslySetInnerHTML；只启用获批的一个插件
const element = buildMarkdownReadingElement('# 标题\n')
check(!JSON.stringify(element).includes('dangerouslySetInnerHTML'), 'element tree must not use dangerouslySetInnerHTML')
check(markdownReadingRemarkPlugins.length === 2, 'remark-gfm and the local internal-link transform are enabled')

// H. 纯空白 / 空源码不抛错、不产生元素
check(render('   \n\n  \n').replace(/\s/g, '') === '', 'whitespace-only source must render no elements')
check(render('').replace(/\s/g, '') === '', 'empty source must render no elements')

// I. 纯函数：同一源码渲染两次结果一致
const sample = '# 标题\n\n- [x] 完成\n\n1. 一\n'
check(render(sample) === render(sample), 'rendering must be deterministic')

console.log(`markdownReading: ${passed} assertions passed`)

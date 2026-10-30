import { renderToStaticMarkup } from 'react-dom/server'
import { findInternalLinkAt, internalLinkTokens } from './internalLinks.ts'
import { buildMarkdownReadingElement } from './markdownReading.ts'

let passed = 0
function check(ok: boolean, label: string) {
  if (!ok) throw new Error(label)
  passed++
}
function render(source: string) {
  return renderToStaticMarkup(buildMarkdownReadingElement(source, () => {}))
}
const active = (html: string) => (html.match(/class="internal-link"/g) ?? []).length
for (const source of ['[[标题]]', '# [[标题]]', '- [[标题]]', '**[[标题]]**', '> [[标题]]', '[[ A &+# ]]']) {
  check(active(render(source)) === 1, `must activate: ${source}`)
}
for (const source of ['`[[代码]]`', '```\n[[代码]]\n```', '    [[代码]]', '<div>[[HTML]]</div>',
  '<span>[[HTML]]</span>', '<a href="/">[[HTML]]</a>', '[[未闭合', '[[]]', '[ordinary [[标题]]](https://example.com)',
  '\\[\\[转义\\]\\]', '[[[嵌套]]]']) {
  check(active(render(source)) === 0, `must stay literal: ${source}`)
}
check(active(render('[[一]] and [[二]]')) === 2, 'two links')
check(render('[[ A &+# ]]').includes('[[ A &amp;+# ]]'), 'preserve full original label')
check(!render('[[javascript:alert(1)]]').includes('href="javascript:'), 'internal title is never URL')
check(render('[safe](https://example.com)').includes('href="https://example.com"'), 'ordinary links retained')
check(!render('[unsafe](javascript:alert%281%29)').includes('href="javascript:'), 'unsafe URL retained protection')
check(render('<script>alert(1)</script>').includes('&lt;script&gt;'), 'HTML still escaped')
check(active(render('<span>[[HTML]]</span> [[正常]]')) === 1, 'skip inline HTML but resume outside')
check(active(render('\\[\\[同名\\]\\] [[同名]]')) === 1, 'escaped and active identical titles stay distinct')
check(active(render('ordinary \\* text [[正常]]')) === 1, 'other escapes do not disable a valid link')
// S2-F01 回归保护：内部链接必须是按钮而不是 <a>，普通非空链接仍是锚点。
const buttonHtml = render('[[标题]]')
check(buttonHtml.includes('<button') && buttonHtml.includes('class="internal-link"'), 'internal link keeps its button form')
check(!buttonHtml.includes('<a'), 'internal link never degrades into an anchor')
const anchorHtml = render('[safe](https://example.com)')
check((anchorHtml.match(/<a /g) ?? []).length === 1 && anchorHtml.includes('href="https://example.com"'), 'ordinary non-empty links stay anchors')

/* ------------------------------------------------------------------
 * Stage 4 / S04-T11 D2：JSON 正文（schema 1）里的内部链接识别。
 * legacy 走上面的 Markdown 渲染；新 JSON 正文只有普通文字，靠这一层识别。
 * ------------------------------------------------------------------ */

const text = '前文 [[目标]] 后文'
const tokens = internalLinkTokens(text)
check(tokens.length === 1 && tokens[0].title === '目标', 'JSON 文本里识别 [[标题]]')
check(tokens[0].start === 3 && tokens[0].end === 3 + '[[目标]]'.length, 'token 给出半开区间')
check(findInternalLinkAt(text, 0) === null, '链接外的位置不激活')
check(findInternalLinkAt(text, 4)?.title === '目标', '点到标题文字激活')
check(findInternalLinkAt(text, tokens[0].end)?.title === '目标', '点到收尾括号右侧一格仍激活')
check(findInternalLinkAt(text, tokens[0].start)?.title === '目标', '点到起始括号激活')
check(internalLinkTokens('[[一]] 与 [[二]]').length === 2, '同一段多链接')
check(internalLinkTokens('[[ A &+# ]]')[0]?.title === ' A &+# ', '标题原文保留空格与特殊字符')
check(internalLinkTokens('[[]]').length === 0, '空标题不算链接')
check(internalLinkTokens('[[[嵌套]]]').length === 0, '三层括号不算链接')
check(internalLinkTokens('[[未闭合').length === 0, '未闭合不算链接')
check(internalLinkTokens('没有链接的正文').length === 0, '普通文本零候选')
check(internalLinkTokens('a [[b\nc]] d').length === 0, '不跨行')
check(internalLinkTokens('`[[代码]]`')[0]?.title === '代码', '行内代码由调用方按 code mark 排除，识别层不做语法猜测')
console.log(`internalLinks: ${passed} passed`)

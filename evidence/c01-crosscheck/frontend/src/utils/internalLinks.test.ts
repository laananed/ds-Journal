import { renderToStaticMarkup } from 'react-dom/server'
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
console.log(`internalLinks: ${passed} passed`)

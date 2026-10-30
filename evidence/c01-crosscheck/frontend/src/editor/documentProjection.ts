/** Deterministic projection of server-validated schema 1 documents. */
type Node = { type: string; text?: string; attrs?: Record<string, unknown>; content?: Node[]; marks?: {type: string; attrs?: Record<string, unknown>}[] }
const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const str = (value: unknown) => typeof value === 'string' ? value : ''

export function utf16ToCodePoint(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) throw new RangeError('invalid offset')
  if (offset > 0 && offset < text.length) {
    const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset)
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw new RangeError('offset splits a surrogate pair')
  }
  return Array.from(text.slice(0, offset)).length
}

function user(node: Node): string | null {
  const type = node.type
  if (type === 'text') return node.text ?? ''
  if (type === 'hardBreak') return '\n'
  if (type === 'legacyText') return node.attrs?.author === 'user' ? str(node.attrs?.raw_text) : null
  if (['aiReply', 'aiSummary', 'aiPlaceholder', 'ritualQuestion', 'horizontalRule'].includes(type)) return null
  if (type === 'goalItem') return str(node.attrs?.text)
  const parts = (node.content ?? []).map(user).filter((part): part is string => part !== null)
  return parts.join(['paragraph', 'heading', 'codeBlock'].includes(type) ? '' : '\n')
}

function markdown(node: Node): string {
  const type = node.type
  const attrs = node.attrs ?? {}
  if (type === 'text') {
    let value = html(node.text ?? '').replace(/([\\`*_~])/g, '\\$1')
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') value = `**${value}**`
      else if (mark.type === 'italic') value = `*${value}*`
      else if (mark.type === 'strike') value = `~~${value}~~`
      else if (mark.type === 'code') value = '`' + value + '`'
      else if (mark.type === 'link') value = `[${value.replaceAll(']', '\\]')}](${str(mark.attrs?.href).replaceAll(')', '%29')})`
    }
    return value
  }
  if (type === 'hardBreak') return '\n'
  if (type === 'legacyText') return str(attrs.raw_text)
  if (type === 'horizontalRule') return '---'
  if (type === 'goalItem') return (attrs.checked ? '- [x] ' : '- [ ] ') + html(str(attrs.text))
  if (type === 'ritualQuestion') return html(str(attrs.question_snapshot))
  if (type === 'aiPlaceholder') return ''
  const children = node.content ?? []
  if (type === 'paragraph' || type === 'heading') {
    return (type === 'heading' ? '#'.repeat(Number(attrs.level)) + ' ' : '') + children.map(markdown).join('')
  }
  if (type === 'codeBlock') {
    const raw = children.map(child => child.text ?? '').join('')
    const longest = Math.max(0, ...Array.from(raw.matchAll(/`+/g), match => match[0].length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const language = str(attrs.language)
    return fence + (/^[A-Za-z0-9_+.-]*$/.test(language) ? language : '') + '\n' + raw + '\n' + fence
  }
  if (['bulletList', 'orderedList', 'taskList'].includes(type)) {
    const start = typeof attrs.start === 'number' ? attrs.start : 1
    return children.map((item, index) => {
      const prefix = type === 'taskList' ? (item.attrs?.checked ? '- [x] ' : '- [ ] ') : type === 'orderedList' ? `${start + index}. ` : '- '
      return prefix + markdown(item).replaceAll('\n', '\n  ')
    }).join('\n')
  }
  const value = children.map(markdown).join('\n')
  return type === 'blockquote' ? value.split('\n').map(line => '> ' + line).join('\n') : value
}

export function userTextDocument(document: unknown): string {
  return user(document as Node) ?? ''
}

export function projectDocument(document: unknown): string {
  return ((document as Node).content ?? []).map(node => {
    let value = markdown(node)
    if (node.type === 'aiReply') value = '\n> AI 回复\n' + value.split('\n').map(line => '> ' + line).join('\n') + '\n\n'
    else if (node.type === 'aiSummary') value = '\n---\n\nAI 复盘\n\n' + value
    else if (node.type === 'legacyText' && node.attrs?.author === 'ai') value = '\n> AI 旧内容\n' + value.split('\n').map(line => '> ' + line).join('\n')
    return value
  }).join('\n')
}

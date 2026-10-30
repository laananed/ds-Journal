/**
 * `mindComment`：Minds Comments 在用户段落上的引用标记（API §2 节点表）。
 *
 * Mark 只保存 `comment_ids`，**不存评论正文**；评论是否属于该文件由服务端
 * 查库确认，UUID 形状本身不构成归属证据。T03 只做呈现与「不能被客户端
 * 伪造」的边界：普通编辑不会新增这个 Mark，粘贴进来的同类 HTML 会被
 * 守卫剥离（`../schema.ts`），真正的生成在 T08。
 */

import { Mark, mergeAttributes } from '@tiptap/core'

export const MindComment = Mark.create({
  name: 'mindComment',
  inclusive: false,
  excludes: '',
  spanning: false,

  addAttributes() {
    return {
      comment_ids: {
        default: [],
        parseHTML: (element) => (element.getAttribute('data-comment-ids') ?? '').split(',').filter((value) => value.length > 0),
        renderHTML: (attributes) => {
          const ids = Array.isArray(attributes.comment_ids) ? attributes.comment_ids : []
          return { 'data-comment-ids': ids.join(',') }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-ids]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const ids = Array.isArray(HTMLAttributes.comment_ids) ? HTMLAttributes.comment_ids : []
    return ['span', mergeAttributes(HTMLAttributes, {
      class: 's4-mind-comment',
      title: `${ids.length} 条 AI 评论`,
    }), 0]
  },
})

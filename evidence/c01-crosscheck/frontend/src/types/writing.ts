/**
 * 结构化写作的块类型（Stage 3 / S3-T04）。
 *
 * 与后端 `backend/app/writing/schemas.py` 的 `UserBlock` / `AIBlock` 一一对应，
 * 字段名与判别值必须保持一致：
 *
 * - `user`：用户正文段，只有 `id` + `text`；
 * - `ai_reply` / `ai_summary`：AI 段，额外必须带 `request_id` 来源身份。
 *
 * 与 `types/file.ts` 里 T02 引入的只读占位 `Block`（`request_id?` 可选）相比，
 * 这里给出**更严格的判别联合**：AI 段一定带 `request_id`，便于纯逻辑与
 * 组件在类型层面就区分「可编辑的用户段」与「身份不可改的 AI 段」。
 *
 * 说明：`types/file.ts` 不在本轮允许修改的文件清单内，因此保留其占位类型不动；
 * Journal / Inbox 的 `content_blocks` 改为引用本文件的 `Block`。
 */

/** 用户正文段。 */
export interface UserBlock {
  id: string
  kind: 'user'
  text: string
}

/** AI 段（局部回复或完整总结）；`request_id` 是不可篡改的来源身份。 */
export interface AiBlock {
  id: string
  kind: 'ai_reply' | 'ai_summary'
  text: string
  request_id: string
}

/** 结构化正文的有序块。数组顺序即正文顺序。 */
export type Block = UserBlock | AiBlock

/** 块的判别值。 */
export type BlockKind = Block['kind']

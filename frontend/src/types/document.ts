/** Stage 4 schema draft. The server remains authoritative for validation and ownership. */
export type JournalKind = 'writing' | 'set' | 'end'
export interface CommentAnchor { node_id: string; start: number; end: number; quote: string; quote_sha256: string }
export type Mark =
  | { type: 'bold' | 'italic' | 'strike' | 'code' }
  | { type: 'link'; attrs: { href: string } }
  | { type: 'mindComment'; attrs: { comment_ids: string[] } }
export type TextNode = { type: 'text'; text: string; marks?: Mark[] }
export type InlineNode = TextNode | { type: 'hardBreak' }
export type Paragraph = { type: 'paragraph'; attrs?: { id?: string }; content?: InlineNode[] }
export type BasicBlock = Paragraph
  | { type: 'heading'; attrs: { id?: string; level: 1 | 2 | 3 }; content?: InlineNode[] }
  | { type: 'horizontalRule'; attrs?: { id?: string } }
  | { type: 'codeBlock'; attrs?: { id?: string; language?: string | null }; content?: TextNode[] }
  | { type: 'blockquote'; attrs?: { id?: string }; content?: BasicBlock[] }
  | { type: 'bulletList'; attrs?: { id?: string }; content?: ListItem[] }
  | { type: 'orderedList'; attrs?: { id?: string; start?: number }; content?: ListItem[] }
  | { type: 'taskList'; attrs?: { id?: string }; content?: TaskItem[] }
export type ListItem = { type: 'listItem'; attrs?: { id?: string }; content?: BasicBlock[] }
export type TaskItem = { type: 'taskItem'; attrs: { id?: string; checked: boolean }; content?: BasicBlock[] }
export type SpecialBlock =
  | { type: 'aiReply' | 'aiSummary'; attrs: { id: string; request_id: string }; content: Paragraph[] }
  | { type: 'aiPlaceholder'; attrs: { id: string; request_id: string } }
  | { type: 'ritualQuestion'; attrs: { id: string; template_question_id: string | null; question_snapshot: string } }
  | { type: 'goalItem'; attrs: { id: string; goal_id: string; text: string; checked: boolean } }
  | { type: 'goalReview'; attrs: { id: string; link_id: string | null; goal_snapshot: string; checked_snapshot: boolean; review_title: string }; content?: Paragraph[] }
  | { type: 'legacyText'; attrs: { id: string; raw_text: string; author: 'user' | 'ai' } }
  | { type: 'legacyBlocks'; attrs: { id: string; format_version: 1; blocks: ({ id: string; kind: 'user'; text: string } | { id: string; kind: 'ai_reply' | 'ai_summary'; text: string; request_id: string })[] } }
export type ContentDocument = { type: 'doc'; content: (BasicBlock | SpecialBlock)[] }

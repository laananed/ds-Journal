import type { FileIdentity, FilePage } from './file'
import type { Insight } from './insight'
import type { Journal } from './journal'

/**
 * 回收箱只收 Journal / Insight。
 * Inbox 是硬删除、不可恢复，没有 Trash / Restore / 永久删除接口（API §7）。
 */
export type TrashType = Extract<FileIdentity['type'], 'journal' | 'insight'>

/** 列表筛选：all / journal / insight；类型变化时回到第一页。 */
export type TrashFilter = TrashType | 'all'

/** 回收箱条目复用完整文件响应，跨类型身份是 type + id。 */
export type TrashItem = Journal | Insight

export type TrashPageData = FilePage<TrashItem>

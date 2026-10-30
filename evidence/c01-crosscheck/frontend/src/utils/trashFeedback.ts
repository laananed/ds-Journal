/**
 * Trash 操作反馈文案的纯逻辑（Stage 2 / S2-T10）。
 *
 * 关键规则来自 `docs/stage2.md` §11 与 `docs/stage2-tasks.md` S2-T10：
 *
 * - **写成功与刷新失败分开反馈**：操作成功的提示只描述已发生的动作；
 *   随后的列表刷新失败由列表区自己的错误块（含重试）表达，两者不混写，
 *   也不能因为刷新失败就重复执行已经成功的恢复/删除。
 * - **404 = 记录状态已变化**：目标可能已被其他操作恢复或永久删除，
 *   此时不谎报本次操作成功，清除过期详情并重新读取列表。
 *
 * 本文件不依赖 React、不发请求，可用 `node --experimental-strip-types` 直接测试。
 */

/** 回收箱内的单条动作；Inbox 没有 Trash 动作，类型上就不可能出现。 */
export type TrashAction = 'restore' | 'purge'

/** 动作成功后的主提示。恢复保留原 Folder 关系，提示里说清去哪里查看。 */
export function trashActionDoneMessage(action: TrashAction, displayTitle: string): string {
  return action === 'restore'
    ? `已恢复「${displayTitle}」，原 Folder 关系已保留，可到 Journal / Insight 查看。`
    : `已永久删除「${displayTitle}」。`
}

/**
 * 目标消失（动作返回 404）时的统一提示。
 * 只陈述状态变化并说明会重读列表，不声称本次动作成功。
 */
export const TRASH_TARGET_GONE_MESSAGE =
  '该记录状态已变化（可能已被其他操作恢复或永久删除），正在重新读取回收箱列表。'

/** 永久删除确认框文案；取消或关闭确认框时不发任何请求。 */
export const TRASH_PURGE_CONFIRM_MESSAGE =
  '永久删除后记录无法恢复，也不会再出现在回收箱中。确定要永久删除吗？'

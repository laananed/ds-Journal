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

/**
 * Trash 写入失败的最小形状。
 *
 * 与 `api/trash.ts` 的 `TrashApiError` **结构性兼容**（status / code / message），
 * 但只依赖这三个只读字段，因此本文件仍可在 `node --experimental-strip-types`
 * 下直接测试，不需要构造真实 Error 或发请求。
 */
export interface TrashFailure {
  status?: number
  /** Stage 4 起的机器可读错误码；Stage 3 响应没有该字段。 */
  code?: string
  message?: string
}

export interface TrashFailureFeedback {
  /** 面向用户的完整说明；不得包含「已成功」字样。 */
  message: string
  /** 是否应重读详情，拿到最新 revision 后再让用户确认一次。 */
  reread: boolean
  /** 是否属于「稍后重试有意义」的暂时性失败。 */
  retriable: boolean
}

/** 版本已变化（Stage 3 既有文案，保持逐字一致以免退化已验收行为）。 */
export const TRASH_STALE_REVISION_MESSAGE =
  '这条记录已在别处发生变化，已重新读取，请再确认一次。'

/**
 * Stage 4 / T11：Ritual 同名额冲突。
 *
 * `docs/stage4-api.md` §5 规定：普通恢复若遇到同日同类有效占位，返回
 * 409 `ritual_slot_conflict` 且**不修改任何对象**；用户必须改走
 * `POST /api/rituals/{source_id}/restore-replace`（显式替换）才能继续。
 * 替换恢复由 T04 后端事务 + T07 关联生命周期提供，当前**尚未接线**，
 * 所以这里只如实说明「被拒绝且没有改动」，不提供会半写的替代动作。
 */
export const TRASH_RITUAL_SLOT_CONFLICT_MESSAGE =
  '该日期同类型的有效 Ritual 已存在：直接恢复会出现两条同日同类型占位，本次恢复已被拒绝，回收箱记录和现有文件都没有改动。逐条替换恢复（restore-replace）尚未接线，接口契约交付后再补齐入口。'

/** 关联文件版本变化：不允许只恢复一半。 */
export const TRASH_RELATED_FILES_CHANGED_MESSAGE =
  '这条记录关联的正文或回答已在别处变化，恢复需要同时核对它们，已阻止以免只恢复一部分。请重新读取最新状态后再确认。'

/** 旧格式正文：回收箱是只读的，转换必须在编辑页显式完成。 */
export const TRASH_LEGACY_LOCKED_MESSAGE =
  '这条记录的正文仍是旧格式，未经等价转换不能在回收箱内改写。恢复后请到编辑页使用「转换为富文本」再修改。'

/** 缺版本条件（428）：正常流程不会走到，出现了也不谎报成功。 */
export const TRASH_PRECONDITION_REQUIRED_MESSAGE =
  '请求缺少版本条件（HTTP 428），本次没有修改任何记录。请重新读取后再试。'

/**
 * 把写入失败翻译成「用户能据此决定下一步」的反馈。
 *
 * 判断顺序：**先看 `code`，再看 `status`**。因为 409 在 Stage 4 至少有
 * 三种含义完全不同的原因（版本过期 / Ritual 名额冲突 / 关联文件变化），
 * 只按 409 一律「重读再试」会把不可重试的冲突说成可重试。
 */
export function trashWriteFailureMessage(
  action: TrashAction,
  failure: TrashFailure,
): TrashFailureFeedback {
  const fallback = action === 'restore' ? '恢复失败，请稍后重试' : '永久删除失败，请稍后重试'
  switch (failure.code) {
    case 'ritual_slot_conflict':
      return { message: TRASH_RITUAL_SLOT_CONFLICT_MESSAGE, reread: false, retriable: false }
    case 'related_files_changed':
      return { message: TRASH_RELATED_FILES_CHANGED_MESSAGE, reread: true, retriable: false }
    case 'legacy_conversion_required':
      return { message: TRASH_LEGACY_LOCKED_MESSAGE, reread: true, retriable: false }
    default:
      break
  }
  if (failure.status === 409) {
    return { message: TRASH_STALE_REVISION_MESSAGE, reread: true, retriable: true }
  }
  if (failure.status === 428) {
    return { message: TRASH_PRECONDITION_REQUIRED_MESSAGE, reread: true, retriable: true }
  }
  return { message: failure.message ?? fallback, reread: false, retriable: true }
}

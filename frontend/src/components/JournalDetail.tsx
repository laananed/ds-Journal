/**
 * Journal 详情、修改与删除面板（Stage 1 / Task 8.3）。
 *
 * 全部状态都是组件本地的 `useState` / `useEffect`，不引入路由、状态管理或请求框架。
 * 打开、编辑、删除三件事都在同一个面板里切换，因此不需要任何视图路由。
 *
 * 关注点分四块：
 *
 * 1. **详情读取**：按 `journalId` 真实调用 `GET /api/journals/{id}`，
 *    不用列表里的缓存当详情；用 `AbortController` 取消过期请求，
 *    父组件再用 `key={id}` 让「切换记录」等价于重新挂载，
 *    因此迟到的旧响应不可能覆盖新记录。
 * 2. **修改**：用真实详情初始化表单；`buildJournalUpdate()` 只把
 *    **真正改过的字段**放进 PATCH；空标题按创建表单的同一约定发送 `null`；
 *    没有改动时发送 `{}`，沿用后端已确认的空更新语义（不改变 `updated_at`）。
 *    Stage 1.5 / S1.5-T2 起，提交前**只校验这次 PATCH 里实际提交的字段**
 *    （`validateUpdateInput()`）：旧记录正文超长 / 空白但本次没改正文时，
 *    仍能正常修改标题或日期；真的提交非法值（例如清空正文）才会被拦下。
 * 3. **删除**：先给出明确的不可恢复确认，取消不发任何请求；
 *    成功是 `204`（不解析响应体），随后关闭详情并刷新列表；
 *    `404` 只说明「记录本来就不存在」，不冒充「本次删除成功」。
 * 4. **同步与错误**：写操作成功后只通知父组件去刷新，刷新失败由列表区域提示，
 *    不会被误报成写入失败，也不会诱导用户重复提交。
 *
 * 编号（同日无标题记录的「(2)」）属于列表上下文，
 * 因此这里只用 `displayJournalTitle()` 这一个展示规则：
 * 标题为 `null` **或空字符串**时显示 `journal_date`，否则原样显示明确的手工标题，
 * 不额外造一套详情编号，也不 trim 非空标题。
 */

import { useEffect, useState, type FormEvent } from 'react'
import {
  JournalApiError,
  deleteJournal,
  getJournal,
  updateJournal,
} from '../api/journals'
import {
  buildJournalUpdate,
  displayJournalTitle,
  formatServerTimestamp,
  isJournalUpdateEmpty,
} from '../utils/journalDetail'
import {
  formatContentValidationErrors,
  hasContentValidationErrors,
  validateUpdateInput,
} from '../utils/contentValidation'
import type { Journal } from '../types/journal'

interface JournalDetailProps {
  /** 当前打开的 Journal 主键。 */
  journalId: number
  /**
   * 是否有写操作（保存 / 删除）正在进行中。
   * 父组件据此禁用「打开其它记录」这类会混淆目标的操作。
   */
  onBusyChange: (busy: boolean) => void
  /** 返回列表：只关闭面板，不请求任何接口。 */
  onClose: () => void
  /**
   * 写操作成功后通知父组件重新读取列表与创建表单的当天记录。
   * 父组件按当前筛选语义刷新，不偷偷改筛选。
   */
  onDataChanged: () => void
  /** 删除成功后关闭详情（父组件同时清空选中的 id）。 */
  onDeleted: () => void
}

type DetailStatus = 'loading' | 'success' | 'error'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'invalid' | 'error'
type DeleteStage = 'idle' | 'confirming' | 'deleting'

function JournalDetail({
  journalId,
  onBusyChange,
  onClose,
  onDataChanged,
  onDeleted,
}: JournalDetailProps) {
  // ---- 详情读取 ----
  const [status, setStatus] = useState<DetailStatus>('loading')
  const [detail, setDetail] = useState<Journal | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  // ---- 编辑表单 ----
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [formTitle, setFormTitle] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formDate, setFormDate] = useState('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState('')
  const [discardConfirming, setDiscardConfirming] = useState(false)

  // ---- 删除 ----
  const [deleteStage, setDeleteStage] = useState<DeleteStage>('idle')
  const [deleteError, setDeleteError] = useState('')

  useEffect(() => {
    const controller = new AbortController()

    getJournal(journalId, controller.signal)
      .then((data) => {
        setDetail(data)
        setNotFound(false)
        setLoadError('')
        setStatus('success')
      })
      .catch((error: unknown) => {
        // 主动取消（切换记录 / 卸载 / 重新读取）不算失败。
        if (controller.signal.aborted) {
          return
        }
        // 读取失败或记录不存在时都清掉内容，避免展示过期详情。
        setDetail(null)
        setNotFound(error instanceof JournalApiError && error.status === 404)
        setLoadError(
          error instanceof Error ? error.message : '读取失败，请稍后重试',
        )
        setStatus('error')
      })

    return () => {
      controller.abort()
    }
  }, [journalId, reloadToken])

  const isSaving = saveStatus === 'saving'
  const isDeleting = deleteStage === 'deleting'
  const busy = isSaving || isDeleting

  // 只在编辑模式下计算请求体，避免用未初始化的表单值干扰展示状态。
  const pendingUpdate =
    mode === 'edit' && detail !== null
      ? buildJournalUpdate(detail, {
          title: formTitle,
          content: formContent,
          journal_date: formDate,
        })
      : {}
  const isDirty = mode === 'edit' && !isJournalUpdateEmpty(pendingUpdate)

  function handleReload() {
    setStatus('loading')
    setDetail(null)
    setNotFound(false)
    setLoadError('')
    setReloadToken((token) => token + 1)
  }

  /** 进入编辑：用**真实详情**初始化三个字段，并清掉上一次的保存 / 删除状态。 */
  function startEditing() {
    if (detail === null) {
      return
    }
    setFormTitle(detail.title ?? '')
    setFormContent(detail.content)
    setFormDate(detail.journal_date)
    setSaveStatus('idle')
    setSaveError('')
    setDiscardConfirming(false)
    setDeleteStage('idle')
    setDeleteError('')
    setMode('edit')
  }

  /** 退出编辑：丢弃表单内容，**不发任何请求**。 */
  function exitEditing() {
    setMode('view')
    setDiscardConfirming(false)
    setSaveStatus('idle')
    setSaveError('')
  }

  function handleCancelEdit() {
    // 有未保存改动时先明确提示，避免静默丢掉用户刚写的内容。
    if (isDirty) {
      setDiscardConfirming(true)
      return
    }
    exitEditing()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (detail === null || isSaving) {
      return
    }
    if (formDate === '') {
      // 日期必须提供合法值；这里不套用新建时的 04:00 默认日期规则。
      setSaveStatus('error')
      setSaveError('日期不能为空。')
      return
    }

    // Stage 1.5 / S1.5-T2：先构造实际 PATCH（`pendingUpdate` 只含真正改过的字段），
    // 再**只校验其中实际提交的字段**。
    // 因此旧记录正文超长 / 空白、但本次只改标题或日期时，依然可以保存；
    // 而用户真的把非法值提交进来（例如把正文清空）仍会被拒绝。
    const validationErrors = validateUpdateInput(pendingUpdate)
    if (hasContentValidationErrors(validationErrors)) {
      setSaveStatus('invalid')
      setSaveError(formatContentValidationErrors(validationErrors))
      return
    }

    setSaveStatus('saving')
    setSaveError('')
    onBusyChange(true)

    try {
      const updated = await updateJournal(detail.id, pendingUpdate)
      // 用后端返回值作为当前真实详情：updated_at 由后端生成，前端不自己算。
      setDetail(updated)
      setMode('view')
      setDiscardConfirming(false)
      setSaveStatus('saved')
      // PATCH 已经成功。这里只通知父组件重新读取列表与当天记录，
      // 不 await、也不抛异常：刷新失败由列表区域提示，不会被当成保存失败。
      onDataChanged()
    } catch (error: unknown) {
      // 失败保留输入与编辑模式，用户可修改后再次提交（不自动重试）。
      setSaveStatus('error')
      setSaveError(
        error instanceof Error ? error.message : '保存失败，请稍后重试',
      )
    } finally {
      onBusyChange(false)
    }
  }

  async function handleConfirmDelete() {
    if (detail === null || isDeleting) {
      return
    }

    const targetId = detail.id
    setDeleteStage('deleting')
    setDeleteError('')
    onBusyChange(true)

    try {
      await deleteJournal(targetId)
      onBusyChange(false)
      // 204 成功：清掉本地详情与编辑状态，让父组件关闭详情并刷新列表。
      setDetail(null)
      setMode('view')
      setDeleteStage('idle')
      onDeleted()
    } catch (error: unknown) {
      setDeleteStage('idle')
      if (error instanceof JournalApiError && error.status === 404) {
        // 记录本来就不存在：不能冒充「本次删除成功」。
        // 清掉过期内容、明确说明情况，并让父组件刷新读取视图。
        setDetail(null)
        setNotFound(true)
        setLoadError('')
        setStatus('error')
        onDataChanged()
      } else {
        // 删除失败时**不从 UI 假装移除记录**：详情保持原样，只提示失败。
        setDeleteError(
          error instanceof Error ? error.message : '删除失败，请稍后重试',
        )
      }
      onBusyChange(false)
    }
  }

  return (
    <section className="journal-detail" aria-label="Journal 详情">
      <div className="detail-header">
        <h2>Journal 详情</h2>
        <button type="button" onClick={onClose} disabled={busy}>
          返回列表
        </button>
      </div>

      {status === 'loading' && (
        <p className="detail-state" role="status">
          正在读取详情……
        </p>
      )}

      {status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>
            {notFound
              ? `该 Journal 不存在（id ${journalId}），可能已被删除。`
              : `读取详情失败：${loadError}`}
          </p>
          <button type="button" onClick={handleReload} disabled={busy}>
            重新读取
          </button>
        </div>
      )}

      {status === 'success' && detail !== null && mode === 'view' && (
        <>
          <h3 className="detail-title">
            {displayJournalTitle(detail.title, detail.journal_date)}
          </h3>

          <dl className="detail-meta">
            <div className="detail-meta-row">
              <dt>id</dt>
              <dd>{detail.id}</dd>
            </div>
            <div className="detail-meta-row">
              <dt>journal_date</dt>
              <dd>{detail.journal_date}</dd>
            </div>
            <div className="detail-meta-row">
              <dt>created_at</dt>
              <dd>{formatServerTimestamp(detail.created_at)}</dd>
            </div>
            <div className="detail-meta-row">
              <dt>updated_at</dt>
              <dd>{formatServerTimestamp(detail.updated_at)}</dd>
            </div>
          </dl>

          <p className="detail-content">{detail.content}</p>

          {saveStatus === 'saved' && (
            <p className="detail-success" role="status">
              已保存，updated_at 由后端更新为
              {formatServerTimestamp(detail.updated_at)}。
            </p>
          )}

          <div className="detail-actions">
            <button type="button" onClick={startEditing} disabled={busy}>
              修改
            </button>
            {deleteStage === 'idle' && (
              <button
                type="button"
                className="detail-danger"
                onClick={() => setDeleteStage('confirming')}
                disabled={busy}
              >
                删除
              </button>
            )}
          </div>

          {deleteStage === 'confirming' && (
            <div className="detail-confirm">
              <p>
                删除后无法恢复：这篇 Journal 会从数据库中永久移除，确定要删除吗？
              </p>
              <div className="detail-confirm-actions">
                <button
                  type="button"
                  className="detail-danger"
                  onClick={handleConfirmDelete}
                  disabled={busy}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteStage('idle')}
                  disabled={busy}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {isDeleting && (
            <p className="detail-state" role="status">
              正在删除……
            </p>
          )}

          {deleteError !== '' && (
            <p className="detail-error" role="alert">
              删除失败：{deleteError}（记录未被删除，可稍后重试。）
            </p>
          )}
        </>
      )}

      {status === 'success' && detail !== null && mode === 'edit' && (
        <form className="detail-form" onSubmit={handleSubmit}>
          <label className="editor-field">
            <span>日期</span>
            <input
              type="date"
              value={formDate}
              onChange={(event) => setFormDate(event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="editor-field">
            <span>标题（留空表示没有标题）</span>
            <input
              type="text"
              value={formTitle}
              onChange={(event) => setFormTitle(event.target.value)}
              disabled={busy}
            />
          </label>

          <label className="editor-field">
            <span>正文</span>
            <textarea
              value={formContent}
              rows={8}
              onChange={(event) => setFormContent(event.target.value)}
              disabled={busy}
            />
          </label>

          <div className="editor-actions">
            <button type="submit" disabled={busy}>
              {isSaving ? '保存中……' : '保存修改'}
            </button>
            <button type="button" onClick={handleCancelEdit} disabled={busy}>
              取消
            </button>
            {isSaving && (
              <span className="editor-state" role="status">
                正在保存……
              </span>
            )}
          </div>

          <p className="detail-hint">
            {isDirty
              ? '保存时只提交改过的字段。'
              : '没有任何改动，保存会按空更新处理（记录不变，updated_at 不变）。'}
          </p>

          {discardConfirming && (
            <div className="detail-confirm">
              <p>当前有未保存的修改，取消后这些修改会丢失。</p>
              <div className="detail-confirm-actions">
                <button type="button" onClick={exitEditing} disabled={busy}>
                  放弃修改
                </button>
                <button
                  type="button"
                  onClick={() => setDiscardConfirming(false)}
                  disabled={busy}
                >
                  继续编辑
                </button>
              </div>
            </div>
          )}

          {saveStatus === 'error' && (
            <p className="detail-error" role="alert">
              保存失败：{saveError}（输入已保留，可修改后再次保存。）
            </p>
          )}

          {saveStatus === 'invalid' && (
            <p className="detail-error" role="alert">
              输入不合法：{saveError}（未发送保存请求，输入已保留，可修改后再次保存。）
            </p>
          )}
        </form>
      )}
    </section>
  )
}

export default JournalDetail

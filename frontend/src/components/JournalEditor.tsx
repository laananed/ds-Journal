/**
 * 创建 Journal 的表单（Stage 1 / Task 8.2）。
 *
 * 全部状态都是组件本地的 `useState` / `useEffect`，不引入路由、状态管理或请求框架。
 *
 * 关注点分三块：
 *
 * 1. **表单本身**：标题（可选）、正文、日期（默认本机 04:00 换日的业务日期，
 *    之后完全由用户决定，不会再被任何 effect 或列表筛选覆盖）；
 *    保存成功 / 失败、保存中禁止重复提交；失败时保留用户输入。
 *    Stage 1.5 / S1.5-T2 起，提交前会先校验全部待创建字段（标题 ≤80 码点、
 *    正文非空白且 ≤50,000 码点），不合法就**不发 POST** 并给出明确错误；
 *    校验用的是 Unicode 码点计数，因此合法的 emoji 标题不会被误拒。
 * 2. **所选日期已有记录**：日期变化时用现有 `listJournals(date)` 真实查询，
 *    并用 `AbortController` 取消过期请求，避免旧日期的迟到响应覆盖新日期结果。
 * 3. **保存后的同步**：POST 成功后清空输入（保留日期，方便同日继续写），
 *    再通过 `onSaved()` 让父组件刷新列表，并自行重读「当天已有记录」。
 *
 * Task 8.3 增加两点，都不改变上面的行为：
 *
 * - 「当天已有记录」列表里的每条记录都能**打开详情**（`onOpen`），
 *   与主列表使用同一套入口；
 * - 接受一个外部变更标记 `externalRevision`：详情面板修改或删除成功后父组件会
 *   让它自增，这里只是**重新读取当天已有记录**；
 *   表单里正在填写的标题、正文、日期完全不受影响，
 *   也没有引入任何全局事件总线或共享状态。
 *
 * 与「列表刷新」的关系：`onSaved()` 只负责通知父组件去重新加载列表，
 * 它不会抛异常，因此**列表刷新失败不会被误报成保存失败**——
 * 刷新失败由列表区域自己提示，这里的保存状态保持「已保存」。
 */

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { createJournal, listJournals } from '../api/journals'
import JournalList from './JournalList'
import type { Journal } from '../types/journal'
import {
  formatContentValidationErrors,
  hasContentValidationErrors,
  validateCreateInput,
} from '../utils/contentValidation'
import { defaultJournalDate } from '../utils/journalDate'

interface JournalEditorProps {
  /**
   * 当前列表的筛选日期；`''` 表示列表显示全部。
   * 用来在「保存成功但新记录不在当前筛选范围」时给出明确提示。
   */
  listFilterDate: string
  /**
   * 保存成功后的回调（父组件据此刷新列表）。
   * 实现上只做状态更新，不抛异常，也不等待列表请求。
   */
  onSaved: () => void
  /**
   * 外部变更版本号：详情面板修改 / 删除成功后父组件自增它，
   * 这里据此重新读取「当天已有记录」。
   * 它**只影响这一块读取**，不会重置正在填写的创建表单。
   */
  externalRevision: number
  /** 打开「当天已有记录」里某一条的详情。 */
  onOpen: (id: number) => void
  /** 父组件有写操作进行中时传 `true`，避免写入期间切换目标。 */
  openDisabled: boolean
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'invalid' | 'error'
type DayStatus = 'loading' | 'success' | 'error'

function JournalEditor({
  listFilterDate,
  onSaved,
  externalRevision,
  onOpen,
  openDisabled,
}: JournalEditorProps) {
  // ---- 表单字段 ----
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  // 初始值在组件挂载时计算一次（不在 effect 里改），此后只由用户改变。
  const [journalDate, setJournalDate] = useState(() => defaultJournalDate())

  // ---- 保存状态 ----
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [saveError, setSaveError] = useState('')
  const [lastSaved, setLastSaved] = useState<Journal | null>(null)

  // ---- 所选日期的已有记录 ----
  const [dayJournals, setDayJournals] = useState<Journal[]>([])
  const [dayStatus, setDayStatus] = useState<DayStatus>('loading')
  const [dayError, setDayError] = useState('')
  const [dayReloadToken, setDayReloadToken] = useState(0)

  useEffect(() => {
    // 日期被清空时不查询；界面上会提示需要先选日期。
    if (journalDate === '') {
      return
    }

    const controller = new AbortController()

    listJournals(journalDate, controller.signal)
      .then((data) => {
        setDayJournals(data)
        setDayStatus('success')
      })
      .catch((error: unknown) => {
        // 主动取消（快速切换日期 / 卸载）不算失败。
        if (controller.signal.aborted) {
          return
        }
        // 失败不能显示成「该日期没有记录」。
        setDayJournals([])
        setDayError(error instanceof Error ? error.message : '读取失败，请稍后重试')
        setDayStatus('error')
      })

    return () => {
      controller.abort()
    }
    // externalRevision 变化（详情里改过 / 删过）时重读当天记录；
    // 它只是 effect 的触发条件，不会写入任何表单字段。
  }, [journalDate, dayReloadToken, externalRevision])

  /** 切换日期：先进入「加载中」并清掉旧日期的列表，再更新日期。 */
  function handleJournalDateChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value
    if (value === journalDate) {
      return
    }
    setDayStatus('loading')
    setDayError('')
    setDayJournals([])
    setJournalDate(value)
  }

  function handleDayRetry() {
    setDayStatus('loading')
    setDayError('')
    setDayJournals([])
    setDayReloadToken((token) => token + 1)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    // 保存过程中阻止重复提交（按钮同时也置为 disabled）。
    if (saveStatus === 'saving') {
      return
    }

    if (journalDate === '') {
      setSaveError('请先选择日期。')
      setSaveStatus('error')
      return
    }

    const payload = {
      // 标题留空按契约发送 null；其它情况原样发送，不做 trim 或额外限制。
      title: title === '' ? null : title,
      content,
      journal_date: journalDate,
    }

    // Stage 1.5 / S1.5-T2：提交前先校验本次待创建的全部字段。
    // 不合法就**不发 POST**、保留用户输入，只给出明确错误。
    const validationErrors = validateCreateInput(payload)
    if (hasContentValidationErrors(validationErrors)) {
      setSaveStatus('invalid')
      setSaveError(formatContentValidationErrors(validationErrors))
      return
    }

    setSaveStatus('saving')
    setSaveError('')

    try {
      const created = await createJournal(payload)

      setLastSaved(created)
      setSaveStatus('saved')
      // 清空标题与正文，但保留日期，方便同一天继续写下一篇。
      setTitle('')
      setContent('')
      // 重新读取「当天已有记录」，让刚保存的这篇立刻出现在摘要里。
      setDayReloadToken((token) => token + 1)
      // 通知父组件刷新列表（不 await、不会抛出）。
      onSaved()
    } catch (error: unknown) {
      // 失败时保留用户输入，不自动重试。
      setSaveStatus('error')
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
    }
  }

  const isSaving = saveStatus === 'saving'
  const savedOutsideCurrentFilter =
    lastSaved !== null && listFilterDate !== '' && listFilterDate !== lastSaved.journal_date

  return (
    <section className="journal-editor">
      <h2>新建 Journal</h2>

      <form className="editor-form" onSubmit={handleSubmit}>
        <label className="editor-field">
          <span>日期</span>
          <input
            type="date"
            value={journalDate}
            onChange={handleJournalDateChange}
            disabled={isSaving}
          />
        </label>

        <label className="editor-field">
          <span>标题（可留空）</span>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={isSaving}
          />
        </label>

        <label className="editor-field">
          <span>正文</span>
          <textarea
            value={content}
            rows={6}
            onChange={(event) => setContent(event.target.value)}
            disabled={isSaving}
          />
        </label>

        <div className="editor-actions">
          <button type="submit" disabled={isSaving}>
            {isSaving ? '保存中……' : '保存'}
          </button>
          {isSaving && (
            <span className="editor-state" role="status">
              正在保存……
            </span>
          )}
        </div>
      </form>

      {saveStatus === 'saved' && lastSaved !== null && (
        <p className="editor-success" role="status">
          已保存：{lastSaved.journal_date}
          {savedOutsideCurrentFilter
            ? `（当前列表筛选的是 ${listFilterDate}，这篇不在当前列表中。）`
            : '。'}
        </p>
      )}

      {saveStatus === 'error' && (
        <p className="editor-error" role="alert">
          保存失败：{saveError}（输入内容已保留，可修改后再次保存。）
        </p>
      )}

      {saveStatus === 'invalid' && (
        <p className="editor-error" role="alert">
          输入不合法：{saveError}（未发送保存请求，输入内容已保留，可修改后再次保存。）
        </p>
      )}

      <div className="editor-day">
        <p className="editor-day-title">
          {journalDate === ''
            ? '先选择日期，才能查看该日期已有记录。'
            : dayStatus === 'loading'
              ? '正在读取该日期已有记录……'
              : dayStatus === 'error'
                ? `读取该日期已有记录失败：${dayError}`
                : `该日期已有 ${dayJournals.length} 篇记录。`}
        </p>

        {journalDate !== '' && dayStatus === 'error' && (
          <div>
            <button type="button" onClick={handleDayRetry}>
              重试
            </button>
          </div>
        )}

        {journalDate !== '' && dayStatus === 'success' && dayJournals.length > 0 && (
          <JournalList
            journals={dayJournals}
            onOpen={onOpen}
            openDisabled={openDisabled}
          />
        )}
      </div>
    </section>
  )
}

export default JournalEditor

/**
 * 独立日程页（Stage 4 结题 C01）—— 只做**前端组件**，不接线、不迁移、不碰 AI 后端。
 *
 * 契约依据 `docs/stage4-api.md` §13 与 `docs/stage4-tasks.md` §4「结题新增任务 C01」。
 *
 * 三条产品红线，都体现在结构里而不是注释里：
 *
 * 1. **日程与 Set 目标独立**：本文件只依赖注入的 `SchedulesClient`，
 *    import 里没有任何 ritual / link / goal 模块，也就不可能顺手同步 Set。
 * 2. **确认前零写**：自然语言建议与情绪推测只产生**候选**；候选的唯一出口是
 *    「填入表单」，真正落库仍然要用户点保存、走同一个 `create`。
 *    `GET` 零写、打开页面零创建：读取只在 effect 里做，写只由提交/点击触发。
 * 3. **模型不可用不阻断手动日程**：建议请求失败只影响建议区，表单照常可用。
 *
 * 失败姿态（交叉测试 D1 的修复要点）：
 * - 任何提交失败都**不关表单、不清草稿**；用户输入只有在用户自己点「取消」时才丢弃。
 * - 409 是「基线过期」而不是「输入无效」：保留草稿，读取服务器最新版本供比较，
 *   由用户在冲突提示里显式选择；重试必须用**实际最新 revision**，再冲突仍保留输入。
 * - 失败时清掉与本次操作无关的旧通知，避免用旧成功/取消提示误导用户。
 *
 * 分页收敛（D2）：读取返回空页且不在第一页时，回退到有效的前一页再读，
 * 不把「本页被删空」显示成「完全没有日程」。
 *
 * 刷新失败（交叉测试 D2 缺陷）：已有列表时的后台刷新失败，
 * **保留**最近一次成功读取的列表并显示横幅 + 重试入口，
 * 不把错误态盖在列表上让已有日程消失；删除被服务端确认后先本地移除该条，
 * 刷新失败也不会重复发送删除。
 *
 * 情绪没有对应接口字段（§13 未定义），所以**只展示、不提交**；
 * 不为了「看起来完整」给日程编一个情绪字段。
 *
 * 本轮不接 `App.tsx`、不改公共类型、不改 T06/T10 页面；
 * 真实后端与入口接线等 C01 后端交接后由负责人完成。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import './SchedulePage.css'
import type {
  Schedule,
  ScheduleId,
  ScheduleListPage,
  ScheduleSuggestionCandidate,
  SchedulesClient,
  ScheduleSuggestionProvider,
  ScheduleSuggestionResult,
} from '../types/schedule'
import {
  buildCreateInput,
  candidateToDraft,
  countCodePoints,
  describeRangeIssue,
  describeScheduleFailure,
  draftFromSchedule,
  draftToUpdateInput,
  emptyScheduleDraft,
  newClientCreateId,
  SCHEDULE_TITLE_MAX_CODE_POINTS,
  validateScheduleDraft,
} from '../utils/scheduleForm'
import type { ScheduleDraft, ScheduleDraftErrors, ScheduleFailure } from '../utils/scheduleForm'
import { pageAfterEmptyRead } from '../utils/schedulePaging'
import { formatShanghaiTimeRange, scheduleKey, SHANGHAI_TIME_ZONE_LABEL } from '../utils/scheduleTime'

/**
 * Mock 来源的界面声明。
 *
 * 页面**不 import Mock 实现**（只认 `client.source`），所以这里放的是界面文案：
 * 一旦接线成 HTTP 客户端，横幅自动消失，Mock 代码也不会被打进页面依赖。
 */
const MOCK_NOTICE = 'Mock 数据：日程只保存在当前页面内存，刷新即丢失；未连接后端数据库，也未调用真实模型。'

/** 建议区状态：与表单/列表状态互不影响，模型失败不阻断手动日程。 */
type SuggestionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: ScheduleSuggestionResult }

type ListState =
  | { status: 'loading' }
  | { status: 'error'; failure: ScheduleFailure }
  | { status: 'ready'; page: ScheduleListPage }

/**
 * 后台刷新失败时的横幅文案（列表已成功读过至少一次）。
 *
 * 交叉测试 D2 缺陷：删除成功后刷新列表失败，把整个 `listState` 换成 error，
 * 已有日程全部消失、只剩一条读取失败——用户会以为数据丢了。
 * 修复姿态：**保留最近一次成功读取的列表**（标记为可能过期），
 * 用独立横幅说明失败并给出重试入口；列表内容不被错误态覆盖。
 */
const REFRESH_FAILED_HINT =
  '下面显示的是最近一次成功读取的列表，可能不是最新内容；' +
  '刚才的删除或保存是否成功，以操作提示为准，这里不会重复发送删除或保存。'

/**
 * 编辑时的版本冲突（CAS 409）。
 *
 * 它不是「错误文案」而是**待用户决策的状态**：
 * 草稿仍在 `EditorState.draft` 里，`latest` 只用于展示与重试基线，
 * 两者都不是自动合并——合并由用户点按钮决定。
 */
type EditConflict = {
  /** 读取到的最新服务器版本；读取失败时为 null（草稿不受影响）。 */
  latest: Schedule | null
  /** 读取最新版本失败的原因；null 表示没有失败。 */
  readError: string | null
  /** 正在读取最新版本。 */
  checking: boolean
}

/** 同一时刻只允许一个编辑区：新建或编辑。 */
type EditorState =
  | {
      mode: 'create'
      draft: ScheduleDraft
      /** 本次创建的幂等键：重试复用，成功或重新开始才换。 */
      clientCreateId: string
      /** 候选带入时的待补充提示（如「缺少开始时间」）。 */
      issues: string[]
    }
  | {
      mode: 'edit'
      baseline: Schedule
      draft: ScheduleDraft
      issues: string[]
      /** 未解决的版本冲突；非 null 时禁止用旧基线直接保存。 */
      conflict: EditConflict | null
    }

type Notice = { tone: 'success' | 'error'; text: string }

export type SchedulePageProps = {
  /**
   * 数据访问实现（HTTP 或 Mock）。
   * 页面不使用任何全局单例：接哪个后端由接线者决定。
   */
  client: SchedulesClient
  /**
   * 自然语言建议提供者。**未注入时建议区整体不出现**，
   * 手动日程功能不受影响——这是「模型不可用仍可用」的最低保证。
   */
  suggest?: ScheduleSuggestionProvider
  /** 上层写入锁（例如编辑会话未保存）时禁用所有写操作。 */
  disabled?: boolean
}

function confidenceLabel(confidence: 'low' | 'medium' | 'high' | undefined): string {
  if (confidence === 'low') return '（置信度低）'
  if (confidence === 'medium') return '（置信度中）'
  if (confidence === 'high') return '（置信度高）'
  return ''
}

function SchedulePage({ client, suggest, disabled = false }: SchedulePageProps) {
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [page, setPage] = useState(1)
  const [reloadToken, setReloadToken] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  /** 非 null 表示「后台刷新失败但已有列表仍显示中」；列表内容未被错误态覆盖。 */
  const [listRefreshError, setListRefreshError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  /**
   * 列表状态的最新快照。
   *
   * 列表 effect 的失败回调是异步触发的，需要知道「此刻是否已有可见条目」
   * 来决定走错误态还是保留列表 + 横幅。用 ref 快照而不是把 `listState`
   * 加进依赖——后者会让每次本地替换条目都中断读取、多发请求。
   */
  const listStateRef = useRef(listState)
  useEffect(() => {
    // 声明在列表 effect 之前：同一提交里先更新快照，列表 effect 的异步
    // 失败回调之后触发时读到的是当次提交的最新列表状态。
    listStateRef.current = listState
  }, [listState])

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [errors, setErrors] = useState<ScheduleDraftErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 校验失败时把焦点送到第一个出错的字段（键盘/读屏用户不必自己找）。 */
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const startsAtInputRef = useRef<HTMLInputElement | null>(null)
  const endsAtInputRef = useRef<HTMLInputElement | null>(null)

  /** 正在提交的条目（完成/删除），避免同一行被连点。 */
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null)

  const [suggestText, setSuggestText] = useState('')
  const [suggestionState, setSuggestionState] = useState<SuggestionState>({ status: 'idle' })

  const readOnly = disabled || submitting

  /* ------------------------------------------------------------ 读取 */

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false
    client.list(page, controller.signal).then(
      (result) => {
        if (cancelled) return
        setListRefreshError(null)
        // D2：本页可能因为「删掉了末页最后一条」而变空。此时回退一页重读，
        // 而不是把空页渲染成「还没有日程」——后者会让用户以为数据全丢了。
        const fallbackPage = pageAfterEmptyRead(result)
        if (fallbackPage !== null) {
          setPage(fallbackPage)
          setListState({ status: 'loading' })
          setRefreshing(false)
          return
        }
        setListState({ status: 'ready', page: result })
        setRefreshing(false)
        // 服务端可能对越界页码做了收敛：以回显页码为准，避免本地页码与服务端漂移。
        if (result.page !== page) setPage(result.page)
      },
      (error: unknown) => {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        const failure = describeScheduleFailure(error, 'list')
        setRefreshing(false)
        if (listStateRef.current.status === 'ready' && listStateRef.current.page.items.length > 0) {
          // 已经有可见条目（保存/删除后的后台刷新）：刷新失败**不能**把列表换成
          // 错误态——那会让用户刚确认过的操作看起来像把数据弄丢了。
          // 保留现有列表（可能过期），用横幅说明失败并给出重试入口。
          setListRefreshError(failure.message)
          return
        }
        setListState({ status: 'error', failure })
      },
    )
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, page, reloadToken])

  const reload = useCallback(() => {
    // 出错后重试才回到 loading；已有列表时后台刷新，避免保存/删除后闪空白。
    setListState((current) => (current.status === 'error' ? { status: 'loading' } : current))
    setRefreshing(true)
    setReloadToken((token) => token + 1)
  }, [])

  const goToPage = useCallback((next: number) => {
    setListState({ status: 'loading' })
    setPage(next)
  }, [])

  /** 用服务端返回的资源原位替换，不靠本地猜测拼出新状态。 */
  function replaceItem(updated: Schedule): void {
    setListState((current) => {
      if (current.status !== 'ready') return current
      return {
        status: 'ready',
        page: {
          ...current.page,
          items: current.page.items.map((item) => (
            scheduleKey(item.id) === scheduleKey(updated.id) ? updated : item
          )),
        },
      }
    })
  }

  /**
   * 删除已被服务端确认（204）后，把这条从本地列表移除。
   *
   * 这不是「本地猜测拼状态」：204 是服务端给出的事实，与删除失败时
   * 「不改列表内容」不矛盾。先移除再刷新，用户在刷新期间也不会看到
   * 一条刚被自己删掉的日程还挂在列表里。
   */
  function removeItemLocally(id: ScheduleId): void {
    setListState((current) => {
      if (current.status !== 'ready') return current
      return {
        status: 'ready',
        page: {
          ...current.page,
          items: current.page.items.filter((item) => scheduleKey(item.id) !== scheduleKey(id)),
        },
      }
    })
  }

  /* ------------------------------------------------------------ 编辑区 */

  function startCreate(): void {
    setNotice(null)
    setFormError(null)
    setErrors({})
    setEditor({
      mode: 'create',
      draft: emptyScheduleDraft(),
      // 每次「开始新建」是一次新意图，才换新幂等键。
      clientCreateId: newClientCreateId(),
      issues: [],
    })
  }

  function startEdit(schedule: Schedule): void {
    setNotice(null)
    setFormError(null)
    setErrors({})
    setConfirmDeleteKey(null)
    setEditor({
      mode: 'edit',
      baseline: schedule,
      draft: draftFromSchedule(schedule),
      issues: [],
      conflict: null,
    })
  }

  function closeEditor(): void {
    setEditor(null)
    setErrors({})
    setFormError(null)
  }

  /**
   * 改字段：清掉旧的提示，但**不动冲突状态**——
   * 冲突是「基线过期」，改字段并不会让服务端版本变新。
   */
  function updateDraft(patch: Partial<ScheduleDraft>): void {
    if (editor === null) return
    const draft = { ...editor.draft, ...patch }
    setEditor((current) => (current === null ? current : { ...current, draft }))
    // D3：两端时间都填好就即时给中文提示，修正后自动消失；
    // 不再依赖浏览器原生 `min` 气泡（表单已 noValidate，统一走产品校验）。
    const rangeIssue = describeRangeIssue(draft)
    setErrors(rangeIssue === null ? {} : { endsAt: rangeIssue })
    setFormError(null)
  }

  function focusFirstInvalid(nextErrors: ScheduleDraftErrors): void {
    const order: Array<[keyof ScheduleDraftErrors, RefObject<HTMLInputElement | null>]> = [
      ['title', titleInputRef],
      ['startsAt', startsAtInputRef],
      ['endsAt', endsAtInputRef],
    ]
    for (const [field, ref] of order) {
      if (nextErrors[field] !== undefined) {
        ref.current?.focus()
        return
      }
    }
  }

  /**
   * 409 之后读取服务器最新版本。
   *
   * 只做「读取 + 展示」，**不改草稿、不自动合并**。读取失败同样不是清空理由：
   * `latest` 留空，冲突提示里给出重试读取的入口，草稿原样保留。
   */
  async function refreshConflictBaseline(targetId: ScheduleId): Promise<void> {
    setEditor((current) => (
      current !== null && current.mode === 'edit'
        ? { ...current, conflict: { latest: null, readError: null, checking: true } }
        : current
    ))
    try {
      const latest = await client.get(targetId)
      replaceItem(latest)
      setEditor((current) => (
        current !== null && current.mode === 'edit'
          ? { ...current, conflict: { latest, readError: null, checking: false } }
          : current
      ))
    } catch (error) {
      const failure = describeScheduleFailure(error, 'get')
      setEditor((current) => (
        current !== null && current.mode === 'edit'
          ? { ...current, conflict: { latest: null, readError: failure.message, checking: false } }
          : current
      ))
    }
  }

  /** 用户显式选择：用服务器最新 revision 提交**当前草稿**；再冲突仍保留输入。 */
  async function retryWithLatest(): Promise<void> {
    if (editor === null || editor.mode !== 'edit' || submitting) return
    const latest = editor.conflict?.latest ?? null
    if (latest === null) return

    const patch = draftToUpdateInput(editor.draft, latest)
    if (patch === null) {
      // 服务器最新内容已经等于草稿：只换基线，不重复提交、不增版。
      setEditor((current) => (
        current !== null && current.mode === 'edit'
          ? { ...current, baseline: latest, conflict: null }
          : current
      ))
      setFormError(null)
      setNotice({ tone: 'success', text: '服务器最新版本已与你的输入一致，未重复提交。' })
      return
    }

    setSubmitting(true)
    setFormError(null)
    try {
      const updated = await client.update(latest.id, patch)
      replaceItem(updated)
      closeEditor()
      setNotice({ tone: 'success', text: '已按服务器最新版本保存你的修改。' })
    } catch (error) {
      const failure = describeScheduleFailure(error, 'update')
      setNotice(null)
      if (failure.kind === 'revision_conflict') {
        // 期间又被别人改：仍然保留草稿，重新读取最新版本供比较，绝不自动覆盖。
        void refreshConflictBaseline(latest.id)
      } else {
        setFormError(failure.message)
        if (failure.needsReload) reload()
      }
    } finally {
      setSubmitting(false)
    }
  }

  /** 用户显式选择：放弃本地修改，载入服务器最新版本（按钮文案已说明后果）。 */
  function adoptLatestVersion(): void {
    if (editor === null || editor.mode !== 'edit') return
    const latest = editor.conflict?.latest ?? null
    if (latest === null) return
    setEditor({
      mode: 'edit',
      baseline: latest,
      draft: draftFromSchedule(latest),
      issues: [],
      conflict: null,
    })
    setErrors({})
    setFormError(null)
    setNotice(null)
  }

  /** 用户显式选择：保留输入、先收起冲突提示（再次保存仍会被 409 拦下，不会覆盖）。 */
  function keepEditingAfterConflict(): void {
    setEditor((current) => (
      current !== null && current.mode === 'edit' ? { ...current, conflict: null } : current
    ))
  }

  async function submitEditor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (editor === null || submitting) return
    // 冲突未解决时不允许用过期基线提交：必须先显式选择下一步。
    if (editor.mode === 'edit' && editor.conflict !== null) return

    const { errors: nextErrors, payload } = validateScheduleDraft(editor.draft)
    setErrors(nextErrors)
    if (payload === null) {
      const firstIssue = nextErrors.title ?? nextErrors.startsAt ?? nextErrors.endsAt
      setFormError(
        nextErrors.startsAt !== undefined
          // 缺时间不替用户补：这句话本身就是产品承诺，别让用户以为系统会猜一个时间。
          ? '请先修正标出的字段；时间不足时不会替你补一个时间。'
          // 其余情况把第一条具体原因放进 alert，读屏用户提交后能直接听到为什么没保存。
          : `无法保存：${firstIssue ?? '请先修正标出的字段。'}`,
      )
      focusFirstInvalid(nextErrors)
      return
    }
    setFormError(null)

    if (editor.mode === 'create') {
      setSubmitting(true)
      try {
        await client.create(buildCreateInput(payload, editor.clientCreateId))
        closeEditor()
        setNotice({ tone: 'success', text: '已创建日程（不影响 Set 目标）。' })
        reload()
      } catch (error) {
        // 创建失败一律保留表单与同一个创建键：未经用户确认不清空输入。
        const failure = describeScheduleFailure(error, 'create')
        setNotice(null)
        setFormError(failure.message)
        if (failure.needsReload) reload()
      } finally {
        setSubmitting(false)
      }
      return
    }

    const patch = draftToUpdateInput(editor.draft, editor.baseline)
    if (patch === null) {
      // 没有实际变化就不提交，避免无意义增版。
      closeEditor()
      setNotice({ tone: 'success', text: '没有实际改动，未提交。' })
      return
    }

    setSubmitting(true)
    try {
      const updated = await client.update(editor.baseline.id, patch)
      replaceItem(updated)
      closeEditor()
      setNotice({ tone: 'success', text: '已保存修改。' })
    } catch (error) {
      const failure = describeScheduleFailure(error, 'update')
      // 先清掉与本次操作无关的旧通知（例如刚才的「已取消完成。」）。
      setNotice(null)
      if (failure.kind === 'revision_conflict') {
        setFormError(null)
        void refreshConflictBaseline(editor.baseline.id)
      } else {
        // 网络失败 / 404 / 422 / 428 / 其它：保留表单与草稿，只提示并可重读列表。
        setFormError(failure.message)
        if (failure.needsReload) reload()
      }
    } finally {
      setSubmitting(false)
    }
  }

  /* ------------------------------------------------------------ 完成 / 删除 */

  async function toggleCompleted(schedule: Schedule): Promise<void> {
    const key = scheduleKey(schedule.id)
    if (busyKey !== null || readOnly) return
    setBusyKey(key)
    setNotice(null)
    try {
      const updated = await client.update(schedule.id, {
        expected_revision: schedule.revision,
        completed: !schedule.completed,
      })
      replaceItem(updated)
      setNotice({ tone: 'success', text: updated.completed ? '已标记完成。' : '已取消完成。' })
    } catch (error) {
      const failure = describeScheduleFailure(error, 'toggle')
      setNotice({ tone: 'error', text: failure.message })
      if (failure.needsReload) reload()
    } finally {
      setBusyKey(null)
    }
  }

  async function removeSchedule(schedule: Schedule): Promise<void> {
    const key = scheduleKey(schedule.id)
    if (busyKey !== null || readOnly) return
    setBusyKey(key)
    setNotice(null)
    try {
      await client.remove(schedule.id, schedule.revision)
      setConfirmDeleteKey(null)
      // 删除已被服务端确认：先从本地列表移除（刷新期间不再显示已删条目），
      // 再刷新当前页取回正确分页；若本页被删空，读取阶段会回退到有效的前一页（D2）。
      // 之后即使刷新失败，也只是横幅提示 + 保留剩余条目，不会重发删除。
      removeItemLocally(schedule.id)
      reload()
      setNotice({ tone: 'success', text: '已删除这条日程（未改动 Set 目标）。' })
    } catch (error) {
      const failure = describeScheduleFailure(error, 'delete')
      setNotice({ tone: 'error', text: failure.message })
      setConfirmDeleteKey(null)
      // 删除失败不改列表内容：不假装成功，也不清空现有条目。
      if (failure.needsReload) reload()
    } finally {
      setBusyKey(null)
    }
  }

  /* ------------------------------------------------------------ 建议候选 */

  async function requestSuggestions(): Promise<void> {
    if (suggest === undefined || suggestionState.status === 'loading') return
    const text = suggestText.trim()
    if (text === '') return
    setSuggestionState({ status: 'loading' })
    try {
      const result = await suggest({ text })
      setSuggestionState({ status: 'ready', result })
    } catch {
      // 不回显供应商原始错误体；建议失败不影响手动新建。
      setSuggestionState({
        status: 'error',
        message: '建议暂时生成失败（模型或网络不可用）。手动新建日程不受影响。',
      })
    }
  }

  /** 候选 → 表单：**只填字段，不写入**；仍要用户点保存。 */
  function applyCandidate(candidate: ScheduleSuggestionCandidate): void {
    const { draft, issues } = candidateToDraft(candidate)
    setNotice(null)
    setErrors({})
    setFormError(null)
    setEditor({ mode: 'create', draft, clientCreateId: newClientCreateId(), issues })
  }

  function dismissCandidate(candidateId: string): void {
    setSuggestionState((current) => {
      if (current.status !== 'ready') return current
      return {
        status: 'ready',
        result: {
          ...current.result,
          candidates: current.result.candidates.filter((item) => item.candidate_id !== candidateId),
        },
      }
    })
  }

  /* ------------------------------------------------------------ 渲染 */

  const items = listState.status === 'ready' ? listState.page.items : []
  const editorBusy = submitting
  const conflictPending = editor !== null && editor.mode === 'edit' && editor.conflict !== null

  return (
    <section className="sched" aria-labelledby="sched-heading">
      <header className="sched-head">
        <p className="sched-eyebrow">日程</p>
        <h2 className="sched-title" id="sched-heading">独立日程</h2>
        <p className="sched-sub">
          日程与「开始今天」的 Set 目标相互独立：这里的创建、完成、删除都不会自动改动 Set 或目标关联。
          时间按 {SHANGHAI_TIME_ZONE_LABEL} 显示。
        </p>
      </header>

      {client.source === 'mock' && (
        <p className="sched-mock" role="note">{MOCK_NOTICE}</p>
      )}

      {notice !== null && (
        <p
          className={notice.tone === 'error' ? 'sched-notice sched-notice--error' : 'sched-notice'}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      <div className="sched-toolbar">
        <button
          type="button"
          className="sched-button sched-button--primary"
          onClick={startCreate}
          disabled={disabled || editorBusy || editor !== null}
        >
          新建日程
        </button>
        <span className="sched-toolbar-meta">
          {refreshing ? '正在刷新…' : `第 ${listState.status === 'ready' ? listState.page.page : page} 页`}
        </span>
        <div className="sched-pager">
          <button
            type="button"
            className="sched-button"
            onClick={() => goToPage(page - 1)}
            disabled={page <= 1 || refreshing}
          >
            上一页
          </button>
          <button
            type="button"
            className="sched-button"
            onClick={() => goToPage(page + 1)}
            disabled={listState.status !== 'ready' || !listState.page.has_next || refreshing}
          >
            下一页
          </button>
        </div>
      </div>

      {listState.status === 'loading' && (
        <p className="sched-state" role="status">正在读取日程……</p>
      )}

      {listState.status === 'ready' && listRefreshError !== null && (
        <div className="sched-state sched-state--error" role="alert">
          <p className="sched-error-text">{listRefreshError}</p>
          <p className="sched-hint">{REFRESH_FAILED_HINT}</p>
          <button type="button" className="sched-button" onClick={reload}>重新读取</button>
        </div>
      )}

      {listState.status === 'error' && (
        <div className="sched-state sched-state--error" role="alert">
          <p className="sched-error-text">{listState.failure.message}</p>
          <p className="sched-hint">读取不会创建或修改任何日程。</p>
          <button type="button" className="sched-button" onClick={reload}>重新读取</button>
        </div>
      )}

      {listState.status === 'ready' && items.length === 0 && (
        <p className="sched-state">
          还没有日程。日程独立于 Set 目标，可以从「新建日程」开始。
        </p>
      )}

      {items.length > 0 && (
        <ul className="sched-list">
          {items.map((item) => {
            const key = scheduleKey(item.id)
            const busy = busyKey === key
            return (
              <li className="sched-item" key={key}>
                <div className="sched-item-head">
                  <p className={item.completed ? 'sched-item-title sched-item-title--done' : 'sched-item-title'}>
                    {item.title}
                  </p>
                  <span className={item.completed ? 'sched-badge sched-badge--done' : 'sched-badge'}>
                    {item.completed ? '已完成' : '未完成'}
                  </span>
                </div>
                <p className="sched-item-time">{formatShanghaiTimeRange(item.starts_at, item.ends_at)}</p>

                <div className="sched-item-actions">
                  <button
                    type="button"
                    className="sched-button"
                    onClick={() => { void toggleCompleted(item) }}
                    disabled={busy || readOnly || busyKey !== null}
                  >
                    {item.completed ? '标记未完成' : '标记完成'}
                  </button>
                  <button
                    type="button"
                    className="sched-button"
                    onClick={() => startEdit(item)}
                    disabled={busy || readOnly || busyKey !== null}
                  >
                    编辑
                  </button>
                  {confirmDeleteKey === key ? (
                    <>
                      <button
                        type="button"
                        className="sched-button sched-button--danger"
                        onClick={() => { void removeSchedule(item) }}
                        disabled={busy || readOnly || busyKey !== null}
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        className="sched-button"
                        onClick={() => setConfirmDeleteKey(null)}
                        disabled={busy}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="sched-button"
                      onClick={() => setConfirmDeleteKey(key)}
                      disabled={busy || readOnly || busyKey !== null}
                    >
                      删除
                    </button>
                  )}
                </div>

                {confirmDeleteKey === key && (
                  <p className="sched-hint">
                    删除是硬删除，只删除这条日程，不会改动 Set 目标，也无法在日程里找回。
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {editor !== null && (
        <form
          className="sched-form"
          onSubmit={(event) => { void submitEditor(event) }}
          aria-labelledby="sched-form-title"
          /*
           * 关掉浏览器原生约束校验：`min` 仍用于日期选择器的辅助提示，
           * 但提交统一走产品校验，这样「结束早于开始」显示的是中文提示（D3），
           * 而不是浏览器自带气泡；也不会出现原生气泡先拦下、用户不知道哪里错的情况。
           */
          noValidate
        >
          <h3 className="sched-form-title" id="sched-form-title">
            {editor.mode === 'create' ? '新建日程' : '编辑日程'}
          </h3>

          {editor.mode === 'edit' && editor.conflict !== null && (
            <div className="sched-conflict">
              <p className="sched-conflict-title" role="alert">
                版本冲突：这条日程在你编辑期间被其他操作修改过。你的修改仍在下面的表单里，没有被覆盖。
              </p>

              {editor.conflict.checking && (
                <p className="sched-hint" role="status">正在读取服务器最新版本……</p>
              )}

              {!editor.conflict.checking && editor.conflict.latest !== null && (
                <>
                  <p className="sched-hint">
                    服务器最新版本为第 {editor.conflict.latest.revision} 版，请与你的输入比较：
                  </p>
                  <dl className="sched-conflict-latest" aria-label="服务器最新版本">
                    <dt>标题</dt>
                    <dd>{editor.conflict.latest.title}</dd>
                    <dt>时间</dt>
                    <dd>{formatShanghaiTimeRange(
                      editor.conflict.latest.starts_at,
                      editor.conflict.latest.ends_at,
                    )}</dd>
                    <dt>状态</dt>
                    <dd>{editor.conflict.latest.completed ? '已完成' : '未完成'}</dd>
                  </dl>
                </>
              )}

              {!editor.conflict.checking && editor.conflict.latest === null && (
                <p className="sched-hint">
                  无法读取服务器最新版本
                  {editor.conflict.readError === null ? '' : `（${editor.conflict.readError}）`}
                  ；你的输入仍然保留，可以重试读取。
                </p>
              )}

              <div className="sched-conflict-actions">
                <button
                  type="button"
                  className="sched-button sched-button--primary"
                  onClick={() => { void retryWithLatest() }}
                  disabled={editorBusy || editor.conflict.latest === null}
                >
                  用最新版本重试保存
                </button>
                <button
                  type="button"
                  className="sched-button"
                  onClick={adoptLatestVersion}
                  disabled={editorBusy || editor.conflict.latest === null}
                >
                  载入最新版本（放弃我的修改）
                </button>
                <button
                  type="button"
                  className="sched-button"
                  onClick={keepEditingAfterConflict}
                  disabled={editorBusy}
                >
                  保持我的修改，稍后再处理
                </button>
              </div>

              {editor.conflict.latest === null ? (
                <p className="sched-hint">
                  读取失败不会清空你的输入；可以先「保持我的修改」，稍后再保存。
                </p>
              ) : (
                <p className="sched-hint">
                  重试会用服务器最新版本号提交你填写的内容；若期间又被修改，会再次保留输入并提示。
                </p>
              )}
            </div>
          )}

          {editor.issues.length > 0 && (
            <ul className="sched-issues" aria-label="候选待补充项">
              {editor.issues.map((issue) => (
                <li className="sched-issues-item" key={issue}>{issue}</li>
              ))}
            </ul>
          )}

          <label className="sched-field">
            <span className="sched-label">标题</span>
            <input
              className="sched-input"
              type="text"
              ref={titleInputRef}
              value={editor.draft.title}
              onChange={(event) => updateDraft({ title: event.target.value })}
              aria-invalid={errors.title !== undefined}
              aria-describedby={errors.title === undefined ? 'sched-title-count' : 'sched-title-count sched-title-error'}
              disabled={editorBusy}
            />
          </label>
          <p className="sched-counter" id="sched-title-count">
            {countCodePoints(editor.draft.title)} / {SCHEDULE_TITLE_MAX_CODE_POINTS} 个字符
          </p>
          {errors.title !== undefined && (
            <p className="sched-field-error" id="sched-title-error">{errors.title}</p>
          )}

          <label className="sched-field">
            <span className="sched-label">开始时间（{SHANGHAI_TIME_ZONE_LABEL}）</span>
            <input
              className="sched-input"
              type="datetime-local"
              step={60}
              ref={startsAtInputRef}
              value={editor.draft.startsAtInput}
              onChange={(event) => updateDraft({ startsAtInput: event.target.value })}
              aria-invalid={errors.startsAt !== undefined}
              aria-describedby={errors.startsAt === undefined ? undefined : 'sched-start-error'}
              disabled={editorBusy}
            />
          </label>
          {errors.startsAt !== undefined && (
            <p className="sched-field-error" id="sched-start-error">{errors.startsAt}</p>
          )}

          <label className="sched-field">
            <span className="sched-label">结束时间（可留空）</span>
            <input
              className="sched-input"
              type="datetime-local"
              step={60}
              ref={endsAtInputRef}
              value={editor.draft.endsAtInput}
              /*
               * `min` 只作为日期选择器的辅助提示（不要选到开始之前）。
               * 真正的判定在 validateScheduleDraft / describeRangeIssue：按**时刻**比较，
               * 中文提示 + aria-invalid + aria-describedby，不依赖原生气泡或颜色。
               */
              min={editor.draft.startsAtInput === '' ? undefined : editor.draft.startsAtInput}
              onChange={(event) => updateDraft({ endsAtInput: event.target.value })}
              aria-invalid={errors.endsAt !== undefined}
              aria-describedby={errors.endsAt === undefined ? 'sched-end-hint' : 'sched-end-hint sched-end-error'}
              disabled={editorBusy}
            />
          </label>
          <p className="sched-hint" id="sched-end-hint">可留空；若填写，必须晚于开始时间。</p>
          {errors.endsAt !== undefined && (
            <p className="sched-field-error" id="sched-end-error">{errors.endsAt}</p>
          )}

          <label className="sched-check">
            <input
              type="checkbox"
              checked={editor.draft.completed}
              onChange={(event) => updateDraft({ completed: event.target.checked })}
              disabled={editorBusy}
            />
            <span>已完成</span>
          </label>

          {formError !== null && (
            <p className="sched-field-error" role="alert">{formError}</p>
          )}

          <div className="sched-form-actions">
            <button
              type="submit"
              className="sched-button sched-button--primary"
              disabled={editorBusy || disabled || conflictPending}
            >
              {editorBusy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="sched-button" onClick={closeEditor} disabled={editorBusy}>
              取消
            </button>
            <span className="sched-hint">
              {conflictPending
                ? '请先在版本冲突提示里选择下一步；直接保存会用过期版本号被拒绝。'
                : editor.mode === 'create'
                  ? '保存前不会写入任何数据；重复提交会复用同一个创建键。'
                  : '只提交实际改动的字段。'}
            </span>
          </div>
        </form>
      )}

      {suggest !== undefined && (
        <section className="sched-suggest" aria-labelledby="sched-suggest-title">
          <h3 className="sched-form-title" id="sched-suggest-title">自然语言建议</h3>
          <p className="sched-hint">
            写一句话生成候选。候选只是建议：必须由你确认并点保存才会写入，确认前不会产生任何日程。
          </p>
          <label className="sched-field">
            <span className="sched-label">描述</span>
            <textarea
              className="sched-input"
              rows={2}
              value={suggestText}
              onChange={(event) => setSuggestText(event.target.value)}
              placeholder="例如：明天下午三点和导师讨论论文提纲"
              disabled={disabled || suggestionState.status === 'loading'}
            />
          </label>
          <div className="sched-form-actions">
            <button
              type="button"
              className="sched-button"
              onClick={() => { void requestSuggestions() }}
              disabled={disabled || suggestionState.status === 'loading' || suggestText.trim() === ''}
            >
              {suggestionState.status === 'loading' ? '生成中…' : '生成候选'}
            </button>
            <span className="sched-hint">建议可能不准确；生成失败时手动新建照常可用。</span>
          </div>

          {suggestionState.status === 'error' && (
            <p className="sched-field-error" role="alert">{suggestionState.message}</p>
          )}

          {suggestionState.status === 'ready' && (
            <>
              {suggestionState.result.mood !== null && (
                <p className="sched-mood" role="note">
                  <span className="sched-mood-tag">推测</span>
                  情绪推测：{suggestionState.result.mood.label}
                  {confidenceLabel(suggestionState.result.mood.confidence)}
                  {suggestionState.result.mood.note !== undefined && ` · ${suggestionState.result.mood.note}`}
                  —— 仅为推测，不作诊断，也不会写入日程或任何记录。
                </p>
              )}

              {suggestionState.result.candidates.length === 0 ? (
                <p className="sched-hint">没有得到候选，可以直接手动新建。</p>
              ) : (
                <ul className="sched-candidates">
                  {suggestionState.result.candidates.map((candidate) => (
                    <li className="sched-candidate" key={candidate.candidate_id}>
                      <p className="sched-candidate-title">
                        {candidate.title.trim() === '' ? '（候选没有标题）' : candidate.title}
                      </p>
                      <p className="sched-candidate-time">
                        {candidate.starts_at === null
                          ? '缺少开始时间，需要你补充'
                          : formatShanghaiTimeRange(candidate.starts_at, candidate.ends_at)}
                      </p>
                      <p className="sched-candidate-flag">候选 · 未保存</p>
                      <div className="sched-item-actions">
                        <button
                          type="button"
                          className="sched-button"
                          onClick={() => applyCandidate(candidate)}
                          disabled={disabled || editorBusy}
                        >
                          填入表单
                        </button>
                        <button
                          type="button"
                          className="sched-button"
                          onClick={() => dismissCandidate(candidate.candidate_id)}
                          disabled={disabled}
                        >
                          忽略
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </section>
  )
}

export default SchedulePage

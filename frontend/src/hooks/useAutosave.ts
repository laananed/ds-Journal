/**
 * 自动保存 React 接线（Stage 3 / S3-T02）。
 *
 * 纯逻辑（序号、单请求队列、乱序、失败、冲突）在 `../utils/autosave.ts`，
 * 这里只负责三件 React 侧的事：
 *
 * 1. **800ms 防抖**：输入停止约 800ms 后提交；另有「立即保存」入口。
 *    IME 组合期间不调度，组合结束后再开始计时，避免把半个拼音存进文件。
 * 2. **生命周期**：卸载 / 关页只做 best-effort 提醒（beforeunload），
 *    不把浏览器缓存当成「已保存」；「已保存」只代表后端已提交。
 * 3. **导航前 flush**：把 `flush()` 交给 App，所有离开出口先落库再导航；
 *    失败 / 冲突时返回 `blocked`，由 App 停留并让用户明确放弃。
 *
 * 不做本地持久草稿、不做离线队列、不引入状态框架。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  adoptServer,
  applyInput,
  beginSend,
  clearFailure,
  createAutosaveCore,
  displayStatus,
  isCoreSavable,
  isDirty,
  isSavable,
  planSave,
  rebaseRevision,
  settle,
  type AutosaveCore,
  type DraftSnapshot,
  type SaveRequest,
  type SavableContext,
  type SaveStatus,
} from '../utils/autosave'
import { pruneBlocksToServer } from '../utils/writingBlocks'

/** 自动保存需要的最小文件形状：身份 + 版本 + 服务器内容快照。 */
export interface AutosaveFile {
  id: number
  revision: number
  draft: DraftSnapshot
}

/** flush 的结论：干净 / 已落库 → 可以离开；blocked → App 停留并提示。 */
export type FlushResult = 'clean' | 'blocked'

export interface UseAutosaveOptions<F> {
  /** 是否处于编辑态；false 时不调度自动保存（查看态页面的离开检查由 dirty 决定）。 */
  enabled: boolean
  /** 首次挂载时的草稿（新建面板的空表单，或详情页载入的服务器内容）。 */
  initialDraft: DraftSnapshot
  /** 首次挂载时的服务器身份；新建为 null。 */
  initialFile?: AutosaveFile | null
  /** 新建用的稳定幂等键；省略时自动生成一次并保持。 */
  createKey?: string
  /** 新建请求；页面用自己类型的 API 实现。 */
  create: (draft: DraftSnapshot, createKey: string) => Promise<F>
  /**
   * 更新请求；页面用自己类型的 API 实现。
   * `baseline` 用于计算只包含变化字段的补丁；`expectedRevision` 必须放进请求体。
   */
  update: (
    fileId: number,
    draft: DraftSnapshot,
    baseline: DraftSnapshot,
    expectedRevision: number,
  ) => Promise<F>
  /** 把 API 响应换算成自动保存需要的身份 + 快照。 */
  toFile: (file: F) => AutosaveFile
  /** 冲突时重新读取服务器最新版本（「重新载入服务器版本」/「用我的草稿重试」用）。 */
  refetch?: () => Promise<F>
  /** 细分错误：默认把 HTTP 409 视为冲突，其余视为失败。 */
  classifyError?: (error: unknown) => 'conflict' | 'error'
  /**
   * 覆盖「值得提交」的判断；默认按创建 / 更新两种口径（见 `isSavable`）：
   * 创建校验全部待创建字段，更新只校验本次补丁实际提交的字段。
   * 页面需要额外要求（例如新建必须有业务日期）时传入 `isSavable` + `requireDate`。
   */
  savable?: (draft: DraftSnapshot, context: SavableContext) => boolean
  /** 写成功后的回调（刷新列表 / 更新详情）；不用于覆盖编辑器草稿。 */
  onSaved?: (file: F) => void
  /** Dirty 变化；App 用它做通用离开检查（Folder/Search/Trash 等无自动保存模块）。 */
  onDirtyChange?: (dirty: boolean) => void
  /** 把 flush 交给 App；卸载时回传 null。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  debounceMs?: number
}

export interface UseAutosaveResult {
  draft: DraftSnapshot
  status: SaveStatus
  error: string
  dirty: boolean
  /** 当前草稿是否满足提交条件（与自动保存 / flush 同一口径），供页面显示提示。 */
  savable: boolean
  /** 保存中（含在途请求）。 */
  saving: boolean
  /** 需要用户处理的冲突。 */
  conflict: boolean
  changeDraft: (update: Partial<DraftSnapshot>) => void
  /** 载入／切换文件（进入编辑、打开另一条记录）时调用。 */
  load: (file: AutosaveFile | null, draft: DraftSnapshot) => void
  /** IME 组合开始 / 结束：组合期间不自动保存半个拼音。 */
  onCompositionStart: () => void
  onCompositionEnd: () => void
  /** 立即保存（不等防抖）。 */
  saveNow: () => Promise<void>
  /**
   * 落地所有待保存输入并给出结论（`docs/stage3-tasks.md` §6 的「删除前先 flush」）：
   * `'clean'` = 已无待提交输入；`'blocked'` = 保存失败 / 版本冲突 / 输入不合法，
   * 调用方（如删除 AI 段）必须停下让用户处理，不能继续写库。
   */
  flush: () => Promise<FlushResult>
  /**
   * 服务器版本在**外部**被改变后（例如刚删除了一个 AI 段），用重读到的详情
   * 安全重建基线：未编辑时整体采用服务器版本；本轮又打了新字时只更新服务器
   * 基线与身份，保留较新草稿，并剔除服务器已删除的段，避免下次提交被拒。
   */
  syncFromServer: (file: AutosaveFile) => void
  /** 失败后的显式重试：复用首次创建键，草稿不变。 */
  retry: () => Promise<void>
  /** 冲突时重新载入服务器版本（丢弃本地草稿）。 */
  reloadServerVersion: () => Promise<void>
  /** 冲突时先刷新版本再用本地草稿重新提交（必须由用户显式点击）。 */
  resubmitAfterConflict: () => Promise<void>
}

const DEFAULT_DEBOUNCE_MS = 800

function newCreateKey(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  return `create-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败，请稍后重试'
}

function errorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

interface AutosaveView {
  status: SaveStatus
  error: string
  dirty: boolean
  savable: boolean
}

export function useAutosave<F>(options: UseAutosaveOptions<F>): UseAutosaveResult {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  // 每次都把最新 options 收进 ref：异步回调永远读到最新实现，
  // 又不会因为 options 对象换引用而重建定时器或 core。
  // 同步放在本组件**第一个** effect，保证同一次提交里后续 effect 与异步回调都读到新值。
  const optionsRef = useRef(options)
  const enabledRef = useRef(options.enabled)
  useEffect(() => {
    optionsRef.current = options
    enabledRef.current = options.enabled
  })

  const [draft, setDraft] = useState<DraftSnapshot>(options.initialDraft)
  const [initialCore] = useState<AutosaveCore>(() => createAutosaveCore({
    draft: options.initialDraft,
    createKey: options.createKey ?? newCreateKey(),
    file: options.initialFile
      ? { id: options.initialFile.id, revision: options.initialFile.revision }
      : null,
  }))
  const coreRef = useRef<AutosaveCore>(initialCore)
  const [view, setView] = useState<AutosaveView>(() => ({
    status: displayStatus(initialCore),
    error: initialCore.error,
    dirty: isDirty(initialCore),
    savable: isCoreSavable(initialCore),
  }))

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const composingRef = useRef(false)
  const flushingRef = useRef(false)
  const mountedRef = useRef(true)

  /**
   * 统一的可提交判定：自动保存、立即保存、retry、flush 与界面提示共用同一口径。
   * 创建态校验全部待创建字段，更新态只校验本次补丁实际提交的字段
   * （未改动的旧超长/空白正文不再重新验证，见 `docs/stage3-api.md` §2）。
   */
  const checkSavable = useCallback((core: AutosaveCore): boolean => {
    const isCreate = core.fileId === null || core.revision === null
    const context: SavableContext = { baseline: core.baseline, isCreate }
    const override = optionsRef.current.savable
    return override ? override(core.draft, context) : isSavable(core.draft, context)
  }, [])

  const publish = useCallback((): void => {
    const core = coreRef.current
    setView({
      status: displayStatus(core),
      error: core.error,
      dirty: isDirty(core),
      savable: checkSavable(core),
    })
  }, [checkSavable])

  function clearTimer(): void {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const autoSaveRef = useRef<() => Promise<void>>(async () => {})

  const scheduleTimer = useCallback((): void => {
    clearTimer()
    if (!enabledRef.current || composingRef.current || flushingRef.current) return
    if (planSave(coreRef.current, checkSavable(coreRef.current)).kind !== 'send') return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void autoSaveRef.current()
    }, debounceMs)
  }, [checkSavable, debounceMs])

  const send = useCallback(async (request: SaveRequest): Promise<void> => {
    const current = optionsRef.current
    coreRef.current = beginSend(coreRef.current, request)
    publish()
    const task = (async () => {
      try {
        const saved = request.kind === 'create'
          ? await current.create(request.snapshot, request.createKey)
          : await current.update(
              request.fileId,
              request.snapshot,
              coreRef.current.baseline,
              request.expectedRevision,
            )
        const identity = optionsRef.current.toFile(saved)
        // 只确认「这一次提交的快照」；草稿里更新的输入原样保留。
        coreRef.current = settle(coreRef.current, request.seq, {
          kind: 'ok',
          fileId: identity.id,
          revision: identity.revision,
        })
        optionsRef.current.onSaved?.(saved)
      } catch (error: unknown) {
        const classify = optionsRef.current.classifyError
          ?? ((value: unknown) => (errorStatus(value) === 409 ? 'conflict' as const : 'error' as const))
        coreRef.current = settle(
          coreRef.current,
          request.seq,
          classify(error) === 'conflict'
            ? { kind: 'conflict', message: errorMessage(error) }
            : { kind: 'error', message: errorMessage(error) },
        )
      } finally {
        inFlightRef.current = null
        if (mountedRef.current) publish()
      }
    })()
    inFlightRef.current = task
    await task
    // 保存期间又打了新字：等最近的输入停稳再排队下一次写入。
    if (mountedRef.current) scheduleTimer()
  }, [publish, scheduleTimer])

  const autoSave = useCallback(async (): Promise<void> => {
    if (composingRef.current) return
    const decision = planSave(coreRef.current, checkSavable(coreRef.current))
    if (decision.kind !== 'send') return
    await send(decision.request)
  }, [checkSavable, send])
  useEffect(() => {
    autoSaveRef.current = autoSave
  }, [autoSave])

  // 草稿变化 → 推进输入序号并按需重新计时。
  useEffect(() => {
    const next = applyInput(coreRef.current, draft)
    if (next === coreRef.current) return
    coreRef.current = next
    publish()
    scheduleTimer()
  }, [draft, publish, scheduleTimer])

  // 编辑态切换：进入编辑时补一次调度，退出编辑时取消计时。
  useEffect(() => {
    if (options.enabled) scheduleTimer()
    else clearTimer()
  }, [options.enabled, scheduleTimer])

  // 未保存输入才提醒离开；「已保存」代表后端已提交，不做承诺。
  useEffect(() => {
    mountedRef.current = true
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      if (!isDirty(coreRef.current)) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      mountedRef.current = false
      clearTimer()
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  const flush = useCallback(async (): Promise<FlushResult> => {
    clearTimer()
    flushingRef.current = true
    try {
      // 最多 50 轮：每轮要么落库一次，要么得出「干净 / 需要用户处理」的结论。
      for (let round = 0; round < 50; round += 1) {
        if (inFlightRef.current !== null) {
          await inFlightRef.current
          continue
        }
        const decision = planSave(coreRef.current, checkSavable(coreRef.current))
        if (decision.kind === 'none') return 'clean'
        if (decision.kind === 'blocked') return 'blocked'
        if (decision.kind === 'wait') continue
        await send(decision.request)
      }
      return 'blocked'
    } finally {
      flushingRef.current = false
    }
  }, [checkSavable, send])

  const saveNow = useCallback(async (): Promise<void> => {
    clearTimer()
    const decision = planSave(coreRef.current, checkSavable(coreRef.current))
    if (decision.kind === 'send') await send(decision.request)
    else if (inFlightRef.current !== null) await inFlightRef.current
  }, [checkSavable, send])

  const syncFromServer = useCallback((file: AutosaveFile): void => {
    const core = coreRef.current
    const serverDraft = file.draft
    if (isDirty(core) && core.draft.blocks !== undefined && core.draft.blocks !== null
      && serverDraft.blocks !== undefined && serverDraft.blocks !== null) {
      // 本轮删除期间用户继续输入：只换服务器基线与身份，保留较新草稿；
      // 同时剔除服务器已删除的段，否则下一次提交会被后端判为
      // 「客户端删除 AI 段」而拒绝。
      const pruned = pruneBlocksToServer(core.draft.blocks, serverDraft.blocks) ?? core.draft.blocks
      const nextDraft: DraftSnapshot = { ...core.draft, blocks: pruned }
      coreRef.current = {
        ...core,
        fileId: file.id,
        revision: file.revision,
        baseline: serverDraft,
        draft: nextDraft,
        inFlight: null,
        error: '',
      }
      setDraft(nextDraft)
    } else {
      coreRef.current = createAutosaveCore({
        draft: serverDraft,
        createKey: core.createKey,
        file: { id: file.id, revision: file.revision },
      })
      setDraft(serverDraft)
    }
    publish()
  }, [publish])

  const retry = useCallback(async (): Promise<void> => {
    coreRef.current = clearFailure(coreRef.current)
    publish()
    await saveNow()
  }, [publish, saveNow])

  const reloadServerVersion = useCallback(async (): Promise<void> => {
    const refetch = optionsRef.current.refetch
    if (!refetch) return
    const file = await refetch()
    const identity = optionsRef.current.toFile(file)
    coreRef.current = adoptServer(coreRef.current, identity, identity.draft)
    setDraft(identity.draft)
    publish()
  }, [publish])

  const resubmitAfterConflict = useCallback(async (): Promise<void> => {
    const refetch = optionsRef.current.refetch
    if (!refetch) return
    const file = await refetch()
    const identity = optionsRef.current.toFile(file)
    coreRef.current = rebaseRevision(coreRef.current, identity.id, identity.revision)
    publish()
    await saveNow()
  }, [publish, saveNow])

  const changeDraft = useCallback((update: Partial<DraftSnapshot>): void => {
    setDraft((previous) => ({ ...previous, ...update }))
  }, [])

  const load = useCallback((file: AutosaveFile | null, nextDraft: DraftSnapshot): void => {
    clearTimer()
    coreRef.current = createAutosaveCore({
      draft: nextDraft,
      createKey: coreRef.current.createKey,
      file: file ? { id: file.id, revision: file.revision } : null,
    })
    setDraft(nextDraft)
    publish()
  }, [publish])

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true
    clearTimer()
  }, [])

  const onCompositionEnd = useCallback((): void => {
    composingRef.current = false
    scheduleTimer()
  }, [scheduleTimer])

  // 把 dirty 同步给 App（离开检查）。
  useEffect(() => {
    optionsRef.current.onDirtyChange?.(view.dirty)
  }, [view.dirty])

  const flushRef = useRef(flush)
  const stableFlush = useCallback(() => flushRef.current(), [])
  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  useEffect(() => {
    const notify = optionsRef.current.onFlushReady
    if (!notify) return
    notify(options.enabled ? stableFlush : null)
    return () => notify(null)
  }, [options.enabled, stableFlush])

  return {
    draft,
    status: view.status,
    error: view.error,
    dirty: view.dirty,
    savable: view.savable,
    saving: view.status === 'saving',
    conflict: view.status === 'conflict',
    changeDraft,
    load,
    onCompositionStart,
    onCompositionEnd,
    saveNow,
    flush: stableFlush,
    syncFromServer,
    retry,
    reloadServerVersion,
    resubmitAfterConflict,
  }
}

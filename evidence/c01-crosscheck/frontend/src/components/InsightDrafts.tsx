/**
 * Insight 草稿自主添加面板（Stage 3 / S3-T10）。
 *
 * 对应 `docs/stage3.md` §6 与 `docs/stage3-tasks.md` §12：
 *
 * - 一次复盘可以返回**零份或多份独立观点草稿**；一份草稿只有**一个观点**，
 *   但可以带**多个依据**（每项含真实来源身份与用户原文引用）。
 * - **只查看零写入**：展开、收起、看依据都不发任何写请求；本组件只读草稿 props，
 *   也不在挂载时做任何自动保存。
 * - 用户主动点「添加为 Insight」或「另加一份」才进入既有编辑器；另加时换新键。
 * - 相似内容用**普通搜索** `GET /api/search`：只帮用户把**观点关键词**填进搜索框，
 *   显示真实命中与错误/重试；不做语义去重、不自动合并、不在前端假装相似。
 *
 * 本组件不在前端猜测相似度，也不复制 `ReviewPreview` / 复盘功能：
 * 它只消费 T10 本地最小输入形状（`InsightDraftSeed`），可从 T09 的预览回调获得。
 */

import { useEffect, useState } from 'react'
import { SearchApiError, searchFiles } from '../api/search.ts'
import type { SearchItem, SearchPageData } from '../types/search.ts'
import { duplicateSeed, SEARCH_KEYWORD_MAX, type InsightDraftSeed } from '../utils/insightAiDraft.ts'
import './InsightDrafts.css'

export interface InsightDraftsProps {
  /** 零草稿时面板提示「本次没有提炼出可添加的观点」，不产生任何文件。 */
  drafts: InsightDraftSeed[]
  /**
   * 用户主动选择「添加为 Insight」。父级据此进入既有 Insight 编辑器，
   * 并把 `seed.createKey` 作为 `client_create_id` 交给自动保存。
   */
  onAddInsight: (seed: InsightDraftSeed) => void
  /** 其他写入 / AI 处理中时禁用交互（沿用 App 的 busy 口径）。 */
  busy?: boolean
  /** 打开普通搜索命中项；省略时只显示命中，不提供跳转。 */
  onOpenFile?: (file: SearchItem) => void
  /** 关闭草稿面板（可选）；不触发任何写入。 */
  onDismiss?: () => void
  /** 面板标题文案，便于在复盘预览与 Insight 模块两处复用。 */
  title?: string
}

/**
 * 一次普通搜索会话：草稿 + 已提交的关键词 + 页码 + 显式重试代数。
 *
 * 关键词在用户点「搜索」时才写进这里，所以输入过程中不会发请求；
 * `generation` 让「再次点击搜索 / 点击重试」一定重新请求，
 * 不会被「上一次结果还在缓存里」挡住。
 */
interface SearchSession {
  draftKey: string | null
  keyword: string
  page: number
  generation: number
}

/** 已完成的一次搜索：只认自己那次会话（key 相同）的结果。 */
interface SearchResults {
  key: string
  result: SearchPageData | null
  error: string
}

const IDLE_SESSION: SearchSession = { draftKey: null, keyword: '', page: 1, generation: 0 }

function sessionKey(session: SearchSession): string {
  return [session.draftKey ?? '', session.keyword, session.page, session.generation].join('\u0000')
}

function snippet(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}……` : flat
}

function typeLabel(type: SearchItem['type']): string {
  return { journal: 'Journal', inbox: 'Inbox', insight: 'Insight' }[type]
}

/** 卡片/无障碍标签用的草稿名称；空标题不显示成空白。 */
function draftLabelFor(seed: InsightDraftSeed): string {
  return seed.title.trim() === '' ? '未命名观点' : seed.title
}

function InsightDrafts({
  drafts, onAddInsight, busy = false, onOpenFile, onDismiss, title = 'AI 提炼的观点草稿',
}: InsightDraftsProps) {
  /** 展开依据的草稿（纯本地查看状态，不触发任何写入）。 */
  const [expanded, setExpanded] = useState<string | null>(null)
  /** 当前展示着搜索框的草稿。 */
  const [openSearch, setOpenSearch] = useState<string | null>(null)
  /** 搜索框里的待提交关键词（输入不发请求）。 */
  const [keywords, setKeywords] = useState<Record<string, string>>({})
  /** 已提交的搜索会话；只有它变化才真的调用 `GET /api/search`。 */
  const [session, setSession] = useState<SearchSession>(IDLE_SESSION)
  const [results, setResults] = useState<SearchResults>({ key: '', result: null, error: '' })

  // 草稿列表换了（例如另一次复盘的结果）就在渲染期重置，避免旧的展开/搜索状态
  // 串到新草稿上，也避免在 effect 里做级联 setState。
  const signature = drafts.map((draft) => draft.createKey).join('|')
  const [seenSignature, setSeenSignature] = useState(signature)
  if (seenSignature !== signature) {
    setSeenSignature(signature)
    setExpanded(null)
    setOpenSearch(null)
    setKeywords({})
    setSession(IDLE_SESSION)
    setResults({ key: '', result: null, error: '' })
  }

  const activeKey = sessionKey(session)
  const current = results.key === activeKey ? results : null

  // 唯一发请求的地方：会话已提交、关键词非空、且结果还不是这次会话的。
  // 重试通过 generation 改变 activeKey，因此一定会重新请求。
  useEffect(() => {
    if (session.draftKey === null || session.keyword.trim() === '') return
    if (results.key === activeKey && results.error === '') return
    const controller = new AbortController()
    searchFiles({ q: session.keyword.trim(), type: 'insight', page: session.page }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setResults({ key: activeKey, result, error: '' })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setResults({
          key: activeKey,
          result: null,
          error: error instanceof SearchApiError
            ? error.message
            : (error instanceof Error ? error.message : '搜索失败，请稍后重试'),
        })
      })
    return () => controller.abort()
  }, [activeKey, session.draftKey, session.keyword, session.page, results.key, results.error])

  /** 渲染期推导的搜索显示状态；不用 effect 写回，避免级联渲染。 */
  const searchView = (() => {
    if (session.draftKey === null) return { kind: 'closed' as const }
    const draft = drafts.find((item) => item.createKey === session.draftKey) ?? null
    if (session.keyword.trim() === '') return { kind: 'empty' as const, draft }
    if (current === null) return { kind: 'loading' as const, draft }
    if (current.error !== '') return { kind: 'error' as const, draft, message: current.error }
    if (current.result === null) return { kind: 'loading' as const, draft }
    return { kind: 'success' as const, draft, result: current.result }
  })()

  function toggleExpanded(createKey: string): void {
    // 纯查看：只改本地展开状态，不发请求、不写库。
    setExpanded((value) => (value === createKey ? null : createKey))
  }

  /** 用户主动点「搜索相似内容」：打开搜索框并默认填入观点关键词。 */
  function openSearchFor(seed: InsightDraftSeed): void {
    setOpenSearch(seed.createKey)
    setKeywords((value) => (
      value[seed.createKey] === undefined ? { ...value, [seed.createKey]: seed.keyword } : value
    ))
    // 只是打开搜索框：不提交会话，因此不会发请求。
    if (session.draftKey !== seed.createKey) setSession(IDLE_SESSION)
  }

  /** 用户点「搜索」或换页：提交会话，这才是唯一会发请求的入口。 */
  function submitSearch(seed: InsightDraftSeed, page = 1): void {
    setSession((currentSession) => ({
      draftKey: seed.createKey,
      keyword: keywords[seed.createKey] ?? seed.keyword,
      page,
      generation: currentSession.generation + 1,
    }))
  }

  /** 用户点「重试」：同一个会话，只换代重新请求。 */
  function retrySearch(): void {
    setSession((currentSession) => ({
      ...currentSession,
      generation: currentSession.generation + 1,
    }))
  }

  function changeKeyword(createKey: string, value: string): void {
    setKeywords((current_) => ({ ...current_, [createKey]: value }))
    // 关键词改了：旧的提交结果不再是这次输入的结果，等用户再次点击「搜索」。
    if (session.draftKey === createKey) setSession(IDLE_SESSION)
  }

  function closeSearch(): void {
    setOpenSearch(null)
    setSession(IDLE_SESSION)
  }

  return (
    <section className="insight-drafts" aria-label={title}>
      <div className="insight-drafts-header">
        <h3>{title}</h3>
        <p className="insight-drafts-hint">
          一次复盘可能提炼出零份或多份独立观点。查看不会创建文件，
          主动选择「添加为 Insight」后进入编辑；要再创建独立文件，请选择「另加一份」。
        </p>
        {onDismiss && (
          <button type="button" onClick={onDismiss} disabled={busy}>收起草稿</button>
        )}
      </div>

      {drafts.length === 0 && (
        <p className="app-state" role="status">
          这次复盘没有提炼出可添加的观点；没有创建任何 Insight。
        </p>
      )}

      {drafts.length > 0 && (
        <ul className="insight-draft-list">
          {drafts.map((seed, index) => {
            const isExpanded = expanded === seed.createKey
            const isSearchOpen = openSearch === seed.createKey
            const keyword = keywords[seed.createKey] ?? seed.keyword
            const view = isSearchOpen ? searchView : { kind: 'closed' as const }
            return (
              <li key={seed.createKey} className="insight-draft-card">
                <article aria-label={`观点草稿 ${index + 1}`}>
                  <header className="insight-draft-head">
                    <h4 className="insight-draft-title">{draftLabelFor(seed)}</h4>
                    <span className="insight-draft-count">
                      一个观点 · {seed.evidenceCount} 条依据
                    </span>
                  </header>

                  <p className="insight-draft-viewpoint">
                    {seed.viewpoint.trim() === '' ? '（这份草稿没有观点原文，请补充）' : seed.viewpoint}
                  </p>

                  {seed.evidenceCount > 0 && (
                    <div className="insight-draft-evidence">
                      <button type="button" onClick={() => toggleExpanded(seed.createKey)}
                        aria-expanded={isExpanded} disabled={busy}>
                        {isExpanded ? '收起依据' : `查看 ${seed.evidenceCount} 条依据`}
                      </button>
                      {isExpanded && (
                        <ul>
                          {seed.evidenceLines.map((line, lineIndex) => (
                            <li key={`${seed.createKey}-evidence-${lineIndex}`}>
                              <span className="insight-draft-source">{line.source}</span>
                              <span className="insight-draft-quote">{line.quote}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <div className="insight-draft-actions">
                    <button type="button" className="insight-draft-add"
                      onClick={() => onAddInsight(seed)} disabled={busy}>
                      添加为 Insight
                    </button>
                    {/* 只在明确另加时换键；种子交给编辑器后，保存重试沿用该键。 */}
                    <button type="button" disabled={busy}
                      onClick={() => onAddInsight(duplicateSeed(seed, crypto.randomUUID()))}>
                      另加一份
                    </button>
                    <button type="button" onClick={() => openSearchFor(seed)} disabled={busy}
                      aria-expanded={isSearchOpen}>
                      {isSearchOpen ? '已打开相似内容搜索' : '搜索相似内容'}
                    </button>
                  </div>

                  {isSearchOpen && (
                    <div className="insight-draft-search" aria-label="普通搜索相似内容">
                      <p className="detail-hint">
                        用普通搜索在已有 Insight 里找相似内容：默认填入这份草稿的标题当关键词，
                        你可以改成任意词（现有搜索按词做子串匹配，长句往往搜不到）。
                        不做自动合并，也不判断语义相似（最多 {SEARCH_KEYWORD_MAX} 个字符）。
                      </p>
                      <label className="insight-draft-search-field">
                        <span>关键词</span>
                        <input type="text" value={keyword} disabled={busy}
                          maxLength={SEARCH_KEYWORD_MAX}
                          aria-label={`${draftLabelFor(seed)} 的搜索关键词`}
                          onChange={(event) => changeKeyword(seed.createKey, event.target.value)} />
                      </label>
                      <div className="insight-draft-search-actions">
                        <button type="button" disabled={busy}
                          onClick={() => submitSearch(seed)}>搜索</button>
                        <button type="button" disabled={busy} onClick={closeSearch}>关闭搜索</button>
                      </div>

                      {view.kind === 'empty' && (
                        <p className="app-state" role="status">请输入要搜索的关键词。</p>
                      )}
                      {view.kind === 'loading' && (
                        <p className="app-state" role="status">正在搜索已有 Insight……</p>
                      )}
                      {view.kind === 'error' && (
                        <div className="app-state app-state-error" role="alert">
                          <p>搜索失败：{view.message}</p>
                          <button type="button" disabled={busy} onClick={retrySearch}>重试</button>
                        </div>
                      )}
                      {view.kind === 'success' && (
                        <>
                          {view.result.items.length === 0
                            ? <p className="app-state">没有匹配的已有 Insight；可以放心添加这一份。</p>
                            : (
                              <ul className="insight-draft-hits">
                                {view.result.items.map((hit) => (
                                  <li key={`${hit.type}:${hit.id}`}>
                                    <button type="button" disabled={busy || !onOpenFile}
                                      onClick={() => onOpenFile?.(hit)}>
                                      <span className="insight-draft-hit-type">{typeLabel(hit.type)}</span>
                                      <span className="insight-draft-hit-title">{hit.display_title}</span>
                                      <span className="insight-draft-hit-snippet">{snippet(hit.content)}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          <div className="insight-draft-search-actions">
                            <span>共 {view.result.total} 条命中，第 {view.result.page} 页。</span>
                            <button type="button" disabled={busy || view.result.page <= 1}
                              onClick={() => submitSearch(seed, Math.max(1, view.result.page - 1))}>
                              上一页
                            </button>
                            <button type="button" disabled={busy || !view.result.has_next}
                              onClick={() => submitSearch(seed, view.result.page + 1)}>
                              下一页
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </article>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default InsightDrafts

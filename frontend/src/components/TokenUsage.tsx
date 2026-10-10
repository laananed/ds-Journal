/** Stage 3 / S3-T03：Token 计量组件。
 *
 * 两种用法：
 *
 * - 不传 `source`：显示 `GET /api/ai/usage` 的全软件累计；
 * - 传 `source={{type,id}}`：显示该文件关联的调用记录（`GET /api/files/.../ai-calls`）。
 *
 * 组件真实读取后端，不使用静态假值。已知 Token 与未知子调用分开显示：官方没有
 * 返回 usage 的调用计入「未知调用」，不能显示成 0 或声称账单精确。
 */
import { useCallback, useEffect, useState } from 'react'
import './TokenUsage.css'
import { AiApiError, getAIUsage, listFileAICalls } from '../api/ai'
import type { AICallSummary, AIUsage } from '../types/ai'
import {
  shapeFileCallsResponse,
  shapeUsageResponse,
  type TokenUsageSection,
} from '../utils/tokenUsageData'

export interface TokenUsageProps {
  /** 省略时显示全局累计；给出文件身份时显示该文件的调用记录。 */
  source?: { type: 'journal' | 'inbox'; id: number }
  /** 父级写入中（例如自动保存）时禁止翻页，避免与其它操作竞争。 */
  disabled?: boolean
}

const STATUS_LABELS: Record<string, string> = {
  pending: '进行中', ready: '待确认', applied: '已完成', failed: '失败',
  conflict: '源已变化', unknown: '状态未知',
}

function countText(value: number): string {
  return value.toLocaleString('zh-CN')
}

function usageSummary(usage: AIUsage): string {
  const unknown = usage.unknown_subcalls
  return `已确认 Token ${countText(usage.total_tokens)}`
    + (unknown > 0 ? ` + 未知调用 ${countText(unknown)} 次` : '')
}

function callSummary(call: AICallSummary): string {
  const known = `输入 ${countText(call.prompt_tokens)} / 输出 ${countText(call.completion_tokens)}`
  const unknown = call.unknown_subcalls > 0 ? ` + 未知子调用 ${countText(call.unknown_subcalls)}` : ''
  const searches = call.search_requests > 0 ? `，搜索 ${countText(call.search_requests)} 次` : ''
  return `${known}${unknown}${searches}`
}

/**
 * `TokenUsage` 只读展示；不写入、不重试计费、不提供任何「刷新即重发」的行为。
 */
function TokenUsage({ source, disabled = false }: TokenUsageProps) {
  const [section, setSection] = useState<TokenUsageSection | null>(null)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const sourceType = source?.type
  const sourceId = source?.id

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    // 两个接口的形状不同，分别按自己的响应类型投影；全局分支不再可能收到分页对象。
    const request: Promise<TokenUsageSection> = sourceType !== undefined && sourceId !== undefined
      ? listFileAICalls(sourceType, sourceId, page, controller.signal).then(shapeFileCallsResponse)
      : getAIUsage(controller.signal).then(shapeUsageResponse)
    request.then((data) => {
      if (controller.signal.aborted) return
      setSection(data)
      setStatus('success')
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setSection(null)
      // 源已失效（404）与普通读取失败分别说明，不假装有数据。
      if (failure instanceof AiApiError && failure.status === 404) {
        setError('该文件的调用记录不可用（文件不存在或已移入回收箱）。')
      } else {
        setError(failure instanceof Error ? failure.message : '读取计量失败，请稍后重试')
      }
      setStatus('error')
    })
    return () => controller.abort()
  }, [sourceType, sourceId, page, reloadToken])

  const refresh = useCallback(() => setReloadToken((value) => value + 1), [])

  const scopeLabel = sourceType === undefined ? '全软件累计' : '本文件调用记录'
  const usage = section?.kind === 'usage' ? section.usage : null
  const calls = section?.kind === 'calls' ? section.calls : null
  // 下一页严格由服务端 has_next 决定，不用「本页返回几条」推断。
  const hasNext = section?.kind === 'calls' ? section.pagination.hasNext : false

  return (
    <section className="token-usage" aria-label={`Token 用量：${scopeLabel}`}>
      <header className="token-usage-header">
        <h3>Token 用量（{scopeLabel}）</h3>
        <button type="button" onClick={refresh} disabled={disabled || status === 'loading'}>
          重新读取
        </button>
      </header>

      {status === 'loading' && <p className="token-usage-state" role="status">正在读取计量……</p>}

      {status === 'error' && (
        <div className="token-usage-state token-usage-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={refresh} disabled={disabled}>重试</button>
        </div>
      )}

      {status === 'success' && usage && (
        <dl className="token-usage-grid">
          <div><dt>输入 Token</dt><dd>{countText(usage.prompt_tokens)}</dd></div>
          <div><dt>输出 Token</dt><dd>{countText(usage.completion_tokens)}</dd></div>
          <div><dt>合计 Token</dt><dd>{countText(usage.total_tokens)}</dd></div>
          <div><dt>未知子调用</dt><dd>{countText(usage.unknown_subcalls)}</dd></div>
          <div><dt>搜索请求</dt><dd>{countText(usage.search_requests)}</dd></div>
        </dl>
      )}

      {status === 'success' && usage && (
        <p className="token-usage-note">
          {usageSummary(usage)}。仅统计官方返回 usage 的子调用；搜索请求不计入模型 Token，
          删除文件或 AI 回复也不会减少累计。
        </p>
      )}

      {status === 'success' && calls && (
        <>
          {calls.length === 0
            ? <p className="token-usage-state">这个文件还没有 AI 调用记录。</p>
            : (
              <ul className="token-usage-calls">
                {calls.map((call) => (
                  <li key={call.request_id}>
                    <div className="token-usage-call-head">
                      <span className={`token-usage-kind token-usage-kind-${call.kind}`}>{call.kind}</span>
                      <span className="token-usage-status">{STATUS_LABELS[call.status] ?? call.status}</span>
                      <time dateTime={call.created_at}>{call.created_at}</time>
                    </div>
                    <p className="token-usage-call-meta">
                      调用 <code>{call.request_id}</code>
                    </p>
                    <p className="token-usage-call-meta">{callSummary(call)}</p>
                    <p className="token-usage-call-meta">
                      来源：{call.sources.length === 0
                        ? '（无）'
                        : call.sources.map((item) => `${item.type} #${item.id}`).join('、')}
                      {call.saved_target && `　保存到 journal #${call.saved_target.id}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          <div className="token-usage-pager">
            <button type="button" disabled={disabled || page === 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
            <span>第 {page} 页</span>
            <button type="button" disabled={disabled || !hasNext}
              onClick={() => setPage((value) => value + 1)}>下一页</button>
          </div>
        </>
      )}
    </section>
  )
}

export default TokenUsage

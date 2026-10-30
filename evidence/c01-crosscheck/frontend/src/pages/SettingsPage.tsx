/** Stage 3 / S3-T03：AI 设置页面。
 *
 * 行为（对齐 `docs/stage3-api.md` §3）：
 *
 * - 打开时真实读取 `GET /api/ai/settings`；缺设置行时后端返回默认值与
 *   `revision=0`，因此首次进入**不会**创建数据库行；
 * - 保存时带着当前 `revision` 提交；首次保存（revision 0）创建唯一设置行；
 * - 409 表示版本已变化：保留用户输入、重新读取并提示，不静默覆盖；
 * - 428/422 等失败保留输入并显示后端消息；
 * - 自定义提示词最多 4,000 个 Unicode 码点，超出时本地阻止提交；
 * - 只显示配置状态。Key 由后端进程环境读取，本页面既不显示也不接收 Key。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import './SettingsPage.css'
import { AiApiError, getAISettings, updateAISettings } from '../api/ai'
import TokenUsage from '../components/TokenUsage'
import type { AISettings } from '../types/ai'

export interface SettingsPageProps {
  /** 父级写入中时禁止保存，避免与自动保存等操作竞争。 */
  disabled?: boolean
}

const CUSTOM_PROMPT_MAX_CODE_POINTS = 4_000

/** 按 Unicode 码点计数：`Array.from` 把代理对还原成单个码点，emoji 只算 1 个。 */
function codePointLength(value: string): number {
  return Array.from(value).length
}

function configurationText(settings: AISettings): string {
  return settings.model_configured
    ? `已配置（模型固定 ${settings.model}）`
    : '未配置（服务端进程环境缺少模型 Key）'
}

function searchText(settings: AISettings): string {
  if (!settings.search_configured) return '未配置（不会联网，可在后端配置搜索 Key）'
  return settings.web_enabled ? '已启用且已配置' : '已配置但当前关闭'
}

function SettingsPage({ disabled = false }: SettingsPageProps) {
  const [settings, setSettings] = useState<AISettings | null>(null)
  const [prompt, setPrompt] = useState('')
  const [webEnabled, setWebEnabled] = useState(true)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  /** 409 时重新读取仅仅为了拿到最新版本号，不能覆盖用户已经输入的草稿。 */
  const keepDraft = useRef(false)
  const writing = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setLoadError('')
    getAISettings(controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setSettings(data)
      if (!keepDraft.current) {
        // 服务器值是唯一基线：草稿只在成功读取且没有待保留输入时同步。
        setPrompt(data.custom_prompt)
        setWebEnabled(data.web_enabled)
      }
      keepDraft.current = false
      setStatus('success')
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      keepDraft.current = false
      setSettings(null)
      setLoadError(failure instanceof Error ? failure.message : '读取设置失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [reloadToken])

  const reload = useCallback(() => {
    keepDraft.current = false
    setNotice('')
    setSaveError('')
    setReloadToken((value) => value + 1)
  }, [])

  /** 拿到最新版本号，但保留用户当前的草稿输入。 */
  const resyncRevision = useCallback(() => {
    keepDraft.current = true
    setReloadToken((value) => value + 1)
  }, [])

  const promptLength = codePointLength(prompt)
  const promptTooLong = promptLength > CUSTOM_PROMPT_MAX_CODE_POINTS
  const dirty = settings !== null
    && (prompt !== settings.custom_prompt || webEnabled !== settings.web_enabled)
  const busy = saving || disabled

  async function save() {
    if (writing.current || settings === null) return
    setSaveError('')
    setNotice('')
    if (promptTooLong) {
      setSaveError(`自定义提示词最多 ${CUSTOM_PROMPT_MAX_CODE_POINTS} 个字符（当前 ${promptLength} 个）。`)
      return
    }
    writing.current = true
    setSaving(true)
    try {
      const saved = await updateAISettings({
        expected_revision: settings.revision,
        custom_prompt: prompt,
        web_enabled: webEnabled,
      })
      setSettings(saved)
      setPrompt(saved.custom_prompt)
      setWebEnabled(saved.web_enabled)
      setNotice(saved.revision === 1 ? '设置已保存（这是第一次保存）。' : '设置已保存。')
    } catch (failure: unknown) {
      if (failure instanceof AiApiError && failure.status === 409) {
        // 保留用户输入，把最新版本号读回来作为新基线，由用户决定是否再次保存。
        setSaveError(`设置已被其他操作修改：${failure.message}`)
        resyncRevision()
      } else if (failure instanceof AiApiError && failure.status === 428) {
        setSaveError('缺少版本信息，请重新读取设置后再保存。')
        resyncRevision()
      } else {
        setSaveError(failure instanceof Error ? failure.message : '保存失败，请稍后重试')
      }
    } finally {
      writing.current = false
      setSaving(false)
    }
  }

  function resetDraft() {
    if (settings === null) return
    setPrompt(settings.custom_prompt)
    setWebEnabled(settings.web_enabled)
    setSaveError('')
    setNotice('')
  }

  return (
    <section className="settings-page" aria-label="AI 设置模块">
      <header className="settings-header">
        <h2>AI 设置</h2>
        <button type="button" onClick={reload} disabled={busy || status === 'loading'}>重新读取</button>
      </header>

      {status === 'loading' && <p className="settings-state" role="status">正在读取设置……</p>}

      {status === 'error' && (
        <div className="settings-state settings-state-error" role="alert">
          <p>读取设置失败：{loadError}</p>
          <button type="button" onClick={reload} disabled={disabled}>重试</button>
        </div>
      )}

      {status === 'success' && settings && (
        <>
          <section className="settings-status" aria-label="AI 配置状态">
            <h3>配置状态</h3>
            <dl className="settings-status-grid">
              <div>
                <dt>模型</dt>
                <dd className={settings.model_configured ? 'settings-ok' : 'settings-missing'}>
                  {configurationText(settings)}
                </dd>
              </div>
              <div>
                <dt>联网搜索</dt>
                <dd className={settings.search_configured ? 'settings-ok' : 'settings-missing'}>
                  {searchText(settings)}
                </dd>
              </div>
              <div>
                <dt>本次生效的联网</dt>
                <dd>{settings.effective_web_enabled ? '开启（偏好与搜索 Key 都已具备）' : '关闭'}</dd>
              </div>
              <div>
                <dt>设置版本</dt>
                <dd>{settings.revision === 0 ? '尚未保存过（默认值）' : `revision ${settings.revision}`}</dd>
              </div>
            </dl>
            <p className="settings-hint">
              模型 Key 与搜索 Key 只由后端进程环境读取，不进入数据库、不返回浏览器。
              本页面只显示「是否已配置」，也不提供在浏览器中填写 Key 的入口。
              没有 Key 不会影响记录、编辑、搜索等原有功能。
            </p>
          </section>

          <section className="settings-form" aria-label="AI 设置表单">
            <h3>自定义提示词</h3>
            <label className="settings-field">
              <span>补充你希望 AI 注意的语气或角度（最多 {CUSTOM_PROMPT_MAX_CODE_POINTS} 个字符）</span>
              <textarea value={prompt} rows={6} disabled={busy}
                aria-invalid={promptTooLong}
                onChange={(event) => { setPrompt(event.target.value); setNotice(''); setSaveError('') }} />
            </label>
            <p className={promptTooLong ? 'settings-counter settings-counter-over' : 'settings-counter'}>
              {promptLength} / {CUSTOM_PROMPT_MAX_CODE_POINTS} 个字符
              {promptTooLong && '（超出上限，无法保存；空字符串表示清除提示词）'}
            </p>

            <label className="settings-checkbox">
              <input type="checkbox" checked={webEnabled} disabled={busy}
                onChange={(event) => { setWebEnabled(event.target.checked); setNotice(''); setSaveError('') }} />
              <span>允许 AI 在需要外部资料时联网搜索（默认开启）</span>
            </label>
            <p className="settings-hint">
              关闭后不提供搜索工具；开启但没有搜索 Key 时不会联网，也不会伪造来源。
              提示词只补充语气与角度，不覆盖正文与 AI 回复的区分、搜索隐私与数据安全规则。
            </p>

            <div className="settings-actions">
              <button type="button" onClick={save} disabled={busy || !dirty || promptTooLong}>
                {saving ? '保存中……' : '保存设置'}
              </button>
              <button type="button" onClick={resetDraft} disabled={busy || !dirty}>放弃本次修改</button>
              {dirty && <span className="settings-dirty" role="status">有未保存的修改</span>}
            </div>

            {notice && <p className="settings-success" role="status">{notice}</p>}
            {saveError && <p className="settings-error" role="alert">{saveError}（输入已保留，可修改后重试。）</p>}
          </section>

          <TokenUsage disabled={busy} />
        </>
      )}
    </section>
  )
}

export default SettingsPage

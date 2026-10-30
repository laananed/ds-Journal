/**
 * 当前问题模板（S04-T10 左栏上下文）。
 *
 * 产品边界（`docs/stage4.md` §3、§5）：
 * - 左栏只展示**当前**模板，不列历史模板；每种 Ritual 一份，0～4 个问题；
 * - 点击问题才把「当时文字快照」插入正文；之后增删改、换序都不回写正文；
 * - 模板为空时给「添加问题」入口，不自动生成问题、不调用模型。
 *
 * 组件是受控视图：不自己发请求，保存与插入都交回页面回调。
 * 本地编辑先留在组件里，只有用户点「保存模板」才提交；
 * 冲突时保留本地编辑并显示重新读取入口（服务端版本没变就不清空输入）。
 */

import { useMemo, useState } from 'react'
import type { RitualKind, RitualQuestion } from '../types/ritual'
import {
  QUESTION_TEXT_LIMIT,
  TEMPLATE_CAPACITY,
  addTemplateQuestion,
  displayTitle,
  newNodeId,
  questionTextError,
  removeTemplateQuestion,
  templatesEqual,
  visibleQuestions,
} from '../utils/ritualView'

export interface RitualQuestionsProps {
  kind: RitualKind
  journalDate: string
  questions: readonly RitualQuestion[]
  revision: number
  /** 模板读取中或没有读到：禁用编辑入口。 */
  loading?: boolean
  /** 页面级写入锁（保存中 / 冲突处理中）。 */
  disabled?: boolean
  /** 冲突或保存失败的提示；有值时保留本地编辑。 */
  error?: string
  /** 服务端是否已提供受控的问题插入端点（当前为 false，见 ritualView）。 */
  canInsert: boolean
  insertBlockedReason?: string
  /** 提交模板：页面负责 PATCH 与 CAS。 */
  onSave: (questions: RitualQuestion[]) => void
  /** 重新读取模板（丢弃本地未保存编辑前需要用户确认）。 */
  onReload: () => void
  /** 把某个问题插入正文末尾。 */
  onInsert: (question: RitualQuestion) => void
  /** 插入被拒绝时的提示展示（例如正文未加载）。 */
  insertError?: string
}

function RitualQuestions({
  kind,
  journalDate,
  questions,
  revision,
  loading = false,
  disabled = false,
  error,
  canInsert,
  insertBlockedReason,
  onSave,
  onReload,
  onInsert,
  insertError,
}: RitualQuestionsProps) {
  /**
   * 本地编辑以「服务端基线签名」为锚：服务端模板一变（保存成功或重新读取），
   * 旧编辑自动失效，组件回到跟随状态，不需要用 effect 反向同步 props。
   */
  const signature = `${revision}|${questions.map((item) => `${item.id}:${item.text}`).join('|')}`
  const [edited, setEdited] = useState<{ base: string; questions: RitualQuestion[] } | null>(null)
  const [localError, setLocalError] = useState('')

  const following = edited !== null && edited.base === signature ? edited.questions : null
  const current = following ?? [...questions]
  const visible = useMemo(() => visibleQuestions(current), [current])
  const dirty = following !== null && !templatesEqual(following, questions)
  const locked = disabled || loading

  function edit(next: RitualQuestion[], message = '') {
    setEdited({ base: signature, questions: next })
    setLocalError(message)
  }

  function handleAdd() {
    const result = addTemplateQuestion(current, '新的问题', newNodeId())
    if (!result.ok) {
      setLocalError(result.message)
      return
    }
    edit(result.questions)
  }

  function handleText(index: number, value: string) {
    const next = current.map((item, position) => (position === index ? { ...item, text: value } : item))
    edit(next)
  }

  function handleRemove(index: number) {
    edit(removeTemplateQuestion(current, index))
  }

  function handleSave() {
    const invalid = current.findIndex((item) => questionTextError(item.text) !== null)
    if (invalid >= 0) {
      const message = questionTextError(current[invalid].text) ?? '问题内容不合法。'
      setLocalError(`第 ${invalid + 1} 个问题：${message}`)
      return
    }
    if (current.length > TEMPLATE_CAPACITY) {
      setLocalError(`当前模板最多 ${TEMPLATE_CAPACITY} 个问题。`)
      return
    }
    onSave(current.map((item) => ({ id: item.id, text: item.text.trim() })))
  }

  return (
    <section className="ritual-questions" aria-labelledby="ritual-questions-title">
      <header className="ritual-questions-head">
        <h3 id="ritual-questions-title">当前问题模板</h3>
        <p className="ritual-questions-meta">
          {displayTitle(kind, journalDate, null)} · {visible.questions.length} / {TEMPLATE_CAPACITY}
        </p>
      </header>

      <p className="ritual-questions-hint">
        点击「插入正文」才会把当时的文字写进正文；之后修改模板不会改动已插入内容。
      </p>

      {loading && <p className="ritual-questions-state" role="status">正在读取问题模板……</p>}

      {!loading && visible.questions.length === 0 && (
        <p className="ritual-questions-empty">
          还没有问题。可以添加最多 {TEMPLATE_CAPACITY} 个问题，模板为空时不会自动生成问题。
        </p>
      )}

      {!loading && visible.questions.length > 0 && (
        <ol className="ritual-questions-list">
          {visible.questions.map((question, index) => (
            <li className="ritual-questions-item" key={question.id}>
              <label className="ritual-questions-label">
                <span className="sr-only">第 {index + 1} 个问题</span>
                <textarea
                  className="ritual-questions-input"
                  rows={2}
                  value={question.text}
                  maxLength={QUESTION_TEXT_LIMIT}
                  disabled={locked}
                  onChange={(event) => handleText(index, event.target.value)}
                />
              </label>
              <div className="ritual-questions-actions">
                <button
                  type="button"
                  className="ritual-button ritual-button--primary"
                  disabled={locked || !canInsert}
                  title={canInsert ? '插入到正文末尾' : insertBlockedReason}
                  onClick={() => onInsert({ ...question, text: question.text.trim() })}
                >
                  插入正文
                </button>
                <button
                  type="button"
                  className="ritual-button"
                  disabled={locked}
                  onClick={() => handleRemove(index)}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {visible.overflow > 0 && (
        <p className="ritual-questions-error" role="alert">
          服务端返回了超过 {TEMPLATE_CAPACITY} 个问题（多出 {visible.overflow} 个），这里只显示当前上限内的部分，
          请先移除多余项再保存。
        </p>
      )}

      {!loading && (
        <div className="ritual-questions-footer">
          <button
            type="button"
            className="ritual-button"
            disabled={locked || current.length >= TEMPLATE_CAPACITY}
            onClick={handleAdd}
          >
            添加问题
          </button>
          {dirty && (
            <button
              type="button"
              className="ritual-button ritual-button--primary"
              disabled={locked}
              onClick={handleSave}
            >
              保存模板
            </button>
          )}
          {dirty && (
            <button type="button" className="ritual-button" disabled={locked}
              onClick={() => { setEdited(null); setLocalError('') }}>
              放弃修改
            </button>
          )}
        </div>
      )}

      {!canInsert && insertBlockedReason !== undefined && (
        <p className="ritual-questions-note" role="note">{insertBlockedReason}</p>
      )}
      {insertError !== undefined && insertError !== '' && (
        <p className="ritual-questions-error" role="alert">{insertError}</p>
      )}
      {localError !== '' && <p className="ritual-questions-error" role="alert">{localError}</p>}
      {error !== undefined && error !== '' && (
        <div className="ritual-questions-error" role="alert">
          <p>{error}</p>
          <p className="ritual-questions-note">本地编辑已保留；重新读取会用服务器版本覆盖这里的未保存修改。</p>
          <button type="button" className="ritual-button" disabled={locked} onClick={onReload}>
            重新读取模板
          </button>
        </div>
      )}
    </section>
  )
}

export default RitualQuestions

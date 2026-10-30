/**
 * 对照与手动复制（S04-T10）。
 *
 * 产品边界（`docs/stage4.md` §6、`docs/stage4-api.md` §5）：
 * - 旧版本在左侧**只读**，当前文件在右侧**可编辑**（右侧由页面传入，保持同一个编辑器实例）；
 * - 用户手动选择要复制的内容，没有自动 diff、没有智能取舍、没有自动合并；
 * - 取消不写入任何数据；复制与替换都由服务端按真实来源构造新内容；
 * - 完整替换会把当前有效文件移入回收箱，再恢复旧文件的 ID，必须二次确认。
 *
 * 组件只收集「选择 + 插入位置」并转交页面；不自己发请求、不自己改正文。
 */

import { useMemo, useState, type ReactNode } from 'react'
import type { ContentDocument } from '../types/document'
import type { RitualKind, RitualSelection } from '../types/ritual'
import RichTextEditor, { type EditorSelectionInfo } from '../editor/RichTextEditor'
import {
  KIND_LABEL,
  copyCandidates,
  type RitualFileRef,
  displayTitle,
  insertPositions,
  previewText,
  userText,
} from '../utils/ritualView'
import './RitualRestoreCompare.css'

export interface RitualRestoreCompareProps {
  kind: RitualKind
  journalDate: string
  /** 回收箱里的旧版本：只读对照对象，身份与版本都要原样提交。 */
  source: RitualFileRef
  /** 当前有效文件：替换时的目标与 CAS 版本来源。 */
  target: RitualFileRef
  /** 主编辑区当前草稿；插入位置必须来自它（保存后与服务端一致）。 */
  targetDraft: ContentDocument | null
  disabled?: boolean
  /** 上一次复制/替换失败的原因（含 CAS 冲突）。 */
  error?: string
  /** 409 后重读到的服务器版本：只展示，不覆盖本地草稿。 */
  serverTarget?: RitualFileRef | null
  onCancel: () => void
  onReplace: (sourceRevision: number) => void
  onCopy: (selection: RitualSelection[], insertAfterNodeId: string) => void
  onReload: () => void
  /** 右侧主编辑区。 */
  right: ReactNode
}

function formatSelection(selection: RitualSelection, label: string): string {
  if (selection.from === undefined || selection.to === undefined) return `${label} · 整块`
  return `${label} · 第 ${selection.from}–${selection.to} 个字`
}

function RitualRestoreCompare({
  kind,
  journalDate,
  source,
  target,
  targetDraft,
  disabled = false,
  error,
  serverTarget,
  onCancel,
  onReplace,
  onCopy,
  onReload,
  right,
}: RitualRestoreCompareProps) {
  const [selection, setSelection] = useState<RitualSelection[]>([])
  const [selectionInfo, setSelectionInfo] = useState<EditorSelectionInfo | null>(null)
  const [insertAfter, setInsertAfter] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [localError, setLocalError] = useState('')

  const candidates = useMemo(() => copyCandidates(source.content_doc), [source.content_doc])
  const positions = useMemo(() => insertPositions(targetDraft), [targetDraft])
  const selectedIds = new Set(selection.map((item) => item.node_id))
  const effectiveInsertAfter = insertAfter !== '' && positions.some((item) => item.nodeId === insertAfter)
    ? insertAfter
    : (positions.length === 0 ? '' : positions[positions.length - 1].nodeId)

  function toggleWhole(nodeId: string) {
    setLocalError('')
    setSelection((current) => current.some((item) => item.node_id === nodeId)
      ? current.filter((item) => item.node_id !== nodeId)
      : [...current, { node_id: nodeId }])
  }

  function addRange() {
    if (selectionInfo === null || selectionInfo.blockId === null || selectionInfo.empty) {
      setLocalError('先在左侧选中一段文字，再点「加入所选范围」。')
      return
    }
    const blockId = selectionInfo.blockId
    const from = selectionInfo.start
    const to = selectionInfo.end
    if (selection.some((item) => item.node_id === blockId)) {
      setLocalError('这个块已经在复制清单里了。')
      return
    }
    setLocalError('')
    setSelection((current) => [...current, { node_id: blockId, from, to }])
  }

  function handleCopy() {
    if (selection.length === 0) {
      setLocalError('请先选择要复制的内容。')
      return
    }
    if (effectiveInsertAfter === '') {
      setLocalError('当前正文没有可用的插入位置，请先在右侧写下至少一段内容并保存。')
      return
    }
    onCopy(selection, effectiveInsertAfter)
  }

  const sourceTitle = displayTitle(kind, journalDate, source.title)

  return (
    <section className="ritual-compare" aria-labelledby="ritual-compare-title">
      <header className="ritual-compare-head">
        <div>
          <h3 id="ritual-compare-title">对照恢复 · {KIND_LABEL[kind]} {journalDate}</h3>
          <p className="ritual-compare-sub">
            左侧是回收箱里的旧版本（只读），右侧是当前文件（可编辑）。没有自动合并，取消不写入。
          </p>
        </div>
        <button type="button" className="ritual-button" disabled={disabled} onClick={onCancel}>
          取消对照
        </button>
      </header>

      <div className="ritual-compare-grid">
        <div className="ritual-compare-source">
          <div className="ritual-compare-identity">
            <p className="ritual-compare-label">旧版本（回收箱）</p>
            <p className="ritual-compare-title">{sourceTitle}</p>
            <p className="ritual-compare-meta">#{source.id} · revision {source.revision}</p>
          </div>

          <div className="ritual-compare-editor" aria-label="旧版本正文（只读）">
            <RichTextEditor doc={source.content_doc ?? null} readOnly label="旧版本正文（只读）"
              onSelection={setSelectionInfo} />
          </div>

          <div className="ritual-compare-picker">
            <div className="ritual-compare-picker-head">
              <p className="ritual-compare-label">选择要复制的内容</p>
              <button type="button" className="ritual-button" disabled={disabled} onClick={addRange}>
                加入所选范围
              </button>
            </div>
            <p className="ritual-compare-hint">
              在左侧选中一段文字可只复制该段；也可以直接勾选整块。带评论或 AI 占位的块不能复制。
            </p>
            <ul className="ritual-compare-blocks">
              {candidates.length === 0 && <li className="ritual-compare-empty">这个旧版本没有可复制的块。</li>}
              {candidates.map((candidate) => (
                <li key={candidate.nodeId} className="ritual-compare-block">
                  <label className="ritual-compare-check">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(candidate.nodeId)}
                      disabled={disabled || candidate.blockedReason !== null}
                      onChange={() => toggleWhole(candidate.nodeId)}
                    />
                    <span className="ritual-compare-block-text">
                      <span className="ritual-compare-block-label">{candidate.label}</span>
                      {candidate.preview !== '' && <span className="ritual-compare-block-preview">{candidate.preview}</span>}
                      {candidate.blockedReason !== null && (
                        <span className="ritual-compare-block-blocked">{candidate.blockedReason}</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="ritual-compare-target">
          <div className="ritual-compare-identity">
            <p className="ritual-compare-label">当前文件（可编辑）</p>
            <p className="ritual-compare-meta">#{target.id} · revision {target.revision}</p>
          </div>
          {right}
        </div>
      </div>

      <div className="ritual-compare-actions">
        <div className="ritual-compare-selection" aria-live="polite">
          <p className="ritual-compare-label">复制清单（{selection.length}）</p>
          {selection.length === 0
            ? <p className="ritual-compare-hint">还没有选择内容。</p>
            : (
              <ul className="ritual-compare-chips">
                {selection.map((item) => {
                  const label = candidates.find((candidate) => candidate.nodeId === item.node_id)?.label ?? '块'
                  return (
                    <li key={item.node_id} className="ritual-compare-chip">
                      <span>{formatSelection(item, label)}</span>
                      <button type="button" className="ritual-compare-chip-remove" disabled={disabled}
                        aria-label={`移除 ${label}`}
                        onClick={() => setSelection((current) => current.filter((entry) => entry.node_id !== item.node_id))}>
                        移除
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
        </div>

        <label className="ritual-compare-insert">
          <span>插入到哪一块之后</span>
          <select
            value={effectiveInsertAfter}
            disabled={disabled || positions.length === 0}
            onChange={(event) => setInsertAfter(event.target.value)}
          >
            {positions.length === 0 && <option value="">（暂无可插入位置）</option>}
            {positions.map((position) => (
              <option key={position.nodeId} value={position.nodeId}>
                {position.label}{position.preview === '' ? '' : `：${previewText(position.preview, 24)}`}
              </option>
            ))}
          </select>
        </label>

        <div className="ritual-compare-buttons">
          <button type="button" className="ritual-button ritual-button--primary" disabled={disabled}
            onClick={handleCopy}>
            复制所选内容
          </button>
          <button type="button" className="ritual-button ritual-button--danger" disabled={disabled}
            onClick={() => { setConfirming(true); setLocalError('') }}>
            完整替换…
          </button>
        </div>
      </div>

      {confirming && (
        <div className="ritual-compare-confirm" role="alertdialog" aria-labelledby="ritual-replace-title">
          <h4 id="ritual-replace-title">确认完整替换？</h4>
          <p>
            会先把当前文件 #{target.id}（revision {target.revision}）移入回收箱，
            再把旧版本 #{source.id}（revision {source.revision}）恢复为有效的{KIND_LABEL[kind]}。
            原有关联不会自动重建；结束今天的回顾快照与回答在各自文件里保留。
          </p>
          <div className="ritual-compare-buttons">
            <button type="button" className="ritual-button ritual-button--danger" disabled={disabled}
              onClick={() => { setConfirming(false); onReplace(source.revision) }}>
              确认替换
            </button>
            <button type="button" className="ritual-button" disabled={disabled} onClick={() => setConfirming(false)}>
              不替换
            </button>
          </div>
        </div>
      )}

      {serverTarget !== null && serverTarget !== undefined && (
        <div className="ritual-compare-conflict" role="status">
          <p>服务器上的当前文件已变成 revision {serverTarget.revision}，本地草稿没有被覆盖。</p>
          {serverTarget.content_doc !== null && serverTarget.content_doc !== undefined && (
            <p className="ritual-compare-hint">
              服务器正文预览：{previewText(userText(serverTarget.content_doc), 80) || '（空）'}
            </p>
          )}
          <p className="ritual-compare-hint">
            可以继续查看本地草稿后重新选择；再次复制或替换会使用最新版本重新提交。
          </p>
          <button type="button" className="ritual-button" disabled={disabled} onClick={onReload}>
            重新读取双方版本
          </button>
        </div>
      )}

      {(localError !== '' || (error !== undefined && error !== '')) && (
        <p className="ritual-compare-error" role="alert">{localError !== '' ? localError : error}</p>
      )}
    </section>
  )
}

export default RitualRestoreCompare

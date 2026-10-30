import { useEffect, useState } from 'react'
import { listFolders } from '../api/folders'
import type { Folder } from '../types/folder'
import { folderIdToSelectValue, selectValueToFolderId } from '../utils/folderSelect'

interface FolderSelectProps {
  value: number | null
  disabled?: boolean
  onChange: (folderId: number | null) => void
}

/** 三类文件共用的 Folder 选择器；空串即「无 Folder」，保存时显式提交 null。 */
function FolderSelect({ value, disabled = false, onChange }: FolderSelectProps) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    listFolders(controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFolders(data)
      setStatus('success')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : '请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [reloadToken])

  const currentMissing = value !== null && !folders.some((folder) => folder.id === value)
  return (
    <>
      <label className="editor-field"><span>Folder</span>
        <select aria-label="Folder" value={folderIdToSelectValue(value)} disabled={disabled || status !== 'success'}
          onChange={(event) => onChange(selectValueToFolderId(event.target.value))}>
          <option value="">无 Folder</option>
          {currentMissing && <option value={value}>当前 Folder（ID {value}）</option>}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
        </select>
      </label>
      {status === 'loading' && <p className="detail-hint" role="status">正在加载 Folder 列表，当前选择已保留。</p>}
      {status === 'error' && (
        <div className="detail-error" role="alert">
          <p>Folder 列表加载失败：{error}。当前选择和输入已保留。</p>
          <button type="button" disabled={disabled} onClick={() => {
            setStatus('loading')
            setError('')
            setReloadToken((token) => token + 1)
          }}>重试 Folder 列表</button>
        </div>
      )}
    </>
  )
}

export default FolderSelect

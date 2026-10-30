import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  FolderApiError,
  createFolder,
  deleteFolder,
  listFolderFiles,
  listFolders,
  updateFolder,
} from '../api/folders'
import FileCard from '../components/FileCard'
import Pagination from '../components/Pagination'
import type { Folder } from '../types/folder'
import type { ContentFile, FileIdentity, FilePage } from '../types/file'
import { nearestValidPage } from '../utils/pagination'

interface FolderPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onNavigate: (action: () => void) => void
  /** 混合卡片按 (type, id) 打开真实详情；导航由 App 统一做离开检查。 */
  onOpenFile: (file: FileIdentity) => void
}

const FOLDER_IN_USE_MESSAGE =
  '删除被拒绝：仍有文件引用该 Folder（可能包含回收箱中的记录），不能删除。'

/**
 * Folder 页面（Stage 2 / S2-T08）。
 *
 * - Folder 列表是数组契约（id ASC）；内容列表统一 20 条分页；
 * - 创建/改名/删除都是本地小表单，写失败保留输入；
 * - 删除 409 明确说明仍有引用（可能含回收箱记录），不做 UI 假删；
 * - 文件移入/移出只在各文件编辑表单里保存（无移动接口），
 *   返回本页时组件按 App 的模块切换重新挂载并整体刷新。
 */
function FolderPage({ onDirtyChange, onBusyChange, onNavigate, onOpenFile }: FolderPageProps) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [foldersStatus, setFoldersStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [foldersError, setFoldersError] = useState('')
  const [foldersRevision, setFoldersRevision] = useState(0)

  const [newName, setNewName] = useState('')
  const [createStage, setCreateStage] = useState<'idle' | 'saving'>('idle')
  const [createError, setCreateError] = useState('')

  const [renameId, setRenameId] = useState<number | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameError, setRenameError] = useState('')

  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleteStage, setDeleteStage] = useState<'idle' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')

  const [notice, setNotice] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [filesPage, setFilesPage] = useState(1)
  const [filesResult, setFilesResult] = useState<FilePage<ContentFile> | null>(null)
  const [filesStatus, setFilesStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [filesError, setFilesError] = useState('')
  const [filesRevision, setFilesRevision] = useState(0)

  const writing = useRef(false)
  const busy = createStage === 'saving' || deleteStage === 'deleting'

  function setWriting(value: boolean) {
    writing.current = value
    onBusyChange(value)
    onDirtyChange(false)
  }

  useEffect(() => {
    const controller = new AbortController()
    listFolders(controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFolders(data)
      setFoldersStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setFoldersError(error instanceof Error ? error.message : '加载失败，请稍后重试')
      setFoldersStatus('error')
    })
    return () => controller.abort()
  }, [foldersRevision])

  // 内容列表：条件（所选 Folder）变化回第一页；越界回最近有效页。
  // 未选择 Folder 时不发请求；切换选择时事件处理里已清空旧结果。
  useEffect(() => {
    if (selectedId === null) return
    const controller = new AbortController()
    listFolderFiles(selectedId, filesPage, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setFilesPage(validPage)
        return
      }
      setFilesResult(data)
      setFilesStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setFilesResult(null)
      setFilesError(error instanceof Error ? error.message : '加载失败，请稍后重试')
      setFilesStatus('error')
    })
    return () => controller.abort()
  }, [selectedId, filesPage, filesRevision])

  function beginFoldersLoading() {
    setFoldersStatus('loading')
    setFoldersError('')
    setFolders([])
  }
  function refreshFolders() {
    beginFoldersLoading()
    setFoldersRevision((value) => value + 1)
  }
  function beginFilesLoading() {
    setFilesStatus('loading')
    setFilesError('')
    setFilesResult(null)
  }
  function refreshFiles() {
    beginFilesLoading()
    setFilesRevision((value) => value + 1)
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writing.current) return
    if (newName.trim() === '') {
      setCreateError('名称不能为空，也不能只包含空白字符。')
      return
    }
    setWriting(true)
    setCreateStage('saving')
    setCreateError('')
    try {
      const created = await createFolder(newName)
      // 写成功才清空输入；随后的列表刷新失败在列表区单独反馈。
      setNewName('')
      setNotice(`已创建 Folder「${created.name}」。`)
      refreshFolders()
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : '创建失败，请稍后重试')
    } finally {
      setCreateStage('idle')
      setWriting(false)
    }
  }

  function startRename(folder: Folder) {
    setRenameId(folder.id)
    setRenameName(folder.name)
    setRenameError('')
    setDeleteId(null)
    setDeleteError('')
    setNotice('')
  }
  function cancelRename() {
    setRenameId(null)
    setRenameName('')
    setRenameError('')
  }
  async function submitRename(folderId: number) {
    if (writing.current) return
    const trimmed = renameName.trim()
    const original = folders.find((folder) => folder.id === folderId)
    if (original !== undefined && trimmed === original.name) {
      // 名称未变化：不发送 PATCH，直接收起。
      cancelRename()
      return
    }
    if (trimmed === '') {
      setRenameError('名称不能为空，也不能只包含空白字符。')
      return
    }
    setWriting(true)
    setRenameError('')
    try {
      const updated = await updateFolder(folderId, { name: renameName })
      setNotice(`已改名：「${updated.name}」。`)
      cancelRename()
      refreshFolders()
    } catch (error: unknown) {
      // 写失败保留输入，方便修正后重试。
      setRenameError(error instanceof Error ? error.message : '改名失败，请稍后重试')
    } finally {
      setWriting(false)
    }
  }

  function startDelete(folder: Folder) {
    setDeleteId(folder.id)
    setDeleteError('')
    setRenameId(null)
    setRenameName('')
    setNotice('')
  }
  function cancelDelete() {
    setDeleteId(null)
    setDeleteError('')
  }
  async function confirmDelete(folderId: number) {
    if (writing.current) return
    setWriting(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      await deleteFolder(folderId)
      setDeleteId(null)
      setNotice('已删除空 Folder。')
      if (selectedId === folderId) {
        // 当前正在查看的 Folder 已删除：清空选择与内容列表。
        setSelectedId(null)
        setFilesResult(null)
        setFilesStatus('loading')
      }
      refreshFolders()
    } catch (error: unknown) {
      setDeleteStage('idle')
      setDeleteId(null)
      if (error instanceof FolderApiError && error.status === 409) {
        setNotice('')
        setDeleteError(FOLDER_IN_USE_MESSAGE)
      } else {
        setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
      }
    } finally {
      setDeleteStage('idle')
      setWriting(false)
    }
  }

  function selectFolder(folderId: number) {
    if (folderId === selectedId) return
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setDeleteError('')
      setSelectedId(folderId)
      setFilesPage(1) // 条件变化回第一页
      beginFilesLoading()
    })
  }
  function changeFilesPage(value: number) {
    onNavigate(() => {
      setNotice('')
      setFilesPage(value)
      beginFilesLoading()
    })
  }

  return (
    <section className="folder-page" aria-label="Folder 模块">
      <section className="app-toolbar" aria-label="Folder 工具">
        <form className="folder-create" onSubmit={submitCreate}>
          <label className="app-filter">
            <span>新建 Folder</span>
            <input type="text" value={newName} disabled={busy} maxLength={80}
              onChange={(event) => {
                setNewName(event.target.value)
                setCreateError('')
              }} />
          </label>
          <button type="submit" disabled={busy}>{createStage === 'saving' ? '创建中……' : '创建'}</button>
        </form>
      </section>

      {notice && <p className="detail-success" role="status">{notice}</p>}
      {createError && (
        <p className="detail-error" role="alert">创建失败：{createError}（输入已保留，可修改后再次创建。）</p>
      )}

      <div className="folder-layout">
        <section className="folder-list" aria-label="Folder 列表">
          <h2 className="folder-section-title">Folder（{folders.length}）</h2>
          {foldersStatus === 'loading' && <p className="app-state" role="status">加载中……</p>}
          {foldersStatus === 'error' && (
            <div className="app-state app-state-error" role="alert">
              <p>Folder 列表加载失败：{foldersError}</p>
              <button type="button" onClick={refreshFolders} disabled={busy}>重试</button>
            </div>
          )}
          {foldersStatus === 'success' && folders.length === 0 && (
            <p className="app-state">还没有任何 Folder，先创建一个。</p>
          )}
          {foldersStatus === 'success' && folders.length > 0 && (
            <ul className="folder-items">
              {folders.map((folder) => (
                <li key={folder.id} className={folder.id === selectedId ? 'folder-item selected' : 'folder-item'}>
                  {renameId === folder.id ? (
                    <div className="folder-rename">
                      <input type="text" value={renameName} disabled={busy} maxLength={80} autoFocus
                        onChange={(event) => {
                          setRenameName(event.target.value)
                          setRenameError('')
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void submitRename(folder.id)
                          }
                        }} />
                      <div className="detail-confirm-actions">
                        <button type="button" disabled={busy} onClick={() => void submitRename(folder.id)}>
                          {busy ? '保存中……' : '保存'}
                        </button>
                        <button type="button" disabled={busy} onClick={cancelRename}>取消</button>
                      </div>
                      {renameError && (
                        <p className="detail-error" role="alert">改名失败：{renameError}（输入已保留。）</p>
                      )}
                    </div>
                  ) : (
                    <div className="folder-row">
                      <button type="button" className="folder-open" disabled={busy}
                        aria-current={folder.id === selectedId ? 'true' : undefined}
                        onClick={() => selectFolder(folder.id)}>{folder.name}</button>
                      <span className="folder-row-actions">
                        <button type="button" disabled={busy} onClick={() => startRename(folder)}>改名</button>
                        {deleteId === folder.id ? (
                          <span className="folder-delete-confirm">
                            <button type="button" className="detail-danger" disabled={busy}
                              onClick={() => void confirmDelete(folder.id)}>
                              {deleteStage === 'deleting' ? '删除中……' : '确认删除'}
                            </button>
                            <button type="button" disabled={busy} onClick={cancelDelete}>取消</button>
                          </span>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => startDelete(folder)}>删除</button>
                        )}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {deleteError && <p className="detail-error" role="alert">{deleteError}</p>}
        </section>

        <section className="folder-content" aria-label="Folder 内容">
          <h2 className="folder-section-title">内容</h2>
          {selectedId === null && <p className="app-state">从左侧选择一个 Folder 查看其中的文件。</p>}
          {selectedId !== null && filesStatus === 'loading' && <p className="app-state" role="status">加载中……</p>}
          {selectedId !== null && filesStatus === 'error' && (
            <div className="app-state app-state-error" role="alert">
              <p>内容加载失败：{filesError}</p>
              <button type="button" onClick={refreshFiles} disabled={busy}>重试</button>
            </div>
          )}
          {selectedId !== null && filesStatus === 'success' && filesResult && (
            <>
              {filesResult.items.length === 0
                ? <p className="app-state">该 Folder 暂无有效文件（含回收箱中的记录也不会显示在这里）。</p>
                : (
                  <ul className="journal-list">
                    {filesResult.items.map((file) => (
                      <li key={`${file.type}:${file.id}`}>
                        <FileCard file={file} onOpen={(target) => onOpenFile(target)}
                          selected={false} disabled={busy} />
                      </li>
                    ))}
                  </ul>
                )}
              <Pagination page={filesResult.page} total={filesResult.total} hasNext={filesResult.has_next}
                onPageChange={changeFilesPage} disabled={busy} label="Folder 内容分页" />
            </>
          )}
        </section>
      </div>
    </section>
  )
}

export default FolderPage

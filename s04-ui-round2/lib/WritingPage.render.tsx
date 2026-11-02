  const dayLabel = businessDate === '' ? '──-──-──' : businessDate.slice(2)
  /** 需要始终可被发现的状态：保存失败 / 冲突 / 本地草稿写不进去。 */
  const statusCritical = display === 'failed' || display === 'conflict' || display === 'missing'
    || session?.localState === 'failed'

  return (
    <section
      className={`writing-page sj-write${chrome.hidden ? ' is-immersed' : ''}`}
      aria-label="速记"
      onPointerMove={chrome.reveal}
      onKeyDown={chrome.onKeyDown}
    >
      <header className="sj-write__bar" onFocusIn={chrome.hold} onFocusOut={chrome.release}>
        <div className="sj-write__ident">
          {onBack !== undefined && (
            <button type="button" className="sj-write__ghost sj-write__back" onClick={onBack} aria-label="返回概览">
              ← 概览
            </button>
          )}
          <time className="sj-write__date" dateTime={businessDate === '' ? undefined : businessDate}>{dayLabel}</time>
        </div>
        <div className="sj-write__tools">
          <button type="button" className="sj-write__ghost" aria-expanded={listOpen}
            onClick={() => setListOpen((open) => !open)}>
            今天 {today.total} 篇
          </button>
          <button type="button" className="sj-write__ghost" aria-expanded={aiOpen}
            disabled={session === null} onClick={() => setAiOpen((open) => !open)}>
            AI 写作
          </button>
          <button type="button" className="sj-write__ghost" aria-expanded={recoveryOpen} onClick={() => {
            setRecoveryOpen((open) => !open)
            void reloadDrafts()
          }}>
            本地草稿（{writingCandidates.length}）
          </button>
          <button type="button" className="sj-write__ghost" aria-expanded={metaOpen}
            disabled={session === null} onClick={() => setMetaOpen((open) => !open)}>
            属性
          </button>
          <button type="button" className="sj-write__save"
            disabled={locked || !dirty || !savable} onClick={() => { void saveNow() }}>
            保存
          </button>
          <button type="button" className="sj-write__ghost"
            disabled={locked || dayStatus !== 'success'} onClick={startNew}>
            新建
          </button>
        </div>
      </header>

      {notice !== '' && <p className="writing-notice" role="status">{notice}</p>}

      {!recoveryOpen && writingCandidates.length > 0 && (
        <div className="writing-recovery-callout" role="status">
          <p>本机还有 {writingCandidates.length} 份未提交的草稿（不含服务器已保存的内容）。</p>
          <p className="writing-hint">可以打开列表选择恢复、稍后处理或明确丢弃；不做选择时不会有任何自动写入。</p>
          <button type="button" onClick={() => { setRecoveryOpen(true); void reloadDrafts() }}>
            查看本地草稿
          </button>
        </div>
      )}

      {recoveryOpen && (
        <LocalDraftPanel
          items={panelItems}
          currentTabId={tabId}
          error={draftError}
          notice={draftNotice}
          disabled={locked}
          onAction={(candidate, action) => { void onDraftAction(candidate, action) }}
          onClose={() => setRecoveryOpen(false)}
          onClearAll={() => { void (async () => {
            const result = await localDraftWriter.clearAll()
            await reloadDrafts()
            setDraftNotice(result.ok ? '已清空本应用的本地草稿。' : result.message)
            setPlans({})
          })() }}
        />
      )}

      {conflict !== null && conflict.kind === 'session' && session !== null && (
        <DraftConflictView
          title="这篇写作的服务器版本已变化"
          localHeading={conflictHeadings(session.revision, conflict.server.revision).local}
          localText={userTextOf(session.draft.content_doc)}
          localMeta={`未提交的本地输入 · 标题「${session.draft.title === '' ? '无' : session.draft.title}」`}
          serverHeading={conflictHeadings(session.revision, conflict.server.revision).server}
          serverText={conflict.server.content}
          serverMeta={`${conflict.server.display_title} · 版本 ${conflict.server.revision}`}
          keepLocalLabel="保留我的草稿并提交"
          takeServerLabel="采用服务器版本"
          busy={busy}
          onKeepLocal={() => { void keepLocalSessionConflict() }}
          onTakeServer={takeServerSessionConflict}
          onLater={() => { setConflict(null); setNotice('已稍后处理；服务器与本地内容都保留。') }}
        />
      )}

      {conflict !== null && conflict.kind === 'record' && (
        <DraftConflictView
          title="本机草稿与服务器版本不一致"
          localHeading={conflictHeadings(conflict.record.base_revision, conflict.server.revision).local}
          localText={localDraftText(conflict.record)}
          localMeta={`本机草稿 · 输入序号 ${conflict.record.input_seq}`}
          serverHeading={conflictHeadings(conflict.record.base_revision, conflict.server.revision).server}
          serverText={conflict.server.content}
          serverMeta={`${conflict.server.display_title} · 版本 ${conflict.server.revision}`}
          keepLocalLabel="保留我的草稿（基于服务器版本）"
          takeServerLabel="采用服务器版本"
          busy={busy}
          onKeepLocal={keepLocalRecordConflict}
          onTakeServer={takeServerRecordConflict}
          onLater={() => { setConflict(null); setDraftNotice('已稍后处理；本地草稿仍保留。') }}
        />
      )}

      <div className={`sj-write__stage${listOpen ? ' has-drawer' : ''}`}>
        {listOpen && (
          <aside className="sj-write__drawer writing-side" aria-label="今天的写作">
            <div className="writing-side-head">
              <h3>今天</h3>
              <p>{listStatus === 'success' ? `共 ${today.total} 篇` : ''}</p>
            </div>
            {listStatus === 'loading' && <p className="writing-state" role="status">正在读取今天的写作……</p>}
            {listStatus === 'error' && (
              <div className="writing-state writing-state-error" role="alert">
                <p>读取今天写作失败：{listError}</p>
                <p className="writing-hint">重试只会重新读取，不会创建或修改任何文件。</p>
                <button type="button" disabled={locked} onClick={() => { setListStatus('loading'); setListError(''); setListToken((value) => value + 1) }}>重新读取</button>
              </div>
            )}
            {listStatus === 'success' && today.items.length === 0 && (
              <p className="writing-state">今天还没有写作。写下第一句就会创建，空白不会产生记录。</p>
            )}
            {listStatus === 'success' && today.items.length > 0 && (
              <ul className="writing-items">
                {today.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`writing-item${selectedFileId === item.id ? ' is-current' : ''}`}
                      aria-current={selectedFileId === item.id ? 'true' : undefined}
                      disabled={locked}
                      onClick={() => { void openExisting(item.id) }}
                    >
                      <span className="writing-item-title">{item.displayTitle}</span>
                      {item.preview !== '' && <span className="writing-item-preview">{item.preview}</span>}
                      <span className="writing-item-meta">
                        版本 {item.revision}
                        {localIds.has(item.id) ? ' · 本机有未提交草稿' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {listStatus === 'success' && today.total > 0 && (
              <Pagination page={today.page} total={today.total} hasNext={today.hasNext}
                onPageChange={(value) => { setListStatus('loading'); setListPage(value); setListToken((token) => token + 1) }}
                disabled={locked} label="今天写作分页" />
            )}
            {today.hasNext && <p className="writing-hint">还有更多写作在下一页。</p>}
            <button type="button" className="sj-write__ghost" onClick={() => setListOpen(false)}>收起</button>
          </aside>
        )}

        <div className="sj-write__paper">
          {dayStatus === 'loading' && <p className="writing-state" role="status">正在读取业务日期……</p>}
          {dayStatus === 'error' && (
            <div className="writing-state writing-state-error" role="alert">
              <p>{dayError}</p>
              <p className="writing-hint">业务日期由服务端按固定时区计算；读取失败时不会用本机时钟猜一个日期，也不会创建草稿。</p>
              <button type="button" onClick={() => { setDayStatus('loading'); setDayError(''); setDayToken((value) => value + 1) }}>重新读取</button>
            </div>
          )}

          {legacy !== null && (
            <section className="writing-legacy" aria-label="旧格式记录">
              <h3>这篇仍是旧格式</h3>
              <p>
                它带有旧的正文块或还没有 JSON 正文。为了不改变作者身份和检查点，
                这里不自动转换、也不删除原文；可以继续用旧编辑器打开。
              </p>
              <div className="writing-legacy-actions">
                {onOpenLegacy !== undefined && (
                  <button type="button" className="writing-primary" onClick={() => onOpenLegacy(legacy.id)}>
                    用旧编辑器打开
                  </button>
                )}
                <button type="button" onClick={() => setLegacy(null)}>回到今天的草稿</button>
              </div>
            </section>
          )}

          {legacy === null && dayStatus === 'success' && session === null && (
            <p className="writing-state" role="status">正在准备草稿……</p>
          )}

          {legacy === null && session !== null && (
            <>
              {metaOpen && (
                <div className="sj-write__meta" role="group" aria-label="日期与文件夹">
                  <label className="sj-write__metafield">
                    <span>日期</span>
                    <input
                      type="date"
                      value={session.draft.date}
                      disabled={locked}
                      onChange={(event) => change({ ...session.draft, date: event.target.value })}
                    />
                  </label>
                  <FolderSelect value={session.draft.folder_id} disabled={locked}
                    onChange={(folderId) => change({ ...session.draft, folder_id: folderId })} />
                </div>
              )}

              <input
                className="sj-write__title"
                type="text"
                aria-label="标题（可留空）"
                placeholder="标题（可留空）"
                value={session.draft.title}
                disabled={locked}
                onChange={(event) => change({ ...session.draft, title: event.target.value })}
              />

              <div
                className="sj-write__body"
                onCompositionStart={() => { if (sessionId !== null) store.setComposing(sessionId, true) }}
                onCompositionEnd={() => { if (sessionId !== null) store.setComposing(sessionId, false) }}
              >
                <RichTextEditor
                  doc={session.draft.content_doc as ContentDocument | null}
                  // 视图只读只跟外部写锁；本页显式动作（保存/新建）走 `locked`，
                  // 避免保存状态变化重建编辑器、丢掉光标与正在进行的组合。
                  readOnly={disabled}
                  locked={busy}
                  chromeHidden={chrome.hidden}
                  label="速记正文"
                  onUserChange={(document) => change({ ...session.draft, content_doc: document })}
                  onSelection={onEditorSelection}
                />
              </div>

              {/*
                状态行永远不淡出：保存失败、版本冲突、本地草稿写不进去时必须能被发现。
                正常状态下它只是很小的一行灰字。
              */}
              <div className={`sj-write__status${statusCritical ? ' is-critical' : ''}`} role="status" aria-live="polite">
                <span className="sj-write__status-label">
                  {session.fileId === null && (display === 'saved' || display === 'unsaved')
                    ? '还没有保存到服务器'
                    : statusLabel(display ?? 'saved')}
                </span>
                <span className="sj-write__status-hint">
                  {statusCritical
                    ? session.error
                    : session.fileId === null
                      ? '写下正文后自动创建；空白草稿不会产生服务器记录。'
                      : `文件 #${session.fileId} · 版本 ${session.revision ?? 0}`}
                </span>
                <span className="sj-write__status-local">{localStateLabel(session.localState)}</span>
                {display === 'failed' && (
                  <button type="button" className="sj-write__ghost" disabled={locked} onClick={() => { void store.retry(sessionId as string) }}>重试保存</button>
                )}
                {display === 'conflict' && session.fileId !== null && (
                  <button type="button" className="sj-write__ghost" disabled={locked}
                    onClick={() => { void loadServerForSessionConflict(session.fileId as number) }}>
                    对照服务器版本
                  </button>
                )}
                {display === 'missing' && (
                  <button type="button" className="sj-write__ghost" disabled={locked} onClick={() => {
                    const record = records.find((item) => item.file_id === session.fileId)
                    if (record !== undefined) openAsNewDraft(record)
                    else setNotice('服务器上已没有这篇；本地输入仍在编辑器里，可以复制到新草稿。')
                  }}>另存为新草稿</button>
                )}
              </div>

              {tooLong && (
                <p className="writing-hint" role="alert">
                  正文超过 50,000 个字符（按 Unicode 码点），暂不提交；内容仍保留在编辑器里。
                </p>
              )}
              {!savable && !tooLong && (
                <p className="sj-write__quiet" role="status">空白正文不会提交，也不会创建空记录。</p>
              )}

              {/*
                AI 写作面板：只在需要时展开，但始终挂载——在途请求与结果不因收起而丢。
                这里不传 `locked`（含本页 busy），只有页面级写锁 `disabled` 会禁用入口。
              */}
              <div className={`sj-write__ai${aiOpen ? '' : ' is-collapsed'}`} aria-hidden={!aiOpen}>
                <WritingAiPanel
                  sessionId={sessionId}
                  fileId={session.fileId}
                  userText={draftUserText}
                  editorDocument={session.draft.content_doc}
                  saved={display === 'saved'}
                  userInputSeq={session.userInputSeq}
                  composing={session.imeComposing}
                  settings={aiSettings}
                  selection={aiSelection}
                  disabled={disabled}
                  store={store}
                  onNotice={setNotice}
                  onReloadSettings={() => setAiSettingsToken((value) => value + 1)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** 标题区的业务日期显示（与列表同一口径）。 */
export default WritingPage

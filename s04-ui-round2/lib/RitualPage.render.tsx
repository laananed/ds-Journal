  const dayLabel = effectiveDate === '' ? '──-──-──' : effectiveDate.slice(2)
  /** 保存失败/冲突/本地草稿写不进去：这些信息永远不淡出。 */
  const statusCritical = sessionStatus === 'failed' || sessionStatus === 'conflict'
    || sessionStatus === 'missing' || mirror.localState === 'failed' || saveHint !== ''

  return (
    <div
      className={`ritual-page sj-ritual${chrome.hidden ? ' is-immersed' : ''}${contextOpen ? ' has-context' : ''}`}
      onPointerMove={chrome.reveal}
      onKeyDown={chrome.onKeyDown}
    >
      <header className="sj-ritual__bar" onFocus={chrome.hold} onBlur={chrome.release}>
        <div className="sj-ritual__ident">
          {onBack !== undefined && (
            <button type="button" className="sj-ritual__ghost" onClick={onBack} aria-label="返回概览">
              ← 概览
            </button>
          )}
          <time className="sj-ritual__date" dateTime={effectiveDate === '' ? undefined : effectiveDate}>{dayLabel}</time>
          <span className="sj-ritual__kind">{KIND_LABEL[kind]}</span>
        </div>
        <div className="sj-ritual__tools">
          <button type="button" className="sj-ritual__ghost" aria-expanded={contextOpen}
            onClick={() => setContextOpen((open) => !open)}>
            问题模板与目标
          </button>
        </div>
      </header>

      {draftNotice !== '' && <p className="ritual-notice" role="status">{draftNotice}</p>}

      {ritualCandidates.length > 0 && !recoveryOpen && (
        <div className="ritual-recovery-callout" role="status">
          <p>本机还有 {ritualCandidates.length} 份未提交的草稿（只保存在这台浏览器，不代表服务器已保存）。</p>
          <p className="ritual-hint">可以打开列表选择恢复、稍后处理或明确丢弃；不做选择时不会有任何自动写入。</p>
          <button type="button" className="ritual-button" onClick={openRecoveryPanel}>
            查看本地草稿
          </button>
        </div>
      )}

      {recoveryOpen && (
        <LocalDraftPanel
          items={panelItems}
          currentTabId={tabId}
          error={draftError}
          notice=""
          disabled={disabled || busy}
          onAction={(candidate, action) => { void onDraftAction(candidate, action) }}
          onClose={() => setRecoveryOpen(false)}
          onClearAll={() => { void (async () => {
            const cleared = await localDraftWriter.clearAll()
            await reloadDrafts()
            setDraftPlans({})
            setDraftNotice(cleared.ok ? '已清空本应用存在这台浏览器上的草稿。' : cleared.message)
          })() }}
        />
      )}

      {draftConflict !== null && (
        <DraftConflictView
          title={`这份${KIND_LABEL[kind]}的本机草稿与服务器版本不一致`}
          localHeading={conflictHeadings(draftConflict.record.base_revision, draftConflict.server.revision).local}
          localText={localDraftText(draftConflict.record)}
          localMeta={`本机草稿 · 输入序号 ${draftConflict.record.input_seq}`}
          serverHeading={conflictHeadings(draftConflict.record.base_revision, draftConflict.server.revision).server}
          serverText={draftConflict.server.content}
          serverMeta={`${draftConflict.server.display_title} · 版本 ${draftConflict.server.revision}`}
          keepLocalLabel="保留我的草稿（基于服务器版本）"
          takeServerLabel="采用服务器版本"
          busy={draftBusyKeys.length > 0}
          onKeepLocal={() => putRecordInEditor(draftConflict.record, draftConflict.server)}
          onTakeServer={takeServerForRecordConflict}
          onLater={() => { setDraftConflict(null); setDraftNotice('已稍后处理；服务器与本机内容都保留。') }}
        />
      )}

      {status === 'loading' && <p className="ritual-state" role="status">正在读取今天的记录……</p>}

      {status === 'error' && (
        <div className="ritual-state ritual-state--error" role="alert">
          <p>{loadError}</p>
          <p className="ritual-hint">这里只读取数据，重试不会创建任何文件。</p>
          <button type="button" className="ritual-button" onClick={() => void load()}>重新读取</button>
        </div>
      )}

      {status === 'ready' && (
        <div className={`sj-ritual__stage${compareSource !== null ? ' is-compare' : ''}`}>
          {contextOpen && (
            <aside className="ritual-context sj-ritual__context" aria-label={`${KIND_LABEL[kind]} 上下文`}>
              <RitualQuestions
                kind={kind}
                journalDate={effectiveDate}
                questions={currentTemplate.questions}
                revision={currentTemplate.revision}
                loading={templatesLoading}
                disabled={disabled || busy}
                error={templateError}
                canInsert={sessionId !== null}
                insertBlockedReason="请先写入并保存正文。"
                onSave={(questions) => void saveTemplate(questions)}
                onReload={() => void reloadTemplates()}
                onInsert={(question) => void insertTemplateQuestion(question)}
                insertError={insertError}
              />

              <section className="ritual-goals" aria-labelledby="ritual-goals-title">
                <h3 id="ritual-goals-title">{kind === 'set' ? '今天的目标' : '目标回顾'}</h3>
                {kind === 'set' && checklistCandidates(document).map((item) => (
                  <div key={item.id} className="ritual-goal-item">
                    <span>{item.text}</span>{' '}
                    <button type="button" disabled={disabled || busy} onClick={() => void convertGoal(item.id)}>转为目标</button>
                  </div>
                ))}
                {kind === 'set' && goals.length === 0 && (
                  <p className="ritual-hint">
                    保存后，正文中的纯文字清单会自动成为目标；含格式或嵌套的条目需先调整。
                  </p>
                )}
                {kind === 'set' && goals.length > 0 && (
                  <ul className="ritual-goal-list">
                    {goals.map((goal) => (
                      <li key={goal.goalId} className="ritual-goal-item">
                        <label className="ritual-goal-check">
                          <input type="checkbox" checked={goal.checked} disabled={disabled || goalBusy !== ''}
                            onChange={(event) => void toggleGoal(goal, event.target.checked)} />
                          <span>{goal.text}</span>
                        </label>
                        <button type="button" className="ritual-button"
                          disabled={disabled || goalBusy !== '' || !addToEnd.available}
                          title={addToEnd.available ? undefined : addToEnd.reason}
                          onClick={() => void addGoalToEnd(goal)}>
                          加入结束今天
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {kind === 'end' && reviews.length === 0 && (
                  <p className="ritual-hint">还没有关联的目标回顾。目标需要在开始今天里主动加入结束今天。</p>
                )}
                {kind === 'end' && reviews.length > 0 && (
                  <ul className="ritual-review-list">
                    {reviews.map((review) => (
                      <li key={review.nodeId} className="ritual-review-item">
                        <p className="ritual-review-title">{review.title === '' ? '（无标题回顾）' : review.title}</p>
                        <p className="ritual-review-meta">
                          快照：{review.snapshot === '' ? '（空）' : review.snapshot}
                          {' · '}
                          {review.checked ? '已完成' : '未完成'}
                        </p>
                        {!review.sourceAvailable && (
                          <p className="ritual-review-unavailable" role="status">
                            目标来源不可用（关联已解除），回顾快照和回答仍保留，恢复也不会自动重连。
                          </p>
                        )}
                        <div className="ritual-review-actions">
                          <button type="button" className="ritual-button"
                            disabled={disabled || goalBusy !== '' || !reviewCanWriteBack(review)}
                            onClick={() => void toggleReview(review, !review.checked)}>
                            {review.checked ? '标记为未完成' : '标记为完成'}
                          </button>
                        </div>
                        {!review.sourceAvailable && !reviewCanWriteBack(review) && (
                          <p className="ritual-hint">来源不可用时不能从结束今天回写；可以继续编辑回顾文字与回答。</p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {goalError !== '' && <p className="ritual-alert" role="alert">{goalError}</p>}
              </section>

              {deletedSources.length > 0 && (
                <section className="ritual-restore" aria-labelledby="ritual-restore-title">
                  <h3 id="ritual-restore-title">同日旧版本</h3>
                  <p className="ritual-hint">
                    回收箱里有 {deletedSources.length} 个同日{KIND_LABEL[kind]}。可以对照后手动复制内容，或完整替换当前文件。
                  </p>
                  <label className="ritual-restore-select">
                    <span>旧版本</span>
                    <select value={compareSource?.id ?? ''} disabled={disabled || compareBusy}
                      onChange={(event) => chooseCompareSource(Number(event.target.value))}>
                      <option value="">选择旧版本…</option>
                      {deletedSources.map((item) => (
                        <option key={item.id} value={item.id}>
                          #{item.id} · revision {item.revision}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="ritual-restore-actions">
                    <button type="button" className="ritual-button ritual-button--primary"
                      disabled={disabled || compareBusy} onClick={() => void openCompare()}>
                      打开对照
                    </button>
                    {onOpenTrash !== undefined && (
                      <button type="button" className="ritual-button" onClick={onOpenTrash}>去回收箱</button>
                    )}
                  </div>
                </section>
              )}
            </aside>
          )}

          <div className="ritual-main sj-ritual__paper"
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}>
            {notice !== '' && <p className="ritual-notice" role="status">{notice}</p>}

            {saveHint !== '' && (
              <div className="ritual-alert" role="alert">
                <p>{saveHint}</p>
                <div className="ritual-alert-actions">
                  {sessionStatus === 'failed' && (
                    <button type="button" className="ritual-button" disabled={disabled || busy}
                      onClick={() => void actions.retry()}>
                      重试保存
                    </button>
                  )}
                  {fileId !== null && (
                    <button type="button" className="ritual-button" disabled={disabled || busy}
                      onClick={() => void reloadServerVersion()}>
                      读取服务器最新版本
                    </button>
                  )}
                </div>
                {serverSnapshot !== null && (
                  <div className="ritual-conflict">
                    <p>
                      服务器现在是 revision {serverSnapshot.revision}；本地草稿仍在。
                      选择一方不会被再次自动合并。
                    </p>
                    <div className="ritual-alert-actions">
                      <button type="button" className="ritual-button" onClick={takeServerVersion}>采用服务器版本</button>
                      <button type="button" className="ritual-button ritual-button--primary" onClick={keepLocalDraft}>
                        保留本地草稿并基于最新重写
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {missingHistoryFile ? (
              <p className="ritual-state">
                {effectiveDate} 没有有效的{KIND_LABEL[kind]}。本页不提供历史日期的创建入口；
                请在当天打开时写入，或从回收箱恢复。
              </p>
            ) : (
              <>
                {compareSource !== null && targetRef !== null ? (
                  <RitualRestoreCompare
                    kind={kind}
                    journalDate={effectiveDate}
                    source={compareSource}
                    target={targetRef}
                    targetDraft={document}
                    disabled={disabled || compareBusy || busy}
                    error={compareError}
                    serverTarget={compareServerTarget}
                    onCancel={cancelCompare}
                    onReplace={(revision) => void replaceWithSource(revision)}
                    onCopy={(selection, insertAfter) => void copySelection(selection, insertAfter)}
                    onReload={() => void reloadCompare()}
                    right={(
                      <div className="ritual-editor ritual-editor--compare">
                        <RichTextEditor doc={document} locked={disabled || compareBusy}
                          label={`${KIND_LABEL[kind]} 正文`} onUserChange={handleBodyChange} />
                      </div>
                    )}
                  />
                ) : (
                  <>
                    <input
                      className="sj-ritual__title"
                      type="text"
                      aria-label="标题"
                      placeholder={displayTitle(kind, effectiveDate, null)}
                      value={title}
                      disabled={disabled || session === null}
                      onChange={(event) => handleTitleChange(event.target.value)}
                    />
                    <div className="ritual-editor">
                      {session === null
                        ? <p className="ritual-state" role="status">正在准备编辑会话……</p>
                        : (
                          <RichTextEditor
                            doc={document}
                            locked={editorLocked}
                            chromeHidden={chrome.hidden}
                            label={`${KIND_LABEL[kind]} 正文`}
                            onUserChange={handleBodyChange}
                          />
                        )}
                    </div>
                    <div className={`sj-ritual__status${statusCritical ? ' is-critical' : ''}`} role="status" aria-live="polite">
                      <span>{session !== null ? statusLabel(sessionStatus) : '正在准备编辑会话……'}</span>
                      {mirror.localState !== 'idle' && <span>{localStateLabel(mirror.localState)}</span>}
                      {session !== null && !busy && dirty && <span>还有改动未提交</span>}
                      {fileId === null && <span>写下正文后自动创建；空白不会产生记录</span>}
                    </div>
                    <p className="sj-ritual__quiet">类型与业务日期不可修改；标题与正文可以编辑。上海时间每日 04:00 换日，本页日期在打开草稿时固定。</p>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default RitualPage

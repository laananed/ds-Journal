/**
 * 应用外壳（Stage 4 / S04-T05，UI 调整第一轮更新）。
 *
 * 边界（`docs/stage4-tasks.md` §3.6）：
 * - `AppShell` **只负责布局、响应式与外观主题**，不读业务数据、不发请求；
 * - 插槽由上层传入：`navigation`、`context`、`children`、`aside`；
 *   本轮新增可选的 `shortcuts`（页面右下角快捷入口，见文件末尾说明）；
 * - 导航的点击行为、保存会话与 flush 仍由 `App.tsx` 的回调负责，
 *   外壳不接管「先保存再跳转」的逻辑，也不改变现有导航语义。
 *
 * 本轮变化（UI 调整第一轮：全局导航 + 首页）：
 * - 左列从 232px 文字导航收窄为 76px 图标栏，高度仍占满视口；
 * - 外观（浅色 / 深色 / 跟随系统）从常驻表单改为图标 + 弹出面板，
 *   选项与持久化行为完全保留；
 * - 新增 `shortcuts` 插槽：固定定位在外壳根部，因此能继承 `--sj-*` 主题变量。
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import './AppShell.css'
import { NavIcon } from './AppNav'
import {
  SYSTEM_DARK_QUERY,
  THEME_OPTIONS,
  readSystemPrefersDark,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference,
} from '../utils/theme'

/** 正文主区域的锚点 id：跳转链接与 `aria-controls` 共用。 */
export const SJ_MAIN_ID = 'sj-main'

/**
 * 外壳接口。
 *
 * - `navigation`：品牌 + 主入口图标栏（`components/AppNav.tsx`），由 `App.tsx` 渲染后传入；
 * - `context`：左侧上下文区（今日写作列表 / Ritual 当前模板），可为空；
 * - `children`：主区域正文（Dashboard、Writing、Ritual、Insight 等页面）；
 * - `aside`：右侧补充区（评论侧栏），可为空；
 * - `shortcuts`：页面右下角快捷入口（搜索 / 设置 / 回收箱），可为空。
 *
 * 只在 `context` / `aside` 非空时才占用对应列，空壳不会留下多余留白。
 */
export type AppShellProps = {
  navigation: ReactNode
  context: ReactNode | null
  children: ReactNode
  aside: ReactNode | null
  shortcuts?: ReactNode
}

/** 读取一次浏览器存储；无 `window`（非浏览器环境）时返回 null，由主题工具回落默认值。 */
function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    // 某些浏览器在隐私模式访问 localStorage 会直接抛错。
    return null
  }
}

function AppShell({ navigation, context, children, aside, shortcuts = null }: AppShellProps) {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference(browserStorage()))
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return readSystemPrefersDark((query) => window.matchMedia(query))
  })
  // 窄屏下上下文区默认收起：避免主区域被挤到首屏之外。
  const [contextOpen, setContextOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const contextPanelId = useId()
  const themeGroupName = useId()
  const themePanelId = useId()
  const themeWrap = useRef<HTMLDivElement>(null)
  const themeTrigger = useRef<HTMLButtonElement>(null)

  // 订阅系统外观变化：只有「跟随系统」时才会改变生效主题，但订阅本身无副作用。
  // 初值已由 useState 的初始化函数读取，这里不再同步设置，避免多余的重渲染。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(SYSTEM_DARK_QUERY)
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  // 保存用户选择；写入失败（存储被禁用/已满）不阻断界面，本次会话内仍然生效。
  useEffect(() => {
    writeThemePreference(browserStorage(), preference)
  }, [preference])

  // 外观面板：Esc 关闭、点击外部关闭，关闭后焦点回到图标按钮。
  const closeTheme = useCallback(() => {
    setThemeOpen(false)
    themeTrigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!themeOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (themeWrap.current !== null && !themeWrap.current.contains(event.target as Node)) closeTheme()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTheme()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [themeOpen, closeTheme])

  const theme = resolveTheme(preference, systemDark)
  const themeClass = useMemo(
    () => (theme === 'dark' ? 'sj-shell theme-dark' : 'sj-shell'),
    [theme],
  )

  return (
    <div
      className={themeClass}
      data-theme={theme}
      data-has-context={context === null ? 'false' : 'true'}
      data-has-aside={aside === null ? 'false' : 'true'}
    >
      <a className="sj-shell__skip" href={`#${SJ_MAIN_ID}`}>跳到正文</a>

      <aside className="sj-shell__sidebar">
        <div className="sj-shell__nav">{navigation}</div>

        <div className="sj-shell__theme" ref={themeWrap}>
          <button
            ref={themeTrigger}
            type="button"
            className="sj-nav__item"
            data-tip="外观"
            aria-label="外观"
            aria-haspopup="true"
            aria-expanded={themeOpen}
            aria-controls={themePanelId}
            data-active={themeOpen ? 'true' : 'false'}
            onClick={() => setThemeOpen((open) => !open)}
          >
            <NavIcon name="theme" />
          </button>

          {themeOpen && (
            <div className="sj-shell__theme-panel" id={themePanelId} role="group" aria-label="外观">
              <p className="sj-shell__theme-title">外观</p>
              <div className="sj-shell__theme-options">
                {THEME_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className="sj-shell__theme-option"
                    data-active={preference === option.value ? 'true' : 'false'}
                    title={option.hint}
                  >
                    <input
                      type="radio"
                      name={themeGroupName}
                      value={option.value}
                      checked={preference === option.value}
                      onChange={() => setPreference(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <p className="sj-shell__theme-hint" role="status">
                当前：{theme === 'dark' ? '深色' : '浅色'}
                {preference === 'system' ? '（跟随系统）' : ''}
              </p>
            </div>
          )}
        </div>
      </aside>

      {context !== null && (
        <section className="sj-shell__context" aria-label="当前上下文">
          <button
            type="button"
            className="sj-shell__context-toggle"
            aria-expanded={contextOpen}
            aria-controls={contextPanelId}
            onClick={() => setContextOpen((open) => !open)}
          >
            {contextOpen ? '收起上下文' : '展开上下文'}
          </button>
          <div
            className="sj-shell__context-panel"
            id={contextPanelId}
            data-open={contextOpen ? 'true' : 'false'}
          >
            {context}
          </div>
        </section>
      )}

      <main className="sj-shell__main" id={SJ_MAIN_ID} tabIndex={-1}>
        <div className="sj-shell__main-inner">{children}</div>
      </main>

      {aside !== null && (
        <aside className="sj-shell__aside" aria-label="补充信息">
          {aside}
        </aside>
      )}

      {shortcuts !== null && <div className="sj-shell__shortcuts">{shortcuts}</div>}
    </div>
  )
}

export default AppShell

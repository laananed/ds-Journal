/**
 * 全局导航（Stage 4 UI 调整第一轮：窄图标导航栏 + 页面右下角快捷入口）。
 *
 * 边界：
 * - **纯展示 + 回调**：不认识业务模块、不发请求、不读业务数据，
 *   选中项与跳转动作都由 `App.tsx` 决定（与 T05 外壳的分层保持一致）；
 * - 图标是内联 SVG（`NavIcon`），不引入图标库、不加图标字体；
 * - 每个图标按钮都有 `aria-label`（无障碍名称）、`data-tip`（可见文字提示）、
 *   `aria-current="page"`（选中状态）与外壳统一提供的键盘焦点环；
 * - 「更多」与「外观」用同一个关闭策略：Esc 关闭、点击外部关闭、关闭后焦点回到触发按钮；
 * - 窄屏（≤860px）由 CSS 把左侧竖栏改为顶部横向栏，结构不复制第二份。
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import './AppNav.css'

/** 需要的图标名。新增图标只改本文件，不散落到各页面。 */
export type NavIconName =
  | 'overview'
  | 'quick'
  | 'records'
  | 'insight'
  | 'more'
  | 'search'
  | 'settings'
  | 'trash'
  | 'theme'
  | 'schedule'
  | 'review'
  | 'inbox'
  | 'folder'

const STROKE_ICONS: Record<NavIconName, ReactNode> = {
  // 概览：房子
  overview: (
    <>
      <path d="M3.4 11.3 12 4.2l8.6 7.1" />
      <path d="M5.9 9.9v9.1a1.3 1.3 0 0 0 1.3 1.3h9.6a1.3 1.3 0 0 0 1.3-1.3V9.9" />
      <path d="M9.9 20.3v-5.2h4.2v5.2" />
    </>
  ),
  // 速记：铅笔
  quick: (
    <>
      <path d="M4.2 19.9l4.3-1 9.2-9.2a2.1 2.1 0 0 0 0-3l-.4-.4a2.1 2.1 0 0 0-3 0l-9.2 9.2-1 4.4z" />
      <path d="M14.2 7.1l2.8 2.8" />
    </>
  ),
  // 记录：翻开的书
  records: (
    <>
      <path d="M12 6.5C10.4 5.3 8.3 4.7 5.6 4.7v12.1c2.7 0 4.8.6 6.4 1.8 1.6-1.2 3.7-1.8 6.4-1.8V4.7c-2.7 0-4.8.6-6.4 1.8z" />
      <path d="M12 6.5v12.1" />
    </>
  ),
  // 洞察：灯泡
  insight: (
    <>
      <path d="M12 3.4a5.6 5.6 0 0 1 3.3 10.1c-.5.4-.8.9-.8 1.5v.6H9.5v-.6c0-.6-.3-1.1-.8-1.5A5.6 5.6 0 0 1 12 3.4z" />
      <path d="M9.7 18.4h4.6" />
      <path d="M10.6 21h2.8" />
    </>
  ),
  // 更多：三点
  more: (
    <>
      <circle cx="5.4" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.6" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  // 搜索：放大镜
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.2" />
      <path d="M15.4 15.4 20.2 20.2" />
    </>
  ),
  // 设置：齿轮
  settings: (
    <>
      <path d="M19.4 12c0-.4 0-.8-.1-1.2l2-1.5-2-3.4-2.3.9a7.6 7.6 0 0 0-2-1.2L14.6 3h-3.9l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7.6 7.6 0 0 0 2 1.2l.4 2.6h3.9l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
      <circle cx="12.6" cy="12" r="2.7" />
    </>
  ),
  // 回收箱：垃圾桶
  trash: (
    <>
      <path d="M4.6 7.1h14.8" />
      <path d="M9.4 7.1V5.3a1.2 1.2 0 0 1 1.2-1.2h2.9a1.2 1.2 0 0 1 1.2 1.2v1.8" />
      <path d="M6.5 7.1l.8 11.5a1.7 1.7 0 0 0 1.7 1.6h6a1.7 1.7 0 0 0 1.7-1.6l.8-11.5" />
      <path d="M10.3 10.5v6.4" />
      <path d="M13.7 10.5v6.4" />
    </>
  ),
  // 外观：月亮
  theme: (
    <>
      <path d="M20 13.7A8.1 8.1 0 0 1 10.3 4a8.3 8.3 0 1 0 9.7 9.7z" />
    </>
  ),
  // 日程：日历
  schedule: (
    <>
      <rect x="3.8" y="5.6" width="16.4" height="14.6" rx="2.2" />
      <path d="M3.8 10.2h16.4" />
      <path d="M8.4 3.6v3.6" />
      <path d="M15.6 3.6v3.6" />
    </>
  ),
  // AI 复盘：星芒
  review: (
    <>
      <path d="M12 3.4l1.9 4.7 4.7 1.9-4.7 1.9L12 16.6l-1.9-4.7L5.4 10l4.7-1.9z" />
      <path d="M17.8 16.2l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </>
  ),
  // 历史收件箱：收纳盒
  inbox: (
    <>
      <path d="M3.9 7.4h16.2v10.4a1.6 1.6 0 0 1-1.6 1.6H5.5a1.6 1.6 0 0 1-1.6-1.6V7.4z" />
      <path d="M3.9 7.4 6.2 4.4h11.6l2.3 3" />
      <path d="M9.6 12.4h4.8" />
    </>
  ),
  // 文件夹：文件夹
  folder: (
    <>
      <path d="M3.9 7.6h5.3l1.9 2.3h9v8.5a1.7 1.7 0 0 1-1.7 1.7H5.6a1.7 1.7 0 0 1-1.7-1.7V7.6z" />
    </>
  ),
}

/** 统一的描边图标；尺寸与线宽集中在这里，避免各调用点各写一份。 */
export function NavIcon({ name, size = 22 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      className="sj-nav__icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {STROKE_ICONS[name]}
    </svg>
  )
}

/** 品牌标识：四根高低不一的声波竖条。 */
export function NavBrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="sj-nav__icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      fill="currentColor"
    >
      <rect x="3.2" y="9.6" width="2.6" height="4.8" rx="1.3" />
      <rect x="7.9" y="6.4" width="2.6" height="11.2" rx="1.3" />
      <rect x="12.6" y="3.4" width="2.6" height="17.2" rx="1.3" />
      <rect x="17.3" y="7.6" width="2.6" height="8.8" rx="1.3" />
    </svg>
  )
}

/** 一个导航项：`id` 是上层模块标识，本组件不解释它的含义。 */
export type AppNavItem<T extends string> = {
  id: T
  label: string
  icon: NavIconName
}

export type AppNavProps<T extends string> = {
  /** 主入口，竖栏中从上到下排列。 */
  items: ReadonlyArray<AppNavItem<T>>
  /** 次级入口，收进「更多」菜单；不传则不渲染该菜单。 */
  overflow?: ReadonlyArray<AppNavItem<T>>
  /** 「更多」按钮的文字提示与无障碍名称。 */
  overflowLabel?: string
  /** 当前选中的模块 id；不在任何一项里时「更多」只按 `overflowActive` 决定高亮。 */
  active: T
  /** 「更多」菜单里是否有当前模块（用于给触发按钮加高亮）。 */
  overflowActive?: boolean
  disabled?: boolean
  onSelect: (id: T) => void
  /** 品牌标识回到概览。 */
  onHome: () => void
}

/** 按下 Esc、点击面板外部时关闭；返回容器 ref 供定位判定。 */
function useDismiss(open: boolean, close: () => void) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (container.current !== null && !container.current.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])
  return container
}

function AppNav<T extends string>({
  items,
  overflow,
  overflowLabel = '更多',
  active,
  overflowActive = false,
  disabled = false,
  onSelect,
  onHome,
}: AppNavProps<T>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  /**
   * 当前页在「更多」里时，触发按钮的无障碍名称要带上它。
   *
   * 不给按钮加 `aria-current`：那个属性表示「这一项就是当前页」，而「更多」
   * 只是收纳容器，标上会让读屏把容器误读成当前页。子项在菜单展开时本来就有
   * `aria-current="page"`；菜单一关闭子项不在 DOM 里，所以改由按钮名称承载
   * 同样的信息，聚焦到按钮就能听见「更多（当前：日程）」。
   */
  const activeOverflowItem = overflow?.find((item) => item.id === active) ?? null
  const overflowName = activeOverflowItem === null
    ? overflowLabel
    : `${overflowLabel}（当前：${activeOverflowItem.label}）`

  // 关闭时把焦点还给触发按钮；Esc 与点击外部走同一条路径。
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    triggerRef.current?.focus()
  }, [])
  const container = useDismiss(menuOpen, closeMenu)

  // 打开后把焦点移进菜单：键盘用户不需要再用 Tab 逐项找回位置。
  useEffect(() => {
    if (menuOpen) firstItemRef.current?.focus()
  }, [menuOpen])

  return (
    <div className="sj-nav">
      <button
        type="button"
        className="sj-nav__brand"
        aria-label="SeekJournal · 回到概览"
        data-tip="SeekJournal"
        disabled={disabled}
        onClick={onHome}
      >
        <NavBrandMark />
      </button>

      <nav className="sj-nav__main" aria-label="主导航">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="sj-nav__item"
            data-tip={item.label}
            aria-label={item.label}
            aria-current={active === item.id ? 'page' : undefined}
            disabled={disabled}
            onClick={() => onSelect(item.id)}
          >
            <NavIcon name={item.icon} />
          </button>
        ))}
      </nav>

      {overflow !== undefined && overflow.length > 0 && (
        <div className="sj-nav__overflow" ref={container}>
          <button
            ref={triggerRef}
            type="button"
            className="sj-nav__item"
            data-tip={overflowName}
            aria-label={overflowName}
            /* 弹层是一组导航按钮（`role="group"`），按披露模式用 expanded/controls；
               写成 `aria-haspopup="menu"` 会要求 role="menu" + menuitem，语义对不上。 */
            aria-expanded={menuOpen}
            aria-controls={menuId}
            data-active={menuOpen || overflowActive ? 'true' : 'false'}
            disabled={disabled}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <NavIcon name="more" />
          </button>
          {menuOpen && (
            <div className="sj-nav__menu" id={menuId} role="group" aria-label={overflowLabel}>
              {overflow.map((item, index) => (
                <button
                  key={item.id}
                  ref={index === 0 ? firstItemRef : undefined}
                  type="button"
                  className="sj-nav__menu-item"
                  aria-current={active === item.id ? 'page' : undefined}
                  onClick={() => {
                    setMenuOpen(false)
                    // 菜单项随关闭一起卸载：不把焦点收回触发按钮，焦点会掉到 body，
                    // 读屏既听不到新页面、键盘用户也要从头 Tab 一遍。
                    triggerRef.current?.focus()
                    onSelect(item.id)
                  }}
                >
                  <NavIcon name={item.icon} size={18} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export type PageShortcutsProps<T extends string> = {
  items: ReadonlyArray<AppNavItem<T>>
  active: T
  disabled?: boolean
  onSelect: (id: T) => void
}

/**
 * 页面右下角的快捷入口（搜索 / 设置 / 回收箱）。
 *
 * 由 `App.tsx` 通过外壳的 `shortcuts` 插槽传入，固定定位在外壳根部，
 * 因此能继承 `--sj-*` 主题变量；窄屏时按钮变小但仍可点击。
 */
export function PageShortcuts<T extends string>({ items, active, disabled = false, onSelect }: PageShortcutsProps<T>) {
  return (
    <div className="sj-shortcuts" role="group" aria-label="快捷入口">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="sj-shortcuts__item"
          data-tip={item.label}
          data-tip-side="left"
          aria-label={item.label}
          aria-current={active === item.id ? 'page' : undefined}
          disabled={disabled}
          onClick={() => onSelect(item.id)}
        >
          <NavIcon name={item.icon} size={20} />
        </button>
      ))}
    </div>
  )
}

export default AppNav

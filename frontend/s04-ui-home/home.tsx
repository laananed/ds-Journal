/* oxlint-disable react/only-export-components -- 这是验证台入口，不是可热更新的组件模块 */
/**
 * 首页 / 导航视觉验证台（仅本地证据，不参与 `npm run build`）。
 *
 * 目的：在前端后端都不改写真实数据库的前提下，用**真实组件**渲染首页与导航，
 * 覆盖 加载 / 空 / 已有计划 / 已有复盘 / 读取失败 / 窄屏 / 键盘焦点 / 浮层 等状态。
 *
 * 组成全部是产品代码：
 * - `AppShell`（外壳、主题、外观浮层）
 * - `AppNav` / `PageShortcuts`（图标导航与右下角快捷入口）
 * - `DashboardPage`（首页）
 * - `useTodayOverview`（真实的三个 GET 读取逻辑）
 * 唯一替换的是 `window.fetch`：只返回合成数据，并记录每次请求的方法与 URL，
 * 用于证明「打开首页 / 重新读取只会 GET，不会创建任何文件」。
 *
 * 用法：
 *   npx vite --port 5188
 *   http://127.0.0.1:5188/s04-ui-home/home.html?scenario=plan&active=dashboard
 * 参数：
 *   scenario = empty | plan | end | error | slow
 *   active   = dashboard | writing | journal | insight | schedule | review | inbox | folder | search | settings | trash
 *   open     = more | theme    （挂载后真实点击对应按钮，展示浮层）
 *   focus    = nav:<n> | quick | plan | review   （挂载后聚焦指定元素，展示焦点环与文字提示）
 */
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
// 与真实应用一致：App.tsx 会引入 App.css，`.app button` 等元素级规则会影响首页按钮，
// 验证台必须一并引入，否则截出来的样式比真实页面"干净"，等于没有验证。
import '../src/App.css'
import AppShell from '../src/components/AppShell'
import AppNav, { PageShortcuts, type AppNavItem } from '../src/components/AppNav'
import DashboardPage from '../src/pages/DashboardPage'
import { useTodayOverview } from '../src/hooks/useTodayOverview'

type ModuleId =
  | 'dashboard' | 'writing' | 'journal' | 'insight'
  | 'schedule' | 'review' | 'inbox' | 'folder'
  | 'search' | 'settings' | 'trash'

const params = new URLSearchParams(window.location.search)
const scenario = params.get('scenario') ?? 'empty'
const active = (params.get('active') ?? 'dashboard') as ModuleId

// 主题走真实持久化键（`utils/theme.ts` 的 THEME_STORAGE_KEY），
// 只是为了截深色图时能预设偏好，不绕过组件的读取逻辑。
const themeParam = params.get('theme')
if (themeParam === 'dark' || themeParam === 'light' || themeParam === 'system') {
  window.localStorage.setItem('seekjournal-theme-preference', themeParam)
}

const navItems: ReadonlyArray<AppNavItem<ModuleId>> = [
  { id: 'dashboard', label: '概览', icon: 'overview' },
  { id: 'writing', label: '速记', icon: 'quick' },
  { id: 'journal', label: '记录', icon: 'records' },
  { id: 'insight', label: '洞察', icon: 'insight' },
]
const overflowItems: ReadonlyArray<AppNavItem<ModuleId>> = [
  { id: 'schedule', label: '日程', icon: 'schedule' },
  { id: 'review', label: 'AI 复盘', icon: 'review' },
  { id: 'inbox', label: '历史收件箱', icon: 'inbox' },
  { id: 'folder', label: '文件夹', icon: 'folder' },
]
const shortcutItems: ReadonlyArray<AppNavItem<ModuleId>> = [
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'settings', label: '设置', icon: 'settings' },
  { id: 'trash', label: '回收箱', icon: 'trash' },
]

type Call = { method: string; url: string }
const calls: Call[] = []
;(window as unknown as { __calls: Call[] }).__calls = calls

const BUSINESS_DATE = '2026-11-02'

function journal(id: number, kind: 'writing' | 'set' | 'end', title: string, content: string) {
  return {
    type: 'journal' as const,
    id,
    title,
    display_title: title,
    content,
    revision: 3,
    folder_id: null,
    created_at: '2026-11-02T00:12:00.000000Z',
    updated_at: '2026-11-02T00:41:00.000000Z',
    deleted_at: null,
    journal_date: BUSINESS_DATE,
    journal_kind: kind,
    content_doc: null,
    document_format: 'legacy' as const,
  }
}

const WRITINGS = [
  journal(101, 'writing', '早上的一个念头', '今天先把首页的留白调好，再看导航的手感。'),
  journal(102, 'writing', '', '午休时想到：入口越少，越要把名字说清楚。'),
]
const PLAN = journal(201, 'set', '计划 2026-11-02', '今天的目标：把首页和导航收口，晚上复盘一次。')
const REVIEW = journal(202, 'end', '复盘 2026-11-02', '首页的蓝色卡片比上一版安静，留白也更稳。')

function payload(path: string): { status: number; body: unknown } {
  if (scenario === 'error') return { status: 503, body: { detail: '数据库暂时不可用，请稍后再试' } }

  if (path.includes('/api/business-day')) {
    return {
      status: 200,
      body: {
        timezone: 'Asia/Shanghai',
        day_start_hour: 4,
        server_time: '2026-11-02T01:12:00.000000Z',
        business_date: BUSINESS_DATE,
      },
    }
  }
  if (path.includes('/api/journals')) {
    const items = scenario === 'empty' || scenario === 'slow' ? [] : scenario === 'plan' ? WRITINGS : [WRITINGS[0]]
    return { status: 200, body: { items, page: 1, page_size: 20, total: items.length, has_next: false } }
  }
  if (path.includes('/api/rituals')) {
    const set = scenario === 'plan' || scenario === 'end' ? PLAN : null
    const end = scenario === 'end' ? REVIEW : null
    return { status: 200, body: { journal_date: BUSINESS_DATE, set, end } }
  }
  return { status: 404, body: { detail: '未在验证台中登记该接口' } }
}

const realFetch = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const method = init?.method ?? 'GET'
  calls.push({ method, url })
  if (!url.includes('/api/')) return realFetch(input, init)

  const { status, body } = payload(url)
  const delay = scenario === 'slow' ? 2500 : 120
  return new Promise<Response>((resolve) => {
    window.setTimeout(() => {
      resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
    }, delay)
  })
}

function noop() {}

/** 把实际发出的请求写进 DOM：`--dump-dom` 可读，用于证明零写入。 */
function CallsProbe() {
  const [text, setText] = useState('[]')
  const [metrics, setMetrics] = useState('{}')
  useEffect(() => {
    const id = window.setInterval(() => setText(JSON.stringify(calls)), 150)
    const metricsId = window.setInterval(() => {
      const rect = (selector: string) => {
        const node = document.querySelector(selector)
        if (node === null) return null
        const box = node.getBoundingClientRect()
        return [Math.round(box.left), Math.round(box.width)]
      }
      const focused = document.activeElement as HTMLElement | null
      const tip = focused === null
        ? null
        : {
            label: focused.getAttribute('aria-label'),
            tag: focused.tagName,
            tip: focused.dataset.tip ?? null,
            focusVisible: focused.matches(':focus-visible'),
            afterOpacity: window.getComputedStyle(focused, '::after').opacity,
            afterContent: window.getComputedStyle(focused, '::after').content,
            afterLeft: window.getComputedStyle(focused, '::after').left,
          }
      setMetrics(JSON.stringify({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: document.scrollingElement?.scrollWidth ?? null,
        shell: rect('.sj-shell'),
        main: rect('.sj-shell__main'),
        inner: rect('.sj-shell__main-inner'),
        stack: rect('.dash-stack'),
        shortcuts: rect('.sj-shortcuts'),
        focused: tip,
      }))
    }, 200)
    return () => {
      window.clearInterval(id)
      window.clearInterval(metricsId)
    }
  }, [])
  return (
    <div style={{ position: 'fixed', left: '-9999px', top: 0 }}>
      <pre id="harness-calls">{text}</pre>
      <pre id="harness-metrics">{metrics}</pre>
    </div>
  )
}

function Harness() {
  const overview = useTodayOverview()

  useEffect(() => {
    const applyFocus = () => {
      const focus = params.get('focus')
      if (focus === 'quick') document.querySelector<HTMLButtonElement>('.dash-quick')?.focus()
      if (focus === 'plan') document.querySelectorAll<HTMLButtonElement>('.dash-action')[0]?.focus()
      if (focus === 'review') document.querySelectorAll<HTMLButtonElement>('.dash-action')[1]?.focus()
      if (focus !== null && focus.startsWith('nav:')) {
        const index = Number(focus.slice(4))
        document.querySelectorAll<HTMLButtonElement>('.sj-nav__main .sj-nav__item')[index]?.focus()
      }
    }
    // 焦点尽早给（挂载后立刻），浮层等数据到位后再点，避免和加载竞态
    applyFocus()
    const timer = window.setTimeout(() => {
      const open = params.get('open')
      if (open === 'more') document.querySelector<HTMLButtonElement>('.sj-nav__overflow > button')?.click()
      if (open === 'theme') document.querySelector<HTMLButtonElement>('.sj-shell__theme > button')?.click()
    }, 650)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <>
      <AppShell
        navigation={
          <AppNav
            items={navItems}
            overflow={overflowItems}
            overflowLabel="更多"
            active={active}
            overflowActive={overflowItems.some((item) => item.id === active)}
            onSelect={noop}
            onHome={noop}
          />
        }
        context={null}
        aside={null}
        shortcuts={<PageShortcuts items={shortcutItems} active={active} onSelect={noop} />}
      >
        <div className="app app-embedded">
          <div className="app-content">
            <DashboardPage
              status={overview.status}
              today={overview.today}
              error={overview.error}
              onRetry={overview.reload}
              onQuickNote={noop}
              onOpenPlan={noop}
              onOpenReview={noop}
            />
          </div>
        </div>
      </AppShell>
      <CallsProbe />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)

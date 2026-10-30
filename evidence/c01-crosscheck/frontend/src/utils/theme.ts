/**
 * 外观主题纯逻辑（Stage 4 / S04-T05）。
 *
 * 产品要求（`docs/stage4.md` §3）：
 * - 提供浅色、深色与跟随系统三种外观选择；
 * - 使用现有 CSS 能力与设计变量，不为主题增加 UI 框架；
 * - 重新打开应恢复上次选择（持久化）。
 *
 * 本文件只放**可独立测试的纯函数**：不读 React、不碰 DOM 事件、
 * 不写入全局样式。组件（`components/AppShell.tsx`）负责订阅系统外观变化、
 * 保存选择并把生效主题渲染成 `data-theme` 属性。
 *
 * 为什么把「偏好」和「生效主题」分成两个类型：
 * - `ThemePreference` 是用户的选择（可能是 `system`），用于持久化与控件状态；
 * - `Theme` 是真正生效的外观（只可能是 `light` / `dark`），用于渲染。
 * 两者混用会出现「存储里是 system，但代码拿它当类名」这类隐性错误。
 */

/** 生效主题：只可能是浅色或深色。 */
export type Theme = 'light' | 'dark'

/** 用户选择的外观偏好：比生效主题多一个「跟随系统」。 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本阶段的偏好存储键（与 T05 之前 `App.tsx` 使用的旧键区分）。 */
export const THEME_STORAGE_KEY = 'seekjournal-theme-preference'

/** T05 之前 `App.tsx` 只存过 `light` / `dark` 的旧键，仅用于一次性兼容读取。 */
export const LEGACY_THEME_STORAGE_KEY = 'seekjournal-theme'

/** 媒体查询字符串：系统是否偏好深色。 */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 默认偏好。
 *
 * 取 `light` 而不是 `system`：T05 之前应用的默认外观就是浅色，
 * 改成跟随系统会未经确认地改变现有用户的观感。需要改为 `system`
 * 时只调整这一处常量，控件与测试会一起生效。
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light'

/** 主题控件的选项与文案。「开始今天 / 结束今天」的完整名称规则同样适用于此处，不使用英文缩写。 */
export const THEME_OPTIONS: readonly {
  value: ThemePreference
  label: string
  hint: string
}[] = [
  { value: 'light', label: '浅色', hint: '始终使用浅色外观' },
  { value: 'dark', label: '深色', hint: '始终使用深色外观' },
  { value: 'system', label: '跟随系统', hint: '跟随操作系统的外观设置' },
]

/** 只依赖 getItem / setItem 的最小存储接口，便于用假对象测试。 */
export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** 只依赖 matches 的最小媒体查询接口（`window.matchMedia` 返回值的子集）。 */
export type MediaQueryLike = { matches: boolean }

/** 类型守卫：判断任意值是否为合法偏好。 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * 把存储或 URL 里读到的原始字符串解析为偏好。
 *
 * 大小写不敏感（`Dark` 视为 `dark`），未知值、空串与 null 都回落到默认值；
 * 不做「猜最近似值」，避免把损坏数据误解成用户选择。
 */
export function parseThemePreference(raw: string | null | undefined): ThemePreference {
  if (typeof raw !== 'string') return DEFAULT_THEME_PREFERENCE
  const value = raw.trim().toLowerCase()
  if (isThemePreference(value)) return value
  return DEFAULT_THEME_PREFERENCE
}

/**
 * 把偏好解析为生效主题。
 *
 * `systemPrefersDark` 由调用方传入系统的当前状态（组件通过 matchMedia 订阅），
 * 因此本函数保持纯函数、可测试，不直接访问 `window`。
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * 读取系统是否偏好深色。
 *
 * 传入 `window.matchMedia` 的等价函数（便于测试）；浏览器不支持、调用抛错
 * 或查询被拒绝时按「非深色」处理，保证主题解析不会因为环境缺失而中断。
 */
export function readSystemPrefersDark(
  matchMedia: ((query: string) => MediaQueryLike | null) | null | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false
  try {
    return matchMedia(SYSTEM_DARK_QUERY)?.matches === true
  } catch {
    return false
  }
}

/**
 * 从本地存储读取偏好，并兼容 T05 之前的旧键。
 *
 * 顺序：新键合法值 → 旧键 `light`/`dark` → 默认值。
 * 存储不可用（隐私模式、被禁用、抛异常）时静默回落到默认值：
 * 主题读取失败不应阻断页面渲染。
 */
export function readThemePreference(storage: StorageLike | null | undefined): ThemePreference {
  if (storage === null || storage === undefined) return DEFAULT_THEME_PREFERENCE
  try {
    const current = storage.getItem(THEME_STORAGE_KEY)
    if (isThemePreference(current)) return current
    const legacy = storage.getItem(LEGACY_THEME_STORAGE_KEY)
    if (legacy === 'light' || legacy === 'dark') return legacy
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
  return DEFAULT_THEME_PREFERENCE
}

/**
 * 保存偏好。
 *
 * 返回是否写入成功：存储满、被禁用或抛异常时返回 `false`，由调用方决定是否提示；
 * 本函数自身不抛异常，也不做重试。
 */
export function writeThemePreference(
  storage: StorageLike | null | undefined,
  preference: ThemePreference,
): boolean {
  if (storage === null || storage === undefined) return false
  try {
    storage.setItem(THEME_STORAGE_KEY, preference)
    return true
  } catch {
    return false
  }
}

/** 取选项文案；未知值回落到默认选项的文案。 */
export function themePreferenceLabel(preference: ThemePreference): string {
  const option = THEME_OPTIONS.find((item) => item.value === preference)
  return option ? option.label : '浅色'
}

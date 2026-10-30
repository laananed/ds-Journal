/**
 * 主题纯逻辑测试（Stage 4 / S04-T05）。
 *
 * 不引入测试框架，直接用 Node 内置的类型剥离运行：
 *
 *   node --experimental-strip-types src/utils/theme.test.ts
 *
 * 覆盖：偏好解析与非法值、旧键兼容、系统外观解析、存储读写与异常回落、
 * 选项文案（含「跟随系统」完整名称）。
 */

import {
  DEFAULT_THEME_PREFERENCE,
  LEGACY_THEME_STORAGE_KEY,
  SYSTEM_DARK_QUERY,
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  isThemePreference,
  parseThemePreference,
  readSystemPrefersDark,
  readThemePreference,
  resolveTheme,
  themePreferenceLabel,
  writeThemePreference,
  type ThemePreference,
} from './theme.ts'

let passed = 0
const failures: string[] = []

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
}

function equal<T>(actual: T, expected: T, label: string): void {
  check(actual === expected, `${label}（实际 ${String(actual)}，期望 ${String(expected)}）`)
}

/** 内存版存储：可读写、可注入初始值。 */
class MemoryStorage {
  private readonly data = new Map<string, string>()

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.data.set(key, value)
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

/** 读取即抛错的存储：模拟隐私模式 / 被禁用的 localStorage。 */
class BrokenStorage {
  getItem(): string | null {
    throw new Error('storage unavailable')
  }

  setItem(): void {
    throw new Error('storage full')
  }
}

// T-1 默认偏好保持 T05 之前的浅色观感
equal(DEFAULT_THEME_PREFERENCE, 'light', 'T-1 默认偏好为 light')

// T-2 合法值原样通过
equal(parseThemePreference('light'), 'light', 'T-2 light 解析为 light')
equal(parseThemePreference('dark'), 'dark', 'T-2 dark 解析为 dark')
equal(parseThemePreference('system'), 'system', 'T-2 system 解析为 system')

// T-3 大小写与空白：容忍首尾空白与大小写差异，不猜未知值
equal(parseThemePreference('  Dark  '), 'dark', 'T-3 首尾空白与大小写被规范化')
equal(parseThemePreference('DARKER'), DEFAULT_THEME_PREFERENCE, 'T-3 近似值不猜测，回落默认')
equal(parseThemePreference(''), DEFAULT_THEME_PREFERENCE, 'T-3 空串回落默认')
equal(parseThemePreference(null), DEFAULT_THEME_PREFERENCE, 'T-3 null 回落默认')
equal(parseThemePreference(undefined), DEFAULT_THEME_PREFERENCE, 'T-3 undefined 回落默认')

// T-4 类型守卫只接受三个枚举值
check(isThemePreference('system'), 'T-4 守卫接受 system')
check(!isThemePreference('auto'), 'T-4 守卫拒绝 auto')
check(!isThemePreference(null), 'T-4 守卫拒绝 null')

// T-5 生效主题解析：system 依赖系统状态，显式选择不受系统影响
equal(resolveTheme('system', true), 'dark', 'T-5 跟随系统 + 系统深色 → dark')
equal(resolveTheme('system', false), 'light', 'T-5 跟随系统 + 系统浅色 → light')
equal(resolveTheme('light', true), 'light', 'T-5 显式浅色不被系统深色覆盖')
equal(resolveTheme('dark', false), 'dark', 'T-5 显式深色不被系统浅色覆盖')

// T-6 系统外观读取：缺失 / 抛错按非深色处理，不中断主题解析
equal(readSystemPrefersDark((query) => ({ matches: query === SYSTEM_DARK_QUERY })), true,
  'T-6 查询深色媒体条件命中返回 true')
equal(readSystemPrefersDark(() => ({ matches: false })), false, 'T-6 未命中返回 false')
equal(readSystemPrefersDark(null), false, 'T-6 无 matchMedia 返回 false')
equal(readSystemPrefersDark(() => { throw new Error('denied') }), false, 'T-6 查询抛错返回 false')

// T-7 旧键兼容：T05 之前只存 light/dark
equal(readThemePreference(new MemoryStorage({ [LEGACY_THEME_STORAGE_KEY]: 'dark' })), 'dark',
  'T-7 旧键 dark 被识别')
equal(readThemePreference(new MemoryStorage({ [LEGACY_THEME_STORAGE_KEY]: 'light' })), 'light',
  'T-7 旧键 light 被识别')
equal(
  readThemePreference(new MemoryStorage({
    [THEME_STORAGE_KEY]: 'system',
    [LEGACY_THEME_STORAGE_KEY]: 'dark',
  })),
  'system',
  'T-7 新键优先于旧键',
)
equal(
  readThemePreference(new MemoryStorage({
    [THEME_STORAGE_KEY]: 'broken',
    [LEGACY_THEME_STORAGE_KEY]: 'dark',
  })),
  'dark',
  'T-7 新键损坏时回落到旧键',
)
equal(readThemePreference(new MemoryStorage()), DEFAULT_THEME_PREFERENCE,
  'T-7 无任何记录时使用默认偏好')
equal(readThemePreference(null), DEFAULT_THEME_PREFERENCE, 'T-7 存储缺失时使用默认偏好')
equal(readThemePreference(undefined), DEFAULT_THEME_PREFERENCE, 'T-7 存储未定义时使用默认偏好')
equal(readThemePreference(new BrokenStorage()), DEFAULT_THEME_PREFERENCE,
  'T-7 存储抛错时静默回落默认，不抛出')

// T-8 写入：成功返回 true 并写入新键；异常与缺失存储返回 false 且不抛错
{
  const storage = new MemoryStorage()
  check(writeThemePreference(storage, 'system'), 'T-8 写入成功返回 true')
  equal(storage.getItem(THEME_STORAGE_KEY), 'system', 'T-8 写入落在新键上')
  equal(readThemePreference(storage), 'system', 'T-8 写入后可回读同一个偏好')
}
check(!writeThemePreference(new BrokenStorage(), 'dark'), 'T-8 写入抛错返回 false')
check(!writeThemePreference(null, 'dark'), 'T-8 存储缺失返回 false')

// T-9 选项文案：三种外观齐全，「跟随系统」不使用缩写
equal(THEME_OPTIONS.length, 3, 'T-9 三个外观选项')
equal(THEME_OPTIONS.map((item) => item.value).join(','), 'light,dark,system',
  'T-9 选项顺序为浅色、深色、跟随系统')
equal(themePreferenceLabel('system'), '跟随系统', 'T-9 system 文案为「跟随系统」')
equal(themePreferenceLabel('dark'), '深色', 'T-9 dark 文案为「深色」')
check(
  THEME_OPTIONS.every((item) => item.hint.trim().length > 0),
  'T-9 每个选项都有说明文案',
)

// T-10 偏好类型集合与媒体查询常量固定，避免组件与测试各写一份
const preferences: ThemePreference[] = ['light', 'dark', 'system']
check(preferences.every(isThemePreference), 'T-10 三种偏好全部合法')
equal(SYSTEM_DARK_QUERY, '(prefers-color-scheme: dark)', 'T-10 媒体查询字符串固定')

if (failures.length > 0) {
  throw new Error(`失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
}

console.log(`theme: ${passed} assertions passed`)

/**
 * 输入校验纯逻辑的最小测试（Stage 1.5 / S1.5-T2）。
 *
 * 不引入测试框架：直接用 Node 内置的类型剥离运行本文件——
 *
 *   node --experimental-strip-types src/utils/contentValidation.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，
 * 也能被 `tsc -b` 正常检查。
 *
 * 测试调用的是 `contentValidation.ts` 里的真实函数（不是复制一份算法过来）。
 */

import {
  CONTENT_MAX_CODE_POINTS,
  TITLE_MAX_CODE_POINTS,
  countCodePoints,
  formatContentValidationErrors,
  hasContentValidationErrors,
  isBlankText,
  validateContent,
  validateCreateInput,
  validateTitle,
  validateUpdateInput,
} from './contentValidation.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`失败：${label}`)
  }
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(
    actualText === expectedText,
    `${label}：期望 ${expectedText}，实际 ${actualText}`,
  )
}

/** 断言校验函数「通过」（返回 undefined）。 */
function expectValid(actual: string | undefined, label: string): void {
  check(actual === undefined, `${label}：期望通过，实际错误 ${JSON.stringify(actual)}`)
}

/** 断言校验函数「不通过」（返回了非空错误说明）。 */
function expectInvalid(actual: string | undefined, label: string): void {
  check(
    typeof actual === 'string' && actual !== '',
    `${label}：期望被拒绝，实际 ${JSON.stringify(actual)}`,
  )
}

// ---- 码点计数：必须与后端 Python len() 一致 ----

check(countCodePoints('') === 0, '空串 0 个码点')
check(countCodePoints('abc') === 3, 'ASCII 逐字符计数')
check(countCodePoints('中文') === 2, '中文按码点计数（不是字节数）')
check(countCodePoints('🧭') === 1, '非 BMP emoji 只算 1 个码点')
check(countCodePoints('🧭') < '🧭'.length, 'emoji 的 length(2) 比码点数(1) 大')
check(countCodePoints('a🧭中') === 3, '混合串按码点计数')
check(countCodePoints('🧭'.repeat(80)) === 80, '80 个 emoji 是 80 个码点')

// ---- 空白判定 ----

check(isBlankText(''), '空字符串算空白')
check(isBlankText(' '), '普通空格算空白')
check(isBlankText('\t'), 'Tab 算空白')
check(isBlankText('\n'), '换行算空白')
check(isBlankText('\r\n'), 'CRLF 算空白')
check(isBlankText(' \t\n'), '空白组合算空白')
check(isBlankText('\u3000'), '全角空格算空白')
check(isBlankText('\xa0'), 'NBSP 算空白')
check(!isBlankText('a'), '普通字符不算空白')
check(!isBlankText(' 中文 '), '含非空白字符不算空白')
check(!isBlankText('\u200b'), '零宽空格不算空白（与后端一致）')

// ---- title ----

expectValid(validateTitle(null), 'title 为 null 合法')
expectValid(validateTitle(''), 'title 为空字符串合法')
expectValid(validateTitle('广州动物园复盘'), '普通标题合法')
expectValid(validateTitle('标'.repeat(80)), '80 个码点合法')
expectInvalid(validateTitle('标'.repeat(81)), '81 个码点非法')
expectValid(validateTitle('🧭'.repeat(80)), '80 个非 BMP emoji 合法（不能按 length 判）')
expectInvalid(validateTitle('🧭'.repeat(81)), '81 个非 BMP emoji 非法')
expectValid(validateTitle('  标题  '), '首尾空格标题合法（不 trim）')
expectValid(validateTitle('   '), '纯空白手工标题合法（不拒绝、不清洗）')
check(TITLE_MAX_CODE_POINTS === 80, '标题上限常量是 80')

// ---- content ----

expectInvalid(validateContent(''), '空正文非法')
expectInvalid(validateContent(' '), '全空格正文非法')
expectInvalid(validateContent('\t'), 'Tab 正文非法')
expectInvalid(validateContent('\n'), '换行正文非法')
expectInvalid(validateContent(' \t\n'), '空白组合正文非法')
expectInvalid(validateContent('\u3000'), '全角空格正文非法')
expectInvalid(validateContent('\xa0'), 'NBSP 正文非法')
expectValid(validateContent('正文'), '普通正文合法')
expectValid(validateContent('  缩进\n\n结尾  '), '含首尾空格的正文合法')
expectValid(validateContent('a'.repeat(49_999)), '49,999 个码点合法')
expectValid(validateContent('a'.repeat(50_000)), '50,000 个码点合法')
expectInvalid(validateContent('a'.repeat(50_001)), '50,001 个码点非法')
expectInvalid(
  validateContent(' '.repeat(50_000) + 'x'),
  '按原始长度计数：trim 后只剩 1 个字符也要拒绝',
)
expectValid(
  validateContent('中'.repeat(49_999) + '🧭'),
  '中文 + emoji 按码点计数：50,000 合法',
)
expectInvalid(
  validateContent('中'.repeat(50_000) + '🧭'),
  '中文 + emoji 按码点计数：50,001 非法',
)
check(CONTENT_MAX_CODE_POINTS === 50_000, '正文上限常量是 50,000')

// ---- 创建：整份待创建字段一起校验 ----

expectEqual(
  validateCreateInput({ title: null, content: '正文' }),
  {},
  '合法创建输入没有任何错误',
)
expectValid(validateCreateInput({ title: null, content: '正文' }).title, '合法创建：标题无错误')

const bothBad = validateCreateInput({ title: '标'.repeat(81), content: '   ' })
expectInvalid(bothBad.title, '创建：超长标题报错')
expectInvalid(bothBad.content, '创建：空白正文报错')
check(hasContentValidationErrors(bothBad), '创建：有没有错误可被识别')

expectEqual(
  validateCreateInput({ title: '', content: '正文' }),
  {},
  '空字符串标题在创建时合法',
)

// ---- 编辑：只校验实际提交的字段 ----

expectEqual(validateUpdateInput({}), {}, '空 PATCH 没有任何错误')
expectEqual(
  validateUpdateInput({ title: '新标题' }),
  {},
  '只改标题时不校验正文（旧正文超长/空白也不拦）',
)
expectEqual(
  validateUpdateInput({ journal_date: '2026-10-01' }),
  {},
  '只改日期时不校验标题与正文',
)
expectEqual(
  validateUpdateInput({ title: null }),
  {},
  '显式清空标题（null）合法',
)
expectInvalid(
  validateUpdateInput({ content: '' }).content,
  '编辑时把正文清空会被拒绝',
)
expectInvalid(
  validateUpdateInput({ content: '   ' }).content,
  '编辑时提交纯空白正文会被拒绝',
)
expectInvalid(
  validateUpdateInput({ title: '标'.repeat(81) }).title,
  '编辑时提交超长标题会被拒绝',
)
expectInvalid(
  validateUpdateInput({ content: 'a'.repeat(50_001) }).content,
  '编辑时提交超长正文会被拒绝',
)

const bothUpdateBad = validateUpdateInput({
  title: '标'.repeat(81),
  content: ' ',
})
expectInvalid(bothUpdateBad.title, '编辑：超长标题报错')
expectInvalid(bothUpdateBad.content, '编辑：空白正文报错')

// ---- 错误文案 ----

expectEqual(
  formatContentValidationErrors({}),
  '',
  '没有错误时文案为空',
)
check(
  formatContentValidationErrors({ content: '坏' }).includes('正文'),
  '文案里带字段名（正文）',
)
check(
  formatContentValidationErrors({ title: '坏', content: '坏' }).includes('标题'),
  '多字段错误都会被拼进来',
)

// 结论输出保持 ASCII，避免终端编码带来的干扰。
console.log(`contentValidation: ${passed} assertions passed`)

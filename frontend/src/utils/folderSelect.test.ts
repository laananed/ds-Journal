/**
 * Folder 选择器值域转换的纯逻辑测试（Stage 2 / S2-T08）。
 *
 * 不引入测试框架，直接运行：
 *
 *   node --experimental-strip-types src/utils/folderSelect.test.ts
 *
 * 断言只用 `throw`；调用的是 `folderSelect.ts` 里的真实函数。
 */

import { folderIdToSelectValue, selectValueToFolderId } from './folderSelect.ts'

let passed = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${label}：期望 ${expectedText}，实际 ${actualText}`)
  }
  passed += 1
}

// ---- folderIdToSelectValue：null 显示为空串，数字转字符串 ----

expectEqual(folderIdToSelectValue(null), '', 'null（无 Folder）显示为空串')
expectEqual(folderIdToSelectValue(0), '0', 'id 0 转成字符串 "0"')
expectEqual(folderIdToSelectValue(7), '7', '普通 id 转成字符串')
expectEqual(folderIdToSelectValue(12345), '12345', '大 id 原样转换')

// ---- selectValueToFolderId：空串是移出 Folder，其余转数字 ----

expectEqual(selectValueToFolderId(''), null, '空串（无 Folder 选项）转成 null')
expectEqual(selectValueToFolderId('0'), 0, '"0" 转回数字 0')
expectEqual(selectValueToFolderId('7'), 7, '"7" 转回数字 7')

// ---- 两个方向互逆：草稿值经选择器往返后保持不变 ----

for (const id of [null, 1, 42, 999999]) {
  expectEqual(selectValueToFolderId(folderIdToSelectValue(id)), id, `往返保持不变：${JSON.stringify(id)}`)
}

console.log(`folderSelect: ${passed} assertions passed`)

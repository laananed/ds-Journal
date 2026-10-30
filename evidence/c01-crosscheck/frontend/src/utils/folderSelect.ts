/**
 * Folder 编辑的纯逻辑（Stage 2 / S2-T08）。
 *
 * Folder 选择器的值域是字符串（`<select>` 只有字符串值），
 * 而草稿与请求里是 `number | null`。两个方向各一个函数，
 * 保证「无 Folder」在界面上统一用空串表示。
 *
 * 本文件不依赖 React、不发请求，可用 `node --experimental-strip-types` 直接测试。
 */

/** 草稿值 → `<select>` 的 value：null 显示为空串（无 Folder）。 */
export function folderIdToSelectValue(folderId: number | null): string {
  return folderId === null ? '' : String(folderId)
}

/** `<select>` 的 value → 草稿值：空串表示移出 Folder（显式提交 null）。 */
export function selectValueToFolderId(value: string): number | null {
  return value === '' ? null : Number(value)
}

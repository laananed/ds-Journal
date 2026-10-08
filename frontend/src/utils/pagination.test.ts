import { pageCount, nearestValidPage } from './pagination.ts'
let passed = 0
function equal(actual: number, expected: number, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`)
  passed += 1
}
for (const [total, pages] of [[0, 1], [1, 1], [20, 1], [21, 2], [40, 2], [41, 3]]) {
  equal(pageCount(total), pages, `pages for ${total} records`)
}
equal(nearestValidPage(2, 20), 1, 'last page disappears after deletion')
equal(nearestValidPage(3, 21), 2, 'return nearest valid page')
equal(nearestValidPage(8, 0), 1, 'empty result uses first page')
equal(nearestValidPage(1, 41), 1, 'valid current page stays')
equal(nearestValidPage(2, 41), 2, 'second page stays')
console.log(`pagination: ${passed} assertions passed`)

/** 展示时稳定地将已完成目标置底，不改变正文及答案。 */
export function goalsForDisplay<T extends { checked: boolean }>(goals: readonly T[]): T[] {
  return [...goals.filter(goal => !goal.checked), ...goals.filter(goal => goal.checked)]
}

/** 仅依据服务端写入的关联身份，不根据目标文字猜测重连。 */
export function reviewSourceAvailable(review: { link_id: string | null }): boolean {
  return review.link_id !== null
}

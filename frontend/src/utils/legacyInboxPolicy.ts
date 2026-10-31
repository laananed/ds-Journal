/** New requests use Journal; historical requests remain independently recoverable. */
export function allowNewReview(sources: ReadonlyArray<{ type: string }>): boolean {
  return sources.every(source => source.type === 'journal')
}

export function allowNewAiCall(recoveryOnly: boolean): boolean {
  return !recoveryOnly
}

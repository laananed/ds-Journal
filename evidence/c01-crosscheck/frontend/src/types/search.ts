import type { FilePage, FileType } from './file'
import type { Inbox } from './inbox'
import type { Insight } from './insight'
import type { Journal } from './journal'

export type SearchFilter = 'all' | FileType
export type SearchItem = Journal | Inbox | Insight
export type SearchPageData = FilePage<SearchItem>
export interface SearchConditions { q: string; type: SearchFilter; page: number }

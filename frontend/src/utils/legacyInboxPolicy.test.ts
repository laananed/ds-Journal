import { allowNewReview, allowNewAiCall } from './legacyInboxPolicy.ts'

if (!allowNewReview([{ type: 'journal' }])) throw new Error('Journal must remain usable')
if (allowNewReview([{ type: 'journal' }, { type: 'inbox' }])) throw new Error('mixed sources must be blocked')
if (allowNewReview([{ type: 'inbox' }])) throw new Error('historical source must be blocked')
if (allowNewAiCall(true) || !allowNewAiCall(false)) throw new Error('recovery-only must not create calls')

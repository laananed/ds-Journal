import type { Journal } from './journal'
export interface BusinessDay { timezone: 'Asia/Shanghai'; day_start_hour: 4; server_time: string; business_date: string }
export interface Rituals { journal_date: string; set: Journal | null; end: Journal | null }
export interface RitualQuestion { id: string; text: string }
export interface RitualTemplates { set: { questions: RitualQuestion[]; revision: number }; end: { questions: RitualQuestion[]; revision: number } }

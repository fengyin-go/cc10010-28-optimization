/** 编排调度的本地持久化：计划和规则、执行批次、任务落账三者分开存，避免互相覆盖。 */
import { getScheduleSeed, rebuildScheduleSeed } from './schedule-seed'
import type { ExecutionBatch, ScheduleState, TaskLedgerEntry } from './schedule-types'

export const SCHEDULE_STORAGE_KEY = 'lake-govern-config:schedule'
export const SCHEDULE_STORE_VERSION = 1

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sanitizeBatch(batch: ExecutionBatch): ExecutionBatch {
  return {
    ...batch,
    attempt: Number(batch.attempt) || 1,
    maxAttempts: Number(batch.maxAttempts) || 1,
    ruleVersion: Number(batch.ruleVersion) || 0,
  }
}

function migrate(raw: unknown): ScheduleState | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<ScheduleState>
  if (!Array.isArray(candidate.plans) || !Array.isArray(candidate.rules)) return null
  if (!Array.isArray(candidate.batches) || !Array.isArray(candidate.ledger)) return null
  return {
    version: SCHEDULE_STORE_VERSION,
    plans: candidate.plans,
    rules: candidate.rules,
    batches: candidate.batches.map(sanitizeBatch),
    ledger: candidate.ledger,
  }
}

function readStorage(): ScheduleState {
  const fallback = getScheduleSeed()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(SCHEDULE_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = migrate(JSON.parse(raw))
    if (!parsed) throw new Error('编排调度本地数据格式不认识')
    return parsed
  } catch {
    window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: ScheduleState | null = null

export function getScheduleState(): ScheduleState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 丢掉内存缓存，下次访问重新从 localStorage 读取（测试与「重新统计」按钮用）。 */
export function clearScheduleCache(): void {
  cache = null
}

export function saveScheduleState(next: ScheduleState): void {
  const payload: ScheduleState = {
    version: SCHEDULE_STORE_VERSION,
    plans: next.plans,
    rules: next.rules,
    batches: next.batches,
    ledger: next.ledger,
  }
  cache = payload
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(payload))
  }
}

export function resetScheduleState(): ScheduleState {
  const seed = rebuildScheduleSeed()
  saveScheduleState(seed)
  return clone(seed)
}

export function nextId(list: { id: number }[]): number {
  return list.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

export function nextBatchCode(batches: ExecutionBatch[]): string {
  const max = batches.reduce((value, batch) => {
    const matched = /^EXE-(\d+)$/.exec(batch.batchCode)
    return matched ? Math.max(value, Number(matched[1])) : value
  }, 0)
  return `EXE-${String(max + 1).padStart(4, '0')}`
}

export function nextLedgerId(ledger: TaskLedgerEntry[]): number {
  return nextId(ledger)
}

/**
 * 调度表达式与时间窗口内核：把 5 段 cron 表达式解释成「窗口边界」，供补偿计算使用。
 *
 * 支持范围（分钟级）：
 *   * * * * *          每分钟
 *   *\/15 * * * *      每 15 分钟
 *   0 * * * *          每小时
 *   30 *\/6 * * *      每 6 小时的 30 分
 *   0 2 * * *          每天 02:00
 *   0 2 * * 1-5        工作日 02:00（日/周/月约束走逐日扫描）
 *   0 0 1 * *          每月 1 日 00:00
 * 另外接受 @hourly / @daily / @weekly / @monthly / @yearly 别名。
 * 秒级表达式不支持，解析时会明确报错。
 */

const DAY_SECONDS = 24 * 60 * 60

type CronField =
  | { kind: 'wildcard' }
  | { kind: 'every'; step: number }
  | { kind: 'fixed'; value: number }
  | { kind: 'list'; values: number[] }

type CronFields = {
  minute: CronField
  hour: CronField
  dom: CronField
  month: CronField
  dow: CronField
}

export type ScheduleExpressionSpec = {
  raw: string
  normalized: string
  label: string
  /** 等间隔边界步长；为空表示需要按日历逐日扫描。 */
  stepSeconds: number | null
  /** 单次调度覆盖的窗口长度（分钟级表达式）。 */
  intradaySeconds: number | null
  hasDateConstraints: boolean
  matches: (date: Date) => boolean
  windowSeconds: (startIso: string) => number
  firstStartAtOrAfter: (iso: string) => string | null
  nextStartAfter: (iso: string) => string | null
  listStarts: (fromIso: string, untilIsoExclusive: string, cap?: number) => string[]
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
}

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

export function isValidIso(value: string): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false
  return !Number.isNaN(new Date(value).getTime())
}

export function toDate(value: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`时间格式不正确：${value}`)
  }
  return date
}

export function toIso(date: Date): string {
  return date.toISOString()
}

export function addSeconds(iso: string, seconds: number): string {
  return toIso(new Date(toDate(iso).getTime() + seconds * 1000))
}

export function diffSeconds(laterIso: string, earlierIso: string): number {
  return Math.round((toDate(laterIso).getTime() - toDate(earlierIso).getTime()) / 1000)
}

export function localDayStartDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function buildLocalDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month, day, hour, minute, 0, 0)
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地时间展示，避免把 UTC 的 Z 直接甩给值班同学。 */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** datetime-local 输入框需要的格式：YYYY-MM-DDTHH:mm。 */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromLocalInputValue(value: string): string {
  return new Date(value).toISOString()
}

function parseNumericField(text: string, min: number, max: number, fieldName: string): CronField {
  if (text === '*') return { kind: 'wildcard' }
  const every = /^\*\/(\d+)$/.exec(text)
  if (every) {
    const step = Number(every[1])
    if (!Number.isInteger(step) || step < 1 || step > max) {
      throw new Error(`${fieldName} 的步长「${text}」超出范围（1-${max}）`)
    }
    return { kind: 'every', step }
  }
  if (text.includes(',')) {
    const values = text.split(',').map((item) => Number(item.trim()))
    if (values.some((value) => !Number.isInteger(value) || value < min || value > max)) {
      throw new Error(`${fieldName} 的取值「${text}」超出范围（${min}-${max}）`)
    }
    return { kind: 'list', values }
  }
  const value = Number(text)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${fieldName} 的取值「${text}」超出范围（${min}-${max}）`)
  }
  return { kind: 'fixed', value }
}

function parseDowField(text: string): CronField {
  if (text === '*') return { kind: 'wildcard' }
  const every = /^\*\/(\d+)$/.exec(text)
  if (every) {
    const step = Number(every[1])
    if (!Number.isInteger(step) || step < 1 || step > 7) {
      throw new Error(`星期字段的步长「${text}」超出范围（1-7）`)
    }
    return { kind: 'every', step }
  }
  const values: number[] = []
  for (const part of text.split(',')) {
    const token = part.trim().toLowerCase()
    const range = /^([0-9]+)-([0-9]+)$/.exec(token)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to || from < 0 || to > 7) {
        throw new Error(`星期字段的区间「${token}」不合法`)
      }
      for (let value = from; value <= to; value += 1) values.push(value === 7 ? 0 : value) // 7 也表示周日
      continue
    }
    if (token in DOW_NAMES) {
      values.push(DOW_NAMES[token])
      continue
    }
    const numeric = Number(token)
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 7) {
      throw new Error(`星期字段的取值「${part}」不合法（0-6 或 sun-sat）`)
    }
    values.push(numeric === 7 ? 0 : numeric)
  }
  return { kind: 'list', values: [...new Set(values)] }
}

function parseFields(expression: string): CronFields {
  const raw = expression.trim()
  if (raw === '') throw new Error('调度表达式不能为空')
  const normalizedRaw = ALIASES[raw.toLowerCase()] ?? raw
  const parts = normalizedRaw.split(/\s+/)
  if (parts.length === 6) {
    throw new Error('暂不支持带秒的 6 段表达式，请使用分钟级 5 段表达式')
  }
  if (parts.length !== 5) {
    throw new Error(`调度表达式需要 5 段（分 时 日 月 周），当前为 ${parts.length} 段`)
  }
  return {
    minute: parseNumericField(parts[0], 0, 59, '分钟'),
    hour: parseNumericField(parts[1], 0, 23, '小时'),
    dom: parseNumericField(parts[2], 1, 31, '日期'),
    month: parseNumericField(parts[3], 1, 12, '月份'),
    dow: parseDowField(parts[4]),
  }
}

function numericMatch(field: CronField, value: number, oneBased = false): boolean {
  switch (field.kind) {
    case 'wildcard':
      return true
    case 'fixed':
      return field.value === value
    case 'list':
      return field.values.includes(value)
    case 'every':
      return (oneBased ? value - 1 : value) % field.step === 0
    default:
      return false
  }
}

function isWildcard(field: CronField): boolean {
  return field.kind === 'wildcard'
}

function matchDate(fields: CronFields, date: Date): boolean {
  return (
    date.getSeconds() === 0 &&
    numericMatch(fields.minute, date.getMinutes()) &&
    numericMatch(fields.hour, date.getHours()) &&
    numericMatch(fields.dom, date.getDate(), true) &&
    numericMatch(fields.month, date.getMonth() + 1, true) &&
    numericMatch(fields.dow, date.getDay())
  )
}

function dateConstraintsWildcard(fields: CronFields): boolean {
  return isWildcard(fields.dom) && isWildcard(fields.month) && isWildcard(fields.dow)
}

function uniformStep(fields: CronFields): number | null {
  if (!dateConstraintsWildcard(fields)) return null
  const { minute, hour } = fields
  if (isWildcard(hour)) {
    if (isWildcard(minute)) return 60
    if (minute.kind === 'every' && 60 % minute.step === 0) return minute.step * 60
    // 固定分钟配任意小时：每小时一次的等间隔边界；分钟列表无法用单一等间隔表示，退回日历扫描。
    if (minute.kind === 'fixed') return 3600
    return null
  }
  // 只有「分钟固定 + 小时步长/固定」才能用等间隔步长，其余交给日历扫描。
  if (minute.kind !== 'fixed') return null
  if (hour.kind === 'every' && 24 % hour.step === 0) return hour.step * 3600
  if (hour.kind === 'fixed') return DAY_SECONDS
  return null
}

function intradaySeconds(fields: CronFields): number | null {
  if (isWildcard(fields.minute)) return 60
  if (fields.minute.kind === 'every') return fields.minute.step * 60
  // 分钟固定：窗口从该分钟顺延到下一个整点边界。
  if (isWildcard(fields.hour)) return 3600
  if (fields.hour.kind === 'every') return fields.hour.step * 3600
  if (fields.hour.kind === 'fixed') return DAY_SECONDS
  return null
}

function anchorSeconds(fields: CronFields, step: number): number {
  // 等间隔只用于「无日历约束」的表达式：
  //  - 每小时/每 N 小时：锚点取当天零点 + 固定分钟，0 */6 * * * 与 30 */6 * * * 都能对齐网格；
  //  - 每天固定时刻（0 3 * * *）：锚点必须带上小时，否则会被错误地按九点对齐。
  const minuteOffset = fields.minute.kind === 'fixed' ? fields.minute.value * 60 : 0
  if (step >= DAY_SECONDS && fields.hour.kind === 'fixed') {
    return fields.hour.value * 3600 + minuteOffset
  }
  if (step <= DAY_SECONDS) {
    return minuteOffset
  }
  return 0
}

function allowedValues(field: CronField, max: number, oneBased = false): number[] {
  const values: number[] = []
  if (field.kind === 'wildcard') {
    for (let value = oneBased ? 1 : 0; value <= max; value += 1) values.push(value)
  } else if (field.kind === 'fixed') {
    values.push(field.value)
  } else if (field.kind === 'list') {
    values.push(...field.values)
  } else {
    for (let value = oneBased ? 1 : 0; value <= max; value += 1) {
      if ((oneBased ? value - 1 : value) % field.step === 0) values.push(value)
    }
  }
  return values
}

function calendarMatchesDay(fields: CronFields, date: Date): boolean {
  return (
    numericMatch(fields.dom, date.getDate(), true) &&
    numericMatch(fields.month, date.getMonth() + 1, true) &&
    numericMatch(fields.dow, date.getDay())
  )
}

function calendarFirstStartAtOrAfter(fields: CronFields, fromIso: string): string | null {
  const from = toDate(fromIso)
  const fromMs = from.getTime()
  const day = localDayStartDate(from)
  const hours = allowedValues(fields.hour, 23)
  const minutes = allowedValues(fields.minute, 59)
  for (let offset = 0; offset <= 800; offset += 1) {
    const current = new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, 0, 0, 0, 0)
    if (calendarMatchesDay(fields, current)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = buildLocalDate(
            current.getFullYear(),
            current.getMonth(),
            current.getDate(),
            hour,
            minute,
          )
          if (candidate.getTime() >= fromMs) return toIso(candidate)
        }
      }
    }
  }
  return null
}

function describe(fields: CronFields, normalized: string): string {
  const { minute, hour, dom, month, dow } = fields
  const hhmm = () => {
    if (hour.kind === 'fixed' && minute.kind === 'fixed') {
      return `${pad(hour.value)}:${pad(minute.value)}`
    }
    return null
  }
  if (!dateConstraintsWildcard(fields)) {
    const time = hhmm()
    const timeText = time ? ` ${time}` : ''
    if (dow.kind !== 'wildcard') {
      if (dow.kind === 'list') {
        const names = dow.values.map((value) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][value])
        return `每周 ${names.join('、')}${timeText}`
      }
      return `每周（${dow.kind === 'every' ? `每 ${dow.step} 天` : '指定星期'}）${timeText}`
    }
    if (dom.kind === 'fixed') {
      return `每月 ${dom.value} 日${timeText}`
    }
    if (dom.kind !== 'wildcard') {
      return `按日历（日 ${normalized.split(' ')[2]}）${timeText}`
    }
    if (month.kind !== 'wildcard') {
      return `按日历（月 ${normalized.split(' ')[3]}）${timeText}`
    }
  }
  if (isWildcard(hour)) {
    if (isWildcard(minute)) return '每分钟'
    if (minute.kind === 'every') return `每 ${minute.step} 分钟`
    if (minute.kind === 'fixed') return `每小时第 ${minute.value} 分`
    return `每小时（分 ${normalized.split(' ')[0]}）`
  }
  if (minute.kind === 'fixed' && hour.kind === 'fixed') {
    return `每天 ${pad(hour.value)}:${pad(minute.value)}`
  }
  if (minute.kind === 'fixed' && hour.kind === 'every') {
    return `每 ${hour.step} 小时（第 ${minute.value} 分）`
  }
  return `按日历 ${normalized}`
}

export function parseScheduleExpression(expression: string): ScheduleExpressionSpec {
  const fields = parseFields(expression)
  const normalized = [
    fieldText(fields.minute),
    fieldText(fields.hour),
    fieldText(fields.dom),
    fieldText(fields.month),
    fieldText(fields.dow),
  ].join(' ')
  const hasDateConstraints = !dateConstraintsWildcard(fields)
  const stepSeconds = uniformStep(fields)
  // 只有不带日期/星期约束的表达式才有固定长度窗口；按月/按周触发的窗口长度是到下一个边界的间隔。
  const intraday = hasDateConstraints ? null : intradaySeconds(fields)

  const firstStartAtOrAfter = (iso: string): string | null => {
    if (!isValidIso(iso)) return null
    if (stepSeconds === null) {
      return calendarFirstStartAtOrAfter(fields, iso)
    }
    const from = toDate(iso)
    const anchor = localDayStartDate(from).getTime() + anchorSeconds(fields, stepSeconds) * 1000
    const diff = from.getTime() - anchor
    const steps = diff <= 0 ? 0 : Math.ceil(diff / (stepSeconds * 1000))
    const candidate = new Date(anchor + steps * stepSeconds * 1000)
    // 候选落在当天锚点之外（跨日）时，等间隔步长能整除一天，因此仍然对齐表达式。
    return toIso(candidate)
  }

  const nextStartAfter = (iso: string): string | null => {
    if (!isValidIso(iso)) return null
    return firstStartAtOrAfter(addSeconds(iso, 1))
  }

  const windowSeconds = (startIso: string): number => {
    if (intraday !== null) return intraday
    if (!hasDateConstraints && stepSeconds !== null) return stepSeconds
    const next = nextStartAfter(startIso)
    if (!next) return DAY_SECONDS
    return Math.max(60, diffSeconds(next, startIso))
  }

  const listStarts = (fromIso: string, untilIsoExclusive: string, cap = 500): string[] => {
    const starts: string[] = []
    if (!isValidIso(fromIso) || !isValidIso(untilIsoExclusive)) return starts
    const untilMs = toDate(untilIsoExclusive).getTime()
    let cursor = firstStartAtOrAfter(fromIso)
    while (cursor && toDate(cursor).getTime() < untilMs && starts.length < cap) {
      starts.push(cursor)
      cursor = nextStartAfter(cursor)
    }
    return starts
  }

  return {
    raw: expression,
    normalized,
    label: describe(fields, normalized),
    stepSeconds,
    intradaySeconds: intraday,
    hasDateConstraints,
    matches: (date: Date) => matchDate(fields, date),
    windowSeconds,
    firstStartAtOrAfter,
    nextStartAfter,
    listStarts,
  }
}

function fieldText(field: CronField): string {
  switch (field.kind) {
    case 'wildcard':
      return '*'
    case 'every':
      return `*/${field.step}`
    case 'fixed':
      return String(field.value)
    case 'list':
      return field.values.join(',')
    default:
      return '*'
  }
}

export function tryParseScheduleExpression(expression: string): { spec: ScheduleExpressionSpec | null; error: string } {
  try {
    return { spec: parseScheduleExpression(expression), error: '' }
  } catch (error) {
    return { spec: null, error: error instanceof Error ? error.message : '调度表达式解析失败' }
  }
}


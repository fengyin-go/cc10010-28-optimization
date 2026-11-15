/**
 * 漏触发补偿的核心算法（纯函数，不碰 localStorage）。
 *
 * 数据流：启用规则 + 调度表达式 → 期望窗口网格 → 上次完成位置 → 逐窗口比对已有执行批次
 *        → 并发上限裁剪 → 失败处理决定「补、重试、跳过还是阻塞」→ 真正缺失的窗口。
 *
 * 三条硬约束：
 *  1. 同一 (计划, 任务, 窗口) 只允许一条有效执行批次；已排队/已完成的一律不再生成。
 *  2. 已完成的窗口不重跑；补偿失败后从缺失窗口继续，而不是从计划起点整体重跑。
 *  3. 规则冲突以当前启用规则为准；历史批次上保存的规则快照不随规则变更而改写。
 */
import { formatDateTime, parseScheduleExpression, tryParseScheduleExpression } from './schedule-time'
import type {
  ActiveRuleResolution,
  CompensationPreview,
  ExecutionBatch,
  ExecutionBatchStatus,
  ManualCoverageItem,
  MissingWindowAction,
  MissingWindowItem,
  SchedulePlan,
  ScheduleRule,
  ScheduleState,
  ScheduleTask,
  TaskCompensationView,
} from './schedule-types'

export const SUCCESS_STATUS: ExecutionBatchStatus = '已完成'
export const FAILED_STATUS: ExecutionBatchStatus = '已失败'
export const IN_FLIGHT_STATUSES: ExecutionBatchStatus[] = ['已排队', '运行中']
export const MAX_WINDOWS_PER_PREVIEW = 240

export function isInFlight(status: ExecutionBatchStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(status)
}

/** 计划的最大尝试次数：只有「重试」策略才会给失败批次留出重试额度。 */
export function maxAttemptsFor(plan: SchedulePlan): number {
  return plan.failurePolicy === '重试' ? Math.max(1, plan.retryLimit + 1) : 1
}

export function enabledTasks(plan: SchedulePlan): ScheduleTask[] {
  return plan.tasks.filter((task) => task.enabled)
}

export function enabledRulesFor(rules: ScheduleRule[], planId: number): ScheduleRule[] {
  return rules
    .filter((rule) => rule.planId === planId && rule.status === '已启用')
    .sort((left, right) => {
      if (right.version !== left.version) return right.version - left.version
      const leftFrom = new Date(left.effectiveFrom).getTime()
      const rightFrom = new Date(right.effectiveFrom).getTime()
      if (rightFrom !== leftFrom) return rightFrom - leftFrom
      return right.id - left.id
    })
}

/**
 * 新旧规则冲突时以「当前已启用规则」为准：同一计划下多条启用规则按版本号取最新，
 * 版本号相同时取生效时间更晚的，再相同取登记更晚的。历史规则仍留在规则表里，
 * 历史批次继续沿用创建时的规则快照。
 */
export function resolveActiveRule(rules: ScheduleRule[], planId: number): ActiveRuleResolution {
  const enabledCandidates = enabledRulesFor(rules, planId)
  if (enabledCandidates.length === 0) {
    return {
      rule: null,
      decision: '没有已启用的调度规则，无法计算补偿窗口',
      enabledCandidates,
    }
  }
  const rule = enabledCandidates[0]
  if (enabledCandidates.length === 1) {
    return {
      rule,
      decision: `当前启用规则 v${rule.version}（${rule.expression}）`,
      enabledCandidates,
    }
  }
  const olderText = enabledCandidates
    .slice(1)
    .map((item) => `v${item.version}（${item.expression}）`)
    .join('、')
  return {
    rule,
    decision: `检测到 ${enabledCandidates.length} 条已启用规则，以版本号更高的 v${rule.version}（${rule.expression}）为准；${olderText} 仍保留，但不再用于生成新批次`,
    enabledCandidates,
  }
}

/** 同一计划 + 任务 + 窗口可能留下多条批次（历史上的重试/手工批次），按更新时间取最新一条。 */
export function batchesForWindow(
  batches: ExecutionBatch[],
  planId: number,
  taskId: number,
  windowStart: string,
): ExecutionBatch[] {
  return batches
    .filter(
      (batch) =>
        batch.planId === planId && batch.taskId === taskId && batch.windowStart === windowStart,
    )
    .sort((left, right) => {
      const leftAt = new Date(left.updatedAt).getTime()
      const rightAt = new Date(right.updatedAt).getTime()
      if (rightAt !== leftAt) return rightAt - leftAt
      return right.id - left.id
    })
}

export function latestBatchForWindow(
  batches: ExecutionBatch[],
  planId: number,
  taskId: number,
  windowStart: string,
): ExecutionBatch | null {
  return batchesForWindow(batches, planId, taskId, windowStart)[0] ?? null
}

/** 与 [start, end) 有重叠、但窗口起点不是 start 的批次（旧规则网格或跨网格手工批次）。 */
export function overlappingBatches(
  batches: ExecutionBatch[],
  planId: number,
  taskId: number,
  start: string,
  end: string,
): ExecutionBatch[] {
  const startMs = new Date(start).getTime()
  const endMs = new Date(end).getTime()
  return batches
    .filter((batch) => {
      if (batch.planId !== planId || batch.taskId !== taskId) return false
      if (batch.windowStart === start) return false
      const batchStart = new Date(batch.windowStart).getTime()
      return batchStart >= startMs && batchStart < endMs
    })
    .sort((left, right) => {
      const leftAt = new Date(left.updatedAt).getTime()
      const rightAt = new Date(right.updatedAt).getTime()
      if (rightAt !== leftAt) return rightAt - leftAt
      return right.id - left.id
    })
}

export function inFlightCount(batches: ExecutionBatch[], planId: number): number {
  return batches.filter((batch) => batch.planId === planId && isInFlight(batch.status)).length
}

export function lastSucceededWindow(
  batches: ExecutionBatch[],
  planId: number,
  taskId: number,
): string | null {
  const windows = batches
    .filter(
      (batch) =>
        batch.planId === planId && batch.taskId === taskId && batch.status === SUCCESS_STATUS,
    )
    .map((batch) => batch.windowStart)
    .sort()
  return windows.length > 0 ? windows[windows.length - 1] : null
}

/**
 * 窗口是否已被完全覆盖：每个启用任务在该窗口上都有完成批次，
 * 或者窗口内有起点不同但覆盖该窗口的完成批次（旧规则网格、手工批次）。
 */
function windowFullyCovered(
  batches: ExecutionBatch[],
  planId: number,
  tasks: ScheduleTask[],
  start: string,
  end: string,
): boolean {
  if (tasks.length === 0) return true
  return tasks.every((task) => {
    const exact = latestBatchForWindow(batches, planId, task.id, start)
    if (exact && exact.status === SUCCESS_STATUS) return true
    if (exact && isInFlight(exact.status)) return false
    return overlappingBatches(batches, planId, task.id, start, end).some(
      (batch) => batch.status === SUCCESS_STATUS,
    )
  })
}

function alignToGrid(spec: ReturnType<typeof parseScheduleExpression>, iso: string): string {
  return spec.firstStartAtOrAfter(iso) ?? iso
}

function fmt(iso: string): string {
  return formatDateTime(iso)
}

/**
 * 计算一次补偿预览：真正缺失的窗口、要重试的窗口、被跳过的窗口，以及并发/失败处理带来的裁剪。
 * 该函数只读，不产生任何执行批次，页面可以放心地反复调用。
 */
export function buildCompensationPreview(
  state: Pick<ScheduleState, 'plans' | 'rules' | 'batches'>,
  planId: number,
  now: Date = new Date(),
): CompensationPreview | null {
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) return null
  const nowIso = now.toISOString()
  const resolution = resolveActiveRule(state.rules, planId)
  const errors: string[] = []
  const warnings: string[] = []
  const tasks = enabledTasks(plan)

  if (tasks.length === 0) {
    warnings.push('计划没有启用中的任务，补偿不会生成执行批次')
  }

  const base: CompensationPreview = {
    planId: plan.id,
    planCode: plan.code,
    planName: plan.name,
    now: nowIso,
    activeRule: resolution.rule,
    ruleDecision: resolution.decision,
    cursorWindow: null,
    cursorReason: '',
    expectedWindows: [],
    perTask: tasks.map((task) => ({
      taskId: task.id,
      taskCode: task.taskCode,
      taskName: task.taskName,
      lastSucceededWindow: lastSucceededWindow(state.batches, plan.id, task.id),
      missing: [],
      skipped: [],
    })),
    planned: [],
    deferred: [],
    ignoredBeforeCursor: 0,
    manualCoverage: [],
    concurrency: {
      limit: plan.concurrencyLimit,
      inFlight: inFlightCount(state.batches, plan.id),
      available: 0,
      plannedCount: 0,
      deferredCount: 0,
    },
    failure: {
      policy: plan.failurePolicy,
      retryLimit: plan.retryLimit,
      blocked: false,
      boundaryWindow: null,
      note: '',
    },
    errors,
    warnings,
  }

  if (!resolution.rule) {
    errors.push('计划没有启用中的调度规则，请先启用一条规则再执行补偿')
    return base
  }
  const parsed = tryParseScheduleExpression(resolution.rule.expression)
  if (!parsed.spec) {
    errors.push(`启用规则 v${resolution.rule.version} 的表达式无法解析：${parsed.error}`)
    return base
  }
  const spec = parsed.spec
  const ruleStart = spec.firstStartAtOrAfter(plan.startAt) ?? plan.startAt

  if (plan.status === '已停止') {
    warnings.push('计划当前为「已停止」，本次补偿只在页面上预览，建议先启动编排')
  }
  if (resolution.enabledCandidates.length > 1) {
    warnings.push('存在多条启用中的规则，本次按最新版本计算窗口；历史批次仍沿用各自的规则快照')
  }

  // 多取一个窗口用于判断「是否还有更多窗口没检查」，避免把截断当成完整列表。
  const expectedWindows = spec
    .listStarts(ruleStart, nowIso, MAX_WINDOWS_PER_PREVIEW + 1)
    .map((start) => ({ start, end: spec.nextStartAfter(start) ?? start }))
  const truncated = expectedWindows.length > MAX_WINDOWS_PER_PREVIEW
  base.expectedWindows = expectedWindows

  // 1. 补偿起点：上次完成位置是「已推进」的下限，从这里开始复查即可覆盖该窗口内的失败任务；
  //    没有完成记录时才退到最早的未完成窗口，避免从规则起点把历史窗口全部重扫。
  const planFloor = plan.lastCompletedWindow ? alignToGrid(spec, plan.lastCompletedWindow) : null
  const earliestIncomplete = expectedWindows.find(
    (window) => !windowFullyCovered(state.batches, plan.id, tasks, window.start, window.end),
  )
  let cursor: string
  let cursorReason: string
  if (planFloor) {
    cursor = planFloor
    cursorReason = `从计划记录的上次完成位置 ${fmt(planFloor)} 开始复查：该窗口及之后的缺口才会生成批次，更早的窗口视为已推进`
  } else if (earliestIncomplete) {
    cursor = earliestIncomplete.start
    cursorReason = `计划没有完成记录，从最早的未完成窗口 ${fmt(cursor)} 开始`
  } else {
    cursor = ruleStart
    cursorReason = `计划没有完成记录，从规则生效后的首个窗口 ${fmt(ruleStart)} 开始`
  }
  base.cursorWindow = cursor
  base.cursorReason = cursorReason

  for (const window of expectedWindows) {
    if (window.start < cursor) base.ignoredBeforeCursor += 1
  }
  const windows = expectedWindows
    .filter((window) => window.start >= cursor)
    .slice(0, MAX_WINDOWS_PER_PREVIEW)
  if (truncated) {
    warnings.push(`待检查窗口超过 ${MAX_WINDOWS_PER_PREVIEW} 个，本次只检查最早的 ${MAX_WINDOWS_PER_PREVIEW} 个，执行后可继续补偿`)
  }
  if (windows.length === 0) {
    warnings.push('当前没有已到期的窗口需要补偿')
  }

  const perTaskMap = new Map<number, TaskCompensationView>(
    base.perTask.map((view) => [view.taskId, view]),
  )
  const usedSlots = base.concurrency.inFlight
  const available = Math.max(0, plan.concurrencyLimit - usedSlots)
  base.concurrency.available = available
  let scheduled = 0

  let blockedAt: string | null = null

  for (const window of windows) {
    const start = window.start
    const end = window.end
    if (blockedAt && start > blockedAt) {
      for (const task of tasks) {
        const view = perTaskMap.get(task.id)
        if (!view) continue
        view.missing.push({
          taskId: task.id,
          taskCode: task.taskCode,
          taskName: task.taskName,
          windowStart: start,
          windowEnd: end,
          action: 'blocked',
          reason: `失败处理为「终止」，计划停在窗口 ${fmt(blockedAt)}，后续窗口暂停补偿`,
          existingBatchId: null,
        })
      }
      continue
    }

    for (const task of tasks) {
      const view = perTaskMap.get(task.id)
      if (!view) continue
      const pushSkip = (reason: string, action: MissingWindowAction = 'skip', batchId: number | null = null): void => {
        view.skipped.push({
          taskId: task.id,
          taskCode: task.taskCode,
          taskName: task.taskName,
          windowStart: start,
          windowEnd: end,
          action,
          reason,
          existingBatchId: batchId,
        })
      }
      const pushMissing = (action: MissingWindowAction, reason: string, batchId: number | null = null): void => {
        view.missing.push({
          taskId: task.id,
          taskCode: task.taskCode,
          taskName: task.taskName,
          windowStart: start,
          windowEnd: end,
          action,
          reason,
          existingBatchId: batchId,
        })
      }
      const trySchedule = (action: 'create' | 'retry', reason: string, batchId: number | null): boolean => {
        if (scheduled >= available) {
          pushMissing(
            'defer',
            available === 0
              ? `并发上限 ${plan.concurrencyLimit} 已用满（在飞 ${usedSlots}），本轮不生成`
              : `并发上限 ${plan.concurrencyLimit} 已用满（在飞 ${usedSlots} + 本轮 ${scheduled}），本轮不生成`,
            batchId,
          )
          return false
        }
        scheduled += 1
        pushMissing(action, reason, batchId)
        return true
      }

      // 1) 同一起点的批次：完成即覆盖，排队/运行即等待，失败走失败处理。
      const sameStart = latestBatchForWindow(state.batches, plan.id, task.id, start)
      if (sameStart) {
        if (sameStart.status === SUCCESS_STATUS) {
          pushSkip(
            `该窗口已有完成批次 ${sameStart.batchCode}（${sameStart.origin === 'manual' ? '手工' : '补偿'}），不重复生成`,
            'skip',
            sameStart.id,
          )
          view.lastSucceededWindow = start
          continue
        }
        if (isInFlight(sameStart.status)) {
          pushMissing(
            'defer',
            `该窗口已有${sameStart.status}批次 ${sameStart.batchCode}（${sameStart.origin === 'manual' ? '手工' : '补偿'}），等待其完成后再判断`,
            sameStart.id,
          )
          continue
        }
        // 已失败
        const attempts = Math.max(sameStart.attempt, 1)
        const maxAttempts = Math.max(sameStart.maxAttempts, maxAttemptsFor(plan))
        if (plan.failurePolicy === '跳过') {
          pushSkip(`批次 ${sameStart.batchCode} 已失败，失败处理为「跳过」，不再重试`, 'skip', sameStart.id)
          continue
        }
        if (plan.failurePolicy === '终止') {
          blockedAt = start
          base.failure.blocked = true
          base.failure.boundaryWindow = start
          pushSkip(`失败处理为「终止」：窗口 ${fmt(start)} 的批次已失败，计划停在此窗口`, 'blocked', sameStart.id)
          continue
        }
        if (attempts >= maxAttempts) {
          pushMissing(
            'blocked',
            `批次 ${sameStart.batchCode} 已失败 ${attempts} 次，达到尝试上限 ${maxAttempts}，需要人工处理`,
            sameStart.id,
          )
          continue
        }
        trySchedule(
          'retry',
          `批次 ${sameStart.batchCode} 第 ${attempts} 次失败，按「重试」策略发起第 ${attempts + 1} 次尝试`,
          sameStart.id,
        )
        continue
      }

      // 2) 起点不同但覆盖本窗口的批次（旧规则网格、跨网格手工批次或另一条规则的时间点）。
      const overlaps = overlappingBatches(state.batches, plan.id, task.id, start, end)
      if (overlaps.length > 0) {
        const covered = overlaps.find((batch) => batch.status === SUCCESS_STATUS)
        if (covered) {
          pushSkip(
            `窗口内的批次 ${covered.batchCode}（起点 ${fmt(covered.windowStart)}，${covered.origin === 'manual' ? '手工' : '补偿'}）已完成，本窗口视为已覆盖`,
            'skip',
            covered.id,
          )
          continue
        }
        const pending = overlaps.find((batch) => isInFlight(batch.status))
        if (pending) {
          pushMissing(
            'defer',
            `窗口内已有${pending.status}批次 ${pending.batchCode}（起点 ${fmt(pending.windowStart)}），等待其完成`,
            pending.id,
          )
          continue
        }
        // 只有失败批次：本窗口的数据确实没有产出，按当前规则继续补。
        const failed = overlaps[0]
        if (plan.failurePolicy === '终止') {
          blockedAt = start
          base.failure.blocked = true
          base.failure.boundaryWindow = start
          pushSkip(`失败处理为「终止」：窗口内的批次 ${failed.batchCode} 已失败，计划停在此窗口`, 'blocked', failed.id)
          continue
        }
        trySchedule(
          'create',
          `窗口内的批次 ${failed.batchCode}（起点 ${fmt(failed.windowStart)}）已失败，本窗口仍缺失，按当前规则生成`,
          null,
        )
        continue
      }

      // 3) 完全没有任何批次：真正缺失的窗口。
      if (plan.failurePolicy === '终止' && blockedAt) {
        pushMissing('blocked', `失败处理为「终止」，计划停在窗口 ${fmt(blockedAt)}，本窗口暂停补偿`, null)
        continue
      }
      const beforePlanFloor = planFloor !== null && start < planFloor
      trySchedule(
        'create',
        beforePlanFloor
          ? `计划未记录推进到本窗口（计划上次完成位置 ${fmt(planFloor)}），按缺失窗口补生成`
          : '该窗口从未生成执行批次，属于真正缺失的窗口',
        null,
      )
    }
  }

  base.perTask = base.perTask.map((view) => {
    const order = (item: MissingWindowItem): number => {
      const windowIndex = expectedWindows.findIndex((window) => window.start === item.windowStart)
      const taskIndex = tasks.findIndex((task) => task.id === item.taskId)
      return windowIndex * 1000 + taskIndex
    }
    return {
      ...view,
      missing: [...view.missing].sort((left, right) => order(left) - order(right)),
      skipped: [...view.skipped].sort((left, right) => order(left) - order(right)),
    }
  })

  for (const view of base.perTask) {
    for (const item of view.missing) {
      if (item.action === 'create' || item.action === 'retry') {
        base.planned.push(item)
      } else {
        base.deferred.push(item)
      }
    }
  }

  base.manualCoverage = analyzeManualCoverage(state.batches, plan, spec, expectedWindows, tasks)

  base.concurrency.plannedCount = base.planned.length
  base.concurrency.deferredCount = base.deferred.length
  base.failure.blocked = base.failure.blocked || blockedAt !== null
  base.failure.boundaryWindow = blockedAt ?? base.failure.boundaryWindow
  base.failure.note =
    plan.failurePolicy === '终止'
      ? blockedAt
        ? `失败处理为「终止」：窗口 ${fmt(blockedAt)} 的批次已失败，计划停在失败窗口`
        : '失败处理为「终止」：一旦有批次失败即停在失败窗口'
      : plan.failurePolicy === '跳过'
        ? '失败处理为「跳过」：失败窗口记入跳过清单，继续补偿后续窗口'
        : `失败处理为「重试」：失败窗口按尝试次数重试，最多 ${maxAttemptsFor(plan)} 次，已达上限的窗口需要人工处理`

  if (blockedAt) {
    errors.push(`存在失败批次（窗口 ${fmt(blockedAt)}），按「终止」策略暂停补偿`)
  }
  if (base.planned.length === 0 && base.deferred.length > 0) {
    warnings.push('本轮没有可生成的批次：先处理在飞批次或提高并发上限')
  }
  return base
}

/**
 * 手工批次与当前规则网格的对齐报告：
 *  - 起点正好落在当前网格：按正常覆盖判断；
 *  - 起点不在当前网格（常见于规则变更前后）：它仍会覆盖包含它的那个规则窗口，
 *    但窗口边界与规则不一致，页面上单独列出来，避免把「看起来该补」的窗口补成两份。
 */
function analyzeManualCoverage(
  batches: ExecutionBatch[],
  plan: SchedulePlan,
  spec: ReturnType<typeof parseScheduleExpression>,
  expectedWindows: { start: string; end: string }[],
  tasks: ScheduleTask[],
): ManualCoverageItem[] {
  if (tasks.length === 0) return []
  const items: ManualCoverageItem[] = []
  for (const batch of batches) {
    if (batch.planId !== plan.id || batch.origin !== 'manual') continue
    const task = tasks.find((item) => item.id === batch.taskId)
    if (!task) continue
    const window = expectedWindows.find(
      (item) => batch.windowStart >= item.start && batch.windowStart < item.end,
    )
    if (!window) continue
    const aligned = window.start === batch.windowStart
    if (batch.status !== SUCCESS_STATUS) {
      items.push({
        batchId: batch.id,
        batchCode: batch.batchCode,
        taskId: batch.taskId,
        taskCode: batch.taskCode,
        taskName: batch.taskName,
        windowStart: batch.windowStart,
        windowEnd: batch.windowEnd,
        alignedWithRule: aligned,
        coversWindowStart: window.start,
        decision: '需重新补偿',
        note: `手工批次${batch.status}，窗口数据未产出，按当前规则计算缺失窗口`,
      })
      continue
    }
    items.push({
      batchId: batch.id,
      batchCode: batch.batchCode,
      taskId: batch.taskId,
      taskCode: batch.taskCode,
      taskName: batch.taskName,
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd,
      alignedWithRule: aligned,
      coversWindowStart: window.start,
      decision: '视为已覆盖',
      note: aligned
        ? `手工批次窗口与规则窗口一致，${fmt(window.start)} 不重复生成`
        : `手工批次起点 ${fmt(batch.windowStart)} 不在当前规则网格上，仍覆盖规则窗口 ${fmt(window.start)}，该窗口不重复生成`,
    })
  }
  return items
}


/**
 * 编排调度服务层：页面只调用这里的函数，所有状态流转都集中在本地数据层。
 *
 * 核心入口：
 *  - previewCompensation：只读地算「真正缺失的窗口」，页面可反复刷新；
 *  - runCompensation：按预览生成执行批次，逐项做幂等复查，重复到达不会多生成；
 *  - submitTaskGroup：多选任务整组提交，逐条回传执行批次并按任务分别落账；
 *  - loadDownstreamJobs：跨模块下游作业清单，只放实际补偿产生的批次。
 */
import {
  SUCCESS_STATUS,
  buildCompensationPreview,
  enabledTasks,
  isInFlight,
  latestBatchForWindow,
  maxAttemptsFor,
  overlappingBatches,
  resolveActiveRule,
} from '@/data/schedule-engine'
import {
  getScheduleState,
  nextBatchCode,
  resetScheduleState,
  saveScheduleState,
} from '@/data/schedule-store'
import {
  formatDateTime,
  isValidIso,
  parseScheduleExpression,
} from '@/data/schedule-time'
import type {
  BatchActionResult,
  CompensationPreview,
  CompensationRunResult,
  DownstreamJob,
  ExecutionBatch,
  GroupSubmissionOptions,
  GroupSubmissionResult,
  MissingWindowItem,
  SchedulePlan,
  SchedulePlanOverview,
  SchedulePlanStatus,
  ScheduleRule,
  ScheduleState,
  ScheduleSummary,
  ScheduleWorkspace,
  TaskLedgerEntry,
} from '@/data/schedule-types'

const MAX_WINDOWS = 240

function planOverview(state: ScheduleState, plan: SchedulePlan, nowIso: string): SchedulePlanOverview {
  const resolution = resolveActiveRule(state.rules, plan.id)
  let preview: CompensationPreview | null = null
  let derivedCursor: string | null = null
  let missingWindowCount = 0
  if (resolution.rule) {
    preview = buildCompensationPreview(state, plan.id, new Date(nowIso))
    if (preview) {
      derivedCursor = preview.cursorWindow
      missingWindowCount = new Set(
        preview.perTask.flatMap((view) => view.missing.map((item) => item.windowStart)),
      ).size
    }
  }
  const planBatches = state.batches
    .filter((batch) => batch.planId === plan.id)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
  return {
    plan,
    activeRule: resolution.rule,
    ruleDecision: resolution.decision,
    derivedCursor,
    missingWindowCount,
    inFlightCount: planBatches.filter((batch) => isInFlight(batch.status)).length,
    lastBatchAt: planBatches[0]?.updatedAt ?? null,
  }
}

export function loadWorkspace(planId: number | null = null): ScheduleWorkspace {
  const state = getScheduleState()
  const nowIso = new Date().toISOString()
  const plans = state.plans.map((plan) => planOverview(state, plan, nowIso))
  const selected =
    (planId !== null ? state.plans.find((plan) => plan.id === planId) : undefined) ??
    state.plans[0] ??
    null
  return {
    plans,
    selectedPlan: selected,
    rules: state.rules,
    batches: state.batches,
    ledger: state.ledger,
    preview: selected ? buildCompensationPreview(state, selected.id, new Date(nowIso)) : null,
  }
}

export function loadPlans(): SchedulePlanOverview[] {
  const state = getScheduleState()
  const nowIso = new Date().toISOString()
  return state.plans.map((plan) => planOverview(state, plan, nowIso))
}

export function loadPlanBatches(planId: number): ExecutionBatch[] {
  return getScheduleState()
    .batches.filter((batch) => batch.planId === planId)
    .sort((left, right) => {
      const leftAt = new Date(left.windowStart).getTime()
      const rightAt = new Date(right.windowStart).getTime()
      if (rightAt !== leftAt) return rightAt - leftAt
      return right.id - left.id
    })
}

export function loadLedger(planId: number): TaskLedgerEntry[] {
  return getScheduleState()
    .ledger.filter((entry) => entry.planId === planId)
    .sort((left, right) => new Date(right.bookedAt).getTime() - new Date(left.bookedAt).getTime())
}

export function previewCompensation(planId: number, now: Date = new Date()): CompensationPreview | null {
  return buildCompensationPreview(getScheduleState(), planId, now)
}

function failureReasonOrNull(value: string | null | undefined): string | null {
  const text = (value ?? '').trim()
  return text === '' ? null : text
}

function bookLedger(
  state: ScheduleState,
  batch: ExecutionBatch,
  message: string,
  bookedAt: string,
): TaskLedgerEntry {
  const entry: TaskLedgerEntry = {
    id: state.ledger.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    planId: batch.planId,
    planCode: batch.planCode,
    taskId: batch.taskId,
    taskCode: batch.taskCode,
    taskName: batch.taskName,
    windowStart: batch.windowStart,
    batchId: batch.id,
    batchCode: batch.batchCode,
    status: batch.status,
    origin: batch.origin,
    ruleVersion: batch.ruleVersion,
    bookedAt,
    message,
  }
  state.ledger = [...state.ledger, entry]
  return entry
}

type CommitOutcome = {
  outcome: GroupSubmissionResult['outcome']
  batch: ExecutionBatch | null
  message: string
}

function createBatch(
  state: ScheduleState,
  plan: SchedulePlan,
  item: MissingWindowItem,
  nowIso: string,
  origin: 'compensation' | 'manual',
): ExecutionBatch {
  const rule = resolveActiveRule(state.rules, plan.id).rule
  const id = state.batches.reduce((max, batch) => Math.max(max, batch.id), 0) + 1
  const batch: ExecutionBatch = {
    id,
    batchCode: nextBatchCode(state.batches),
    planId: plan.id,
    planCode: plan.code,
    taskId: item.taskId,
    taskCode: item.taskCode,
    taskName: item.taskName,
    windowStart: item.windowStart,
    windowEnd: item.windowEnd,
    // 批次上固化创建时的规则快照：之后规则再变，历史批次仍按原规则解释。
    scheduleExpression: rule?.expression ?? '',
    ruleId: rule?.id ?? 0,
    ruleVersion: rule?.version ?? 0,
    origin,
    status: '已排队',
    attempt: 1,
    maxAttempts: maxAttemptsFor(plan),
    idempotencyKey: `${origin}:${plan.id}:${item.taskId}:${item.windowStart}`,
    createdAt: nowIso,
    updatedAt: nowIso,
    startedAt: null,
    finishedAt: null,
    failureReason: null,
    resultMessage: null,
  }
  state.batches = [...state.batches, batch]
  return batch
}

/**
 * 提交单个缺失窗口。幂等规则（按 (计划, 任务, 窗口) 判定）：
 *  - 已有完成批次（含覆盖该窗口的手工/旧规则批次）→ 去重，不生成；
 *  - 已有排队/运行批次 → 去重，等它结束；
 *  - 已有失败批次且策略允许重试 → 在原批次上累加尝试次数（不新建）；
 *  - 其余才生成新批次。
 */
function commitMissingItem(
  state: ScheduleState,
  plan: SchedulePlan,
  item: MissingWindowItem,
  nowIso: string,
): CommitOutcome {
  if (!isValidIso(item.windowStart)) {
    return { outcome: 'rejected', batch: null, message: `窗口起点不合法：${item.windowStart}` }
  }
  const enabled = enabledTasks(plan)
  if (!enabled.some((task) => task.id === item.taskId)) {
    return { outcome: 'rejected', batch: null, message: `${item.taskName} 不在启用任务中，不能提交` }
  }

  const existing = latestBatchForWindow(state.batches, plan.id, item.taskId, item.windowStart)
  if (existing) {
    if (existing.status === SUCCESS_STATUS) {
      return {
        outcome: 'deduplicated',
        batch: existing,
        message: `窗口 ${formatDateTime(item.windowStart)} 已有完成批次 ${existing.batchCode}，不重复生成`,
      }
    }
    if (isInFlight(existing.status)) {
      return {
        outcome: 'deduplicated',
        batch: existing,
        message: `窗口 ${formatDateTime(item.windowStart)} 已有${existing.status}批次 ${existing.batchCode}，等待其完成`,
      }
    }
    const maxAttempts = Math.max(existing.maxAttempts, maxAttemptsFor(plan))
    if (plan.failurePolicy !== '重试') {
      return {
        outcome: 'deduplicated',
        batch: existing,
        message: `批次 ${existing.batchCode} 已失败，失败处理为「${plan.failurePolicy}」，不再重试`,
      }
    }
    if (existing.attempt >= maxAttempts) {
      return {
        outcome: 'rejected',
        batch: existing,
        message: `批次 ${existing.batchCode} 已尝试 ${existing.attempt} 次，达到上限 ${maxAttempts}`,
      }
    }
    const updated: ExecutionBatch = {
      ...existing,
      attempt: existing.attempt + 1,
      maxAttempts,
      status: '已排队',
      updatedAt: nowIso,
      startedAt: null,
      finishedAt: null,
      failureReason: null,
      resultMessage: null,
    }
    state.batches = state.batches.map((batch) => (batch.id === existing.id ? updated : batch))
    bookLedger(
      state,
      updated,
      `失败后续跑：第 ${updated.attempt} 次尝试，窗口 ${formatDateTime(updated.windowStart)}`,
      nowIso,
    )
    return {
      outcome: 'requeued',
      batch: updated,
      message: `批次 ${updated.batchCode} 重新排队（第 ${updated.attempt}/${maxAttempts} 次）`,
    }
  }

  // 起点不同但覆盖本窗口的完成批次：视为已覆盖，避免同一份数据被补两次。
  const covered = overlappingBatches(state.batches, plan.id, item.taskId, item.windowStart, item.windowEnd).find(
    (batch) => batch.status === SUCCESS_STATUS,
  )
  if (covered) {
    return {
      outcome: 'deduplicated',
      batch: covered,
      message: `窗口 ${formatDateTime(item.windowStart)} 已被批次 ${covered.batchCode}（起点 ${formatDateTime(covered.windowStart)}）覆盖，不重复生成`,
    }
  }

  const created = createBatch(state, plan, item, nowIso, 'compensation')
  bookLedger(
    state,
    created,
    `补偿批次已提交，窗口 ${formatDateTime(created.windowStart)}`,
    nowIso,
  )
  return {
    outcome: 'created',
    batch: created,
    message: `已生成补偿批次 ${created.batchCode}`,
  }
}

export function runCompensation(planId: number, now: Date = new Date()): CompensationRunResult {
  const state = getScheduleState()
  const nowIso = now.toISOString()
  const preview = buildCompensationPreview(state, planId, now)
  if (!preview) {
    return { ok: false, message: `没有找到编号为 ${planId} 的编排计划`, preview: null, created: [], retried: [], skipped: [] }
  }
  const blocking = preview.errors.filter(
    (error) => error.includes('没有启用中的调度规则') || error.includes('无法解析'),
  )
  if (blocking.length > 0) {
    return { ok: false, message: blocking[0], preview, created: [], retried: [], skipped: [] }
  }
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) {
    return { ok: false, message: '编排计划不存在', preview, created: [], retried: [], skipped: [] }
  }

  const created: ExecutionBatch[] = []
  const retried: ExecutionBatch[] = []
  const rejected: string[] = []
  for (const item of preview.planned) {
    const result = commitMissingItem(state, plan, item, nowIso)
    if (result.batch && result.outcome === 'created') created.push(result.batch)
    if (result.batch && result.outcome === 'requeued') retried.push(result.batch)
    if (result.outcome === 'rejected') rejected.push(result.message)
  }
  saveScheduleState(state)

  const skipped = preview.perTask.flatMap((view) => view.skipped)
  if (created.length === 0 && retried.length === 0) {
    let reason = '没有真正缺失的窗口：已排队或已完成的批次不会重复生成'
    if (rejected.length > 0) {
      reason = rejected[0]
    } else if (preview.failure.blocked) {
      reason = preview.failure.note
    } else if (preview.deferred.length > 0) {
      reason = `没有真正缺失的窗口：${preview.deferred.length} 个窗口已有排队/运行中的批次或受并发上限限制，本轮不重复生成`
    } else if (preview.warnings.length > 0) {
      reason = preview.warnings[0]
    }
    return {
      ok: rejected.length === 0,
      message: reason,
      preview,
      created,
      retried,
      skipped,
    }
  }
  const parts = [
    created.length > 0 ? `生成 ${created.length} 条执行批次` : '',
    retried.length > 0 ? `重试 ${retried.length} 条失败批次` : '',
    skipped.length > 0 ? `去重 ${skipped.length} 个已完成/已覆盖窗口` : '',
    preview.deferred.length > 0 ? `因并发/在飞批次暂缓 ${preview.deferred.length} 项` : '',
  ].filter(Boolean)
  return {
    ok: true,
    message: `补偿完成：${parts.join('，')}`,
    preview,
    created,
    retried,
    skipped,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 多选任务整组提交：按任务选中集合逐条生成/复用执行批次，每返回一条就通过 onBatch 回调，
 * 页面因此能逐条渲染批次；每个任务的结果各自落一条任务落账记录。
 */
export async function submitTaskGroup(
  planId: number,
  taskIds: number[],
  options: GroupSubmissionOptions = {},
): Promise<GroupSubmissionResult[]> {
  const state = getScheduleState()
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) {
    return [
      {
        taskId: 0,
        taskCode: '',
        taskName: '',
        outcome: 'rejected',
        batch: null,
        message: `没有找到编号为 ${planId} 的编排计划`,
        bookedAt: new Date().toISOString(),
      },
    ]
  }
  const selected = new Set(taskIds)
  const nowIso = (options.now ?? new Date()).toISOString()
  const preview = buildCompensationPreview(state, planId, options.now ?? new Date())
  const results: GroupSubmissionResult[] = []
  if (!preview) return results

  if (selected.size === 0) {
    return [
      {
        taskId: 0,
        taskCode: '',
        taskName: '',
        outcome: 'rejected',
        batch: null,
        message: '请至少勾选一个任务后再整组提交',
        bookedAt: nowIso,
      },
    ]
  }

  if (preview.errors.some((error) => error.includes('没有启用中的调度规则') || error.includes('无法解析'))) {
    return [
      {
        taskId: 0,
        taskCode: '',
        taskName: '',
        outcome: 'rejected',
        batch: null,
        message: preview.errors[0],
        bookedAt: nowIso,
      },
    ]
  }

  const items = preview.planned.filter((item) => selected.has(item.taskId))
  if (items.length === 0) {
    // 选中的任务没有缺失窗口时，也逐条回传一条「去重」结果，让页面知道无需重复提交。
    for (const taskId of selected) {
      const task = plan.tasks.find((item) => item.id === taskId)
      if (!task) continue
      const result: GroupSubmissionResult = {
        taskId,
        taskCode: task.taskCode,
        taskName: task.taskName,
        outcome: 'deduplicated',
        batch: null,
        message: '选中任务没有真正缺失的窗口（已排队/已完成的不重复生成）',
        bookedAt: nowIso,
      }
      results.push(result)
      options.onBatch?.(result)
      if (!options.immediate) await sleep(60)
    }
    return results
  }

  for (const item of items) {
    const committed = commitMissingItem(state, plan, item, nowIso)
    saveScheduleState(state)
    const result: GroupSubmissionResult = {
      taskId: item.taskId,
      taskCode: item.taskCode,
      taskName: item.taskName,
      outcome: committed.outcome,
      batch: committed.batch,
      message: `${committed.message}（窗口 ${formatDateTime(item.windowStart)}）`,
      bookedAt: nowIso,
    }
    results.push(result)
    options.onBatch?.(result)
    if (!options.immediate) await sleep(80)
  }
  return results
}

function findBatch(state: ScheduleState, batchId: number): ExecutionBatch | null {
  return state.batches.find((batch) => batch.id === batchId) ?? null
}

function replaceBatch(state: ScheduleState, next: ExecutionBatch): void {
  state.batches = state.batches.map((batch) => (batch.id === next.id ? next : batch))
}

/** 计划推进位置只向前移动，且必须连续完成，避免后面的窗口完成后跳过前面的缺口。 */
function advancePlanFloor(state: ScheduleState, plan: SchedulePlan): void {
  const resolution = resolveActiveRule(state.rules, plan.id)
  if (!resolution.rule) return
  let spec
  try {
    spec = parseScheduleExpression(resolution.rule.expression)
  } catch {
    return
  }
  const tasks = enabledTasks(plan)
  if (tasks.length === 0) return
  const completedAll = (windowStart: string): boolean =>
    tasks.every((task) =>
      state.batches.some(
        (batch) =>
          batch.planId === plan.id &&
          batch.taskId === task.id &&
          batch.windowStart === windowStart &&
          batch.status === SUCCESS_STATUS,
      ),
    )
  // 从「已记录位置之前的一个窗口」开始验证连续性：已记录位置本身若仍有失败任务，
  // 不能盲目往后推进，否则失败窗口会被跳过。
  const recorded = plan.lastCompletedWindow ? spec.firstStartAtOrAfter(plan.lastCompletedWindow) : null
  let floor = recorded && completedAll(recorded) ? recorded : null
  let cursor = floor ? spec.nextStartAfter(floor) : spec.firstStartAtOrAfter(plan.startAt)
  let guard = 0
  while (cursor && guard < MAX_WINDOWS && completedAll(cursor)) {
    floor = cursor
    cursor = spec.nextStartAfter(cursor)
    guard += 1
  }
  if (floor && (!plan.lastCompletedWindow || floor > plan.lastCompletedWindow)) {
    plan.lastCompletedWindow = floor
  }
}

export function startBatch(batchId: number, now: Date = new Date()): BatchActionResult {
  const state = getScheduleState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次`, batch: null }
  if (batch.status !== '已排队') {
    return { ok: false, message: `执行批次当前为「${batch.status}」，只有已排队的批次可以启动`, batch }
  }
  const nowIso = now.toISOString()
  const next: ExecutionBatch = { ...batch, status: '运行中', startedAt: nowIso, updatedAt: nowIso }
  replaceBatch(state, next)
  bookLedger(state, next, '批次开始执行', nowIso)
  saveScheduleState(state)
  return { ok: true, message: `执行批次 ${next.batchCode} 已开始执行`, batch: next }
}

export function completeBatch(batchId: number, now: Date = new Date()): BatchActionResult {
  const state = getScheduleState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次`, batch: null }
  if (batch.status !== '运行中') {
    return { ok: false, message: `执行批次当前为「${batch.status}」，只有运行中的批次可以完成`, batch }
  }
  const nowIso = now.toISOString()
  const next: ExecutionBatch = {
    ...batch,
    status: '已完成',
    finishedAt: nowIso,
    updatedAt: nowIso,
    failureReason: null,
    resultMessage: '任务推进成功',
  }
  replaceBatch(state, next)
  bookLedger(state, next, '任务推进成功', nowIso)
  const plan = state.plans.find((item) => item.id === next.planId)
  if (plan) advancePlanFloor(state, plan)
  saveScheduleState(state)
  return { ok: true, message: `执行批次 ${next.batchCode} 已完成，结果按任务落账`, batch: next }
}

export function failBatch(
  batchId: number,
  reason = '执行失败',
  now: Date = new Date(),
): BatchActionResult {
  const state = getScheduleState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到编号为 ${batchId} 的执行批次`, batch: null }
  if (batch.status !== '运行中') {
    return { ok: false, message: `执行批次当前为「${batch.status}」，只有运行中的批次可以标记失败`, batch }
  }
  const nowIso = now.toISOString()
  const next: ExecutionBatch = {
    ...batch,
    status: '已失败',
    finishedAt: nowIso,
    updatedAt: nowIso,
    failureReason: failureReasonOrNull(reason) ?? '执行失败',
    resultMessage: null,
  }
  replaceBatch(state, next)
  bookLedger(state, next, next.failureReason ?? '执行失败', nowIso)
  saveScheduleState(state)
  return {
    ok: true,
    message: `执行批次 ${next.batchCode} 已失败，下次补偿只会从缺失窗口继续`,
    batch: next,
  }
}

export type PlanAction = '提交校验' | '启动编排' | '停止编排'

const PLAN_ACTION_TARGET: Record<PlanAction, SchedulePlanStatus> = {
  提交校验: '待校验',
  启动编排: '运行中',
  停止编排: '已停止',
}

export function runPlanAction(
  planId: number,
  action: PlanAction,
  now: Date = new Date(),
): { ok: boolean; message: string } {
  const state = getScheduleState()
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) return { ok: false, message: `没有找到编号为 ${planId} 的编排计划` }
  if (action === '提交校验' && plan.status !== '草稿') {
    return { ok: false, message: `计划当前为「${plan.status}」，只有草稿可以提交校验` }
  }
  if (action === '启动编排' && plan.status === '运行中') {
    return { ok: false, message: '计划已经是「运行中」，不用重复启动' }
  }
  if (action === '停止编排' && plan.status === '已停止') {
    return { ok: false, message: '计划已经是「已停止」' }
  }
  if (action === '启动编排' && state.rules.every((rule) => !(rule.planId === plan.id && rule.status === '已启用'))) {
    return { ok: false, message: '计划没有已启用的调度规则，启动前请先启用一条规则' }
  }
  plan.status = PLAN_ACTION_TARGET[action]
  void now
  saveScheduleState(state)
  return { ok: true, message: `计划已${action}，当前状态「${plan.status}」` }
}

export function setRuleStatus(
  ruleId: number,
  status: ScheduleRule['status'],
): { ok: boolean; message: string } {
  const state = getScheduleState()
  const rule = state.rules.find((item) => item.id === ruleId)
  if (!rule) return { ok: false, message: `没有找到编号为 ${ruleId} 的调度规则` }
  rule.status = status
  saveScheduleState(state)
  const resolution = resolveActiveRule(state.rules, rule.planId)
  return {
    ok: true,
    message: `规则 v${rule.version} 已${status}，当前生效规则：${resolution.rule ? `v${resolution.rule.version}（${resolution.rule.expression}）` : '无'}`,
  }
}

export function resetSchedule(): { ok: boolean; message: string } {
  resetScheduleState()
  return { ok: true, message: '编排调度数据已恢复到示例状态' }
}

/**
 * 跨模块下游作业清单：只接收「实际补偿产生」的执行批次。
 * 手工批次、计划级汇总和被去重的窗口都不会出现在这里。
 */
export function loadDownstreamJobs(): DownstreamJob[] {
  const state = getScheduleState()
  const planMap = new Map(state.plans.map((plan) => [plan.id, plan]))
  return state.batches
    .filter((batch) => batch.origin === 'compensation')
    .map((batch) => ({
      batchId: batch.id,
      batchCode: batch.batchCode,
      planCode: batch.planCode,
      planName: planMap.get(batch.planId)?.name ?? batch.planCode,
      taskCode: batch.taskCode,
      taskName: batch.taskName,
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd,
      status: batch.status,
      ruleVersion: batch.ruleVersion,
      scheduleExpression: batch.scheduleExpression,
      attempt: batch.attempt,
      bookedAt: batch.updatedAt,
    }))
    .sort((left, right) => new Date(right.bookedAt).getTime() - new Date(left.bookedAt).getTime())
}

export function loadScheduleSummary(): ScheduleSummary {
  const state = getScheduleState()
  return {
    planCount: state.plans.length,
    runningPlanCount: state.plans.filter((plan) => plan.status === '运行中').length,
    compensationBatchCount: state.batches.filter((batch) => batch.origin === 'compensation').length,
    downstreamJobCount: loadDownstreamJobs().length,
    pendingLedgerCount: state.ledger.filter((entry) => entry.status === '已排队' || entry.status === '运行中').length,
  }
}

/** 导出单个计划的补偿与批次清单，字段与页面表格保持一致。 */
export function exportPlanCsv(planId: number): { filename: string; content: string } {
  const state = getScheduleState()
  const plan = state.plans.find((item) => item.id === planId)
  if (!plan) {
    return { filename: '编排计划-不存在.csv', content: '' }
  }
  const header = ['批次编号', '任务编号', '任务名称', '窗口起点', '窗口终点', '来源', '批次状态', '尝试次数', '规则版本', '调度表达式']
  const lines = [header.join(',')]
  for (const batch of loadPlanBatches(planId)) {
    lines.push(
      [
        batch.batchCode,
        batch.taskCode,
        batch.taskName,
        formatDateTime(batch.windowStart),
        formatDateTime(batch.windowEnd),
        batch.origin === 'compensation' ? '漏触发补偿' : '手工批次',
        batch.status,
        `${batch.attempt}/${batch.maxAttempts}`,
        `v${batch.ruleVersion}`,
        batch.scheduleExpression,
      ].join(','),
    )
  }
  return { filename: `${plan.code}-补偿批次清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadPlanCsv(planId: number): void {
  const { filename, content } = exportPlanCsv(planId)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

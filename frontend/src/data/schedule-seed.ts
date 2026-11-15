/**
 * 编排调度的示例数据：全部窗口都按调度表达式落在真实网格上，
 * 方便复现「漏触发补偿与手工批次重叠」「新旧规则冲突」「失败批次续跑」三种现场。
 *
 * 现场说明：
 *  - SCHE-0001 每小时编排：W3 三个任务全部完成；W2 的清洗用户行为有一条仍在运行的手工批次，
 *    W2 的其它任务和 W1 全部缺失 —— 补偿只补真正缺的窗口，与手工批次重叠的窗口先等待。
 *  - SCHE-0002 每天 03:00：只缺最近一个到期窗口，两个启用任务都要补。
 *  - SCHE-0003 六小时编排：旧规则 v1（每 6 小时）与新规则 v2（每 4 小时）同时启用，
 *    冲突以 v2 为准；W3 有一条失败补偿批次（可重试）和一条不在当前网格上的手工批次。
 *  - SCHE-0004 分钟级编排：计划仍是草稿、任务全部停用，用来验证「无可补任务」的提示。
 */
import { addSeconds, parseScheduleExpression } from './schedule-time'
import type {
  ExecutionBatch,
  SchedulePlan,
  ScheduleRule,
  ScheduleState,
  TaskLedgerEntry,
} from './schedule-types'

const HOUR_MS = 60 * 60 * 1000

function dueWindowStarts(expression: string, nowIso: string, count: number): string[] {
  const spec = parseScheduleExpression(expression)
  const from = new Date(new Date(nowIso).getTime() - 45 * 24 * HOUR_MS).toISOString()
  const starts = spec.listStarts(from, nowIso, 5000)
  const due = starts.filter((start) => addSeconds(start, spec.windowSeconds(start)) <= nowIso)
  if (due.length < count) {
    throw new Error('示例数据的时间范围不足以生成调度窗口')
  }
  return due.slice(-count)
}

function windowEnd(expression: string, start: string): string {
  const spec = parseScheduleExpression(expression)
  return addSeconds(start, spec.windowSeconds(start))
}

type BatchOptions = {
  id: number
  batchCode: string
  plan: SchedulePlan
  taskId: number
  expression: string
  ruleId: number
  ruleVersion: number
  origin: 'compensation' | 'manual'
  status: ExecutionBatch['status']
  windowStart: string
  attempt?: number
  maxAttempts?: number
  createdAtOffsetMinutes: number
  /** 距窗口结束的分钟数（负值表示早于结束），用来模拟运行中/已完成。 */
  finishedOffsetMinutes?: number | null
  failureReason?: string | null
  resultMessage?: string | null
  idempotencySuffix?: string
}

function makeBatch(now: Date, options: BatchOptions): ExecutionBatch {
  const task = options.plan.tasks.find((item) => item.id === options.taskId)
  if (!task) throw new Error(`示例数据引用了不存在的任务 ${options.taskId}`)
  const start = options.windowStart
  const end = windowEnd(options.expression, start)
  const createdAt = new Date(
    Math.min(now.getTime(), new Date(end).getTime() + options.createdAtOffsetMinutes * 60 * 1000),
  ).toISOString()
  const finishedAt =
    options.finishedOffsetMinutes === undefined || options.finishedOffsetMinutes === null
      ? null
      : new Date(
          Math.min(now.getTime(), new Date(end).getTime() + options.finishedOffsetMinutes * 60 * 1000),
        ).toISOString()
  const startedAt =
    options.status === '运行中' || options.status === '已完成' || options.status === '已失败'
      ? createdAt
      : null
  return {
    id: options.id,
    batchCode: options.batchCode,
    planId: options.plan.id,
    planCode: options.plan.code,
    taskId: task.id,
    taskCode: task.taskCode,
    taskName: task.taskName,
    windowStart: start,
    windowEnd: end,
    scheduleExpression: options.expression,
    ruleId: options.ruleId,
    ruleVersion: options.ruleVersion,
    origin: options.origin,
    status: options.status,
    attempt: options.attempt ?? 1,
    maxAttempts: options.maxAttempts ?? 1,
    idempotencyKey: `${options.origin}:${options.plan.id}:${task.id}:${start}${
      options.idempotencySuffix ?? ''
    }`,
    createdAt,
    updatedAt: finishedAt ?? createdAt,
    startedAt,
    finishedAt,
    failureReason: options.failureReason ?? null,
    resultMessage: options.resultMessage ?? null,
  }
}

function buildSeed(now: Date): ScheduleState {
  const nowIso = now.toISOString()

  const hourly = dueWindowStarts('0 * * * *', nowIso, 4) // W1 最近一个到期窗口
  const daily = dueWindowStarts('0 3 * * *', nowIso, 2)
  const sixHour = dueWindowStarts('0 */4 * * *', nowIso, 8)

  const plans: SchedulePlan[] = [
    {
      id: 1,
      code: 'SCHE-0001',
      name: '清洗层小时编排',
      status: '运行中',
      // 计划从 W3 开始，W3 是上一轮完整推进的窗口，W4 漏触发：补偿从 W3 复查
      startAt: hourly[2],
      lastCompletedWindow: hourly[2],
      concurrencyLimit: 6,
      failurePolicy: '跳过',
      retryLimit: 1,
      timeoutSeconds: 1800,
      notifyPolicy: '失败通知值班群',
      tasks: [
        { id: 101, taskCode: 'TASK-SILV-01', taskName: '清洗订单明细', dependsOn: [], enabled: true },
        { id: 102, taskCode: 'TASK-SILV-02', taskName: '清洗用户行为', dependsOn: [], enabled: true },
        { id: 103, taskCode: 'TASK-SILV-03', taskName: '清洗支付流水', dependsOn: ['TASK-SILV-01'], enabled: true },
      ],
    },
    {
      id: 2,
      code: 'SCHE-0002',
      name: '聚合层每日编排',
      status: '运行中',
      startAt: addSeconds(daily[0], -24 * 60 * 60),
      // 上一次推进到昨天的窗口，今天 03:00 的窗口才到期
      lastCompletedWindow: daily[0],
      concurrencyLimit: 4,
      failurePolicy: '终止',
      retryLimit: 1,
      timeoutSeconds: 3600,
      notifyPolicy: '失败通知值班群并暂停计划',
      tasks: [
        { id: 201, taskCode: 'TASK-GOLD-01', taskName: '物化销售聚合', dependsOn: [], enabled: true },
        { id: 202, taskCode: 'TASK-GOLD-02', taskName: '物化库存聚合', dependsOn: [], enabled: true },
        { id: 203, taskCode: 'TASK-GOLD-03', taskName: '物化用户聚合', dependsOn: [], enabled: false },
      ],
    },
    {
      id: 3,
      code: 'SCHE-0003',
      name: '批量转换四小时编排',
      status: '运行中',
      startAt: sixHour[0],
      // b5 是上一次完整推进的位置：b5 内已成功的任务不会重跑，b5 之后才重新生成
      lastCompletedWindow: sixHour[4],
      concurrencyLimit: 20,
      failurePolicy: '重试',
      retryLimit: 2,
      timeoutSeconds: 5400,
      notifyPolicy: '补偿完成汇总通知',
      tasks: [
        { id: 301, taskCode: 'BATC-0001', taskName: '订单分区转换', dependsOn: [], enabled: true },
        { id: 302, taskCode: 'BATC-0002', taskName: '用户分区转换', dependsOn: [], enabled: true },
        { id: 303, taskCode: 'BATC-0003', taskName: '商品分区转换', dependsOn: ['BATC-0002'], enabled: true },
        { id: 304, taskCode: 'BATC-0004', taskName: '库存分区转换', dependsOn: [], enabled: true },
        { id: 305, taskCode: 'BATC-0005', taskName: '财务分区转换', dependsOn: [], enabled: false },
      ],
    },
    {
      id: 4,
      code: 'SCHE-0004',
      name: '原始层分钟编排',
      status: '草稿',
      startAt: hourly[0],
      lastCompletedWindow: null,
      concurrencyLimit: 1,
      failurePolicy: '跳过',
      retryLimit: 0,
      timeoutSeconds: 300,
      notifyPolicy: '仅记录审计',
      tasks: [
        { id: 401, taskCode: 'TASK-BRON-01', taskName: '原始落地校验', dependsOn: [], enabled: false },
        { id: 402, taskCode: 'TASK-BRON-02', taskName: '原始增量登记', dependsOn: [], enabled: false },
      ],
    },
  ]

  const rules: ScheduleRule[] = [
    {
      id: 1,
      planId: 1,
      version: 1,
      expression: '0 * * * *',
      status: '已启用',
      effectiveFrom: hourly[0],
      note: '每小时第 0 分触发',
    },
    {
      id: 2,
      planId: 2,
      version: 1,
      expression: '0 3 * * *',
      status: '已启用',
      effectiveFrom: daily[0],
      note: '每天 03:00 触发',
    },
    {
      id: 3,
      planId: 3,
      version: 1,
      expression: '0 */6 * * *',
      status: '已启用',
      effectiveFrom: sixHour[0],
      note: '旧规则：每 6 小时一次。规则变更后仍保留，但不再用于生成新批次。',
    },
    {
      id: 4,
      planId: 3,
      version: 2,
      expression: '0 */4 * * *',
      status: '已启用',
      effectiveFrom: sixHour[2],
      note: '新规则：每 4 小时一次。与旧规则同时启用，冲突时以版本号更高的新规则为准。',
    },
    {
      id: 5,
      planId: 4,
      version: 1,
      expression: '*/15 * * * *',
      status: '已启用',
      effectiveFrom: hourly[0],
      note: '每 15 分钟触发，计划仍是草稿',
    },
  ]

  // 窗口按时间升序：W4 / b8 是最近一个已到期窗口。
  const [w1, w2, w3, w4] = hourly
  const [b1, b2, b3, b4, b5, b6, b7, b8] = sixHour

  const batches: ExecutionBatch[] = [
    // SCHE-0001 W3：三个任务全部完成，属于「已推进」的位置
    makeBatch(now, {
      id: 1,
      batchCode: 'EXE-0001',
      plan: plans[0],
      taskId: 101,
      expression: '0 * * * *',
      ruleId: 1,
      ruleVersion: 1,
      origin: 'compensation',
      status: '已完成',
      windowStart: w3,
      createdAtOffsetMinutes: -80,
      finishedOffsetMinutes: -70,
      resultMessage: '补偿批次执行成功',
    }),
    makeBatch(now, {
      id: 2,
      batchCode: 'EXE-0002',
      plan: plans[0],
      taskId: 102,
      expression: '0 * * * *',
      ruleId: 1,
      ruleVersion: 1,
      origin: 'compensation',
      status: '已完成',
      windowStart: w3,
      createdAtOffsetMinutes: -80,
      finishedOffsetMinutes: -65,
      resultMessage: '补偿批次执行成功',
    }),
    makeBatch(now, {
      id: 3,
      batchCode: 'EXE-0003',
      plan: plans[0],
      taskId: 103,
      expression: '0 * * * *',
      ruleId: 1,
      ruleVersion: 1,
      origin: 'compensation',
      status: '已完成',
      windowStart: w3,
      createdAtOffsetMinutes: -80,
      finishedOffsetMinutes: -60,
      resultMessage: '补偿批次执行成功',
    }),
    // SCHE-0001 W4：清洗用户行为有一条仍在运行的手工批次，补偿不应再插一条
    makeBatch(now, {
      id: 4,
      batchCode: 'EXE-0004',
      plan: plans[0],
      taskId: 102,
      expression: '0 * * * *',
      ruleId: 1,
      ruleVersion: 1,
      origin: 'manual',
      status: '运行中',
      windowStart: w4,
      createdAtOffsetMinutes: -50,
    }),
    // SCHE-0003 W3：商品分区转换补偿失败，库存分区转换已完成
    makeBatch(now, {
      id: 5,
      batchCode: 'EXE-0005',
      plan: plans[2],
      taskId: 303,
      expression: '0 */4 * * *',
      ruleId: 4,
      ruleVersion: 2,
      origin: 'compensation',
      status: '已失败',
      windowStart: b5,
      attempt: 1,
      maxAttempts: 3,
      createdAtOffsetMinutes: -230,
      finishedOffsetMinutes: -210,
      failureReason: '上游依赖未就绪，转换脚本退出码 2',
    }),
    makeBatch(now, {
      id: 6,
      batchCode: 'EXE-0006',
      plan: plans[2],
      taskId: 304,
      expression: '0 */4 * * *',
      ruleId: 4,
      ruleVersion: 2,
      origin: 'compensation',
      status: '已完成',
      windowStart: b5,
      attempt: 1,
      maxAttempts: 3,
      createdAtOffsetMinutes: -230,
      finishedOffsetMinutes: -220,
      resultMessage: '补偿批次执行成功',
    }),
    // SCHE-0003 W1：订单分区转换的手工批次仍在运行，用户分区转换的手工批次已完成
    makeBatch(now, {
      id: 7,
      batchCode: 'EXE-0007',
      plan: plans[2],
      taskId: 301,
      expression: '0 */4 * * *',
      ruleId: 4,
      ruleVersion: 2,
      origin: 'manual',
      status: '运行中',
      windowStart: b8,
      attempt: 1,
      maxAttempts: 3,
      createdAtOffsetMinutes: -120,
    }),
    makeBatch(now, {
      id: 8,
      batchCode: 'EXE-0008',
      plan: plans[2],
      taskId: 302,
      expression: '0 */4 * * *',
      ruleId: 4,
      ruleVersion: 2,
      origin: 'manual',
      status: '已完成',
      windowStart: b8,
      attempt: 1,
      maxAttempts: 3,
      createdAtOffsetMinutes: -120,
      finishedOffsetMinutes: -90,
      resultMessage: '值班手工批次执行成功',
    }),
    // SCHE-0003 W3：一条起点不在当前规则网格上的历史手工批次（旧 6 小时规则的产物），
    // 已完成且覆盖 W3 窗口，补偿应把它算作已覆盖而不是再补一份。
    makeBatch(now, {
      id: 9,
      batchCode: 'EXE-0009',
      plan: plans[2],
      taskId: 302,
      expression: '0 */6 * * *',
      ruleId: 3,
      ruleVersion: 1,
      origin: 'manual',
      status: '已完成',
      windowStart: addSeconds(b5, 2 * 60 * 60),
      attempt: 1,
      maxAttempts: 3,
      createdAtOffsetMinutes: -300,
      finishedOffsetMinutes: -280,
      resultMessage: '旧规则网格下的手工批次执行成功',
    }),
  ]

  const ledger: TaskLedgerEntry[] = batches
    .filter((batch) => batch.status === '已完成' || batch.status === '已失败')
    .map((batch, index) => ({
      id: index + 1,
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
      bookedAt: batch.finishedAt ?? batch.updatedAt,
      message: batch.resultMessage ?? batch.failureReason ?? '',
    }))

  // makeBatch 的时间线依赖 now，这里只做一次校验，避免示例数据自己违反不变量。
  const ascending = (list: string[]): boolean =>
    list.every((item, index) => index === 0 || list[index - 1] < item)
  if (!ascending([w1, w2, w3, w4])) throw new Error('示例窗口顺序异常')
  if (!ascending([b1, b2, b3, b4, b5, b6, b7, b8])) throw new Error('示例批次窗口顺序异常')

  return { version: 1, plans, rules, batches, ledger }
}

let seedState: ScheduleState | null = null

/** 首次访问时生成示例数据；同一会话内保持稳定，重置时重新生成。 */
export function getScheduleSeed(now: Date = new Date()): ScheduleState {
  if (seedState === null) {
    seedState = buildSeed(now)
  }
  return JSON.parse(JSON.stringify(seedState)) as ScheduleState
}

export function rebuildScheduleSeed(now: Date = new Date()): ScheduleState {
  seedState = buildSeed(now)
  return getScheduleSeed(now)
}

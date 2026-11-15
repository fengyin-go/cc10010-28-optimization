/** 编排调度领域的强类型模型：补偿计算、执行批次与任务落账都围绕这些结构流转。 */

export type SchedulePlanStatus = '草稿' | '待校验' | '运行中' | '已停止'
export type ScheduleRuleStatus = '草稿' | '待校验' | '已启用' | '已停用'
export type FailurePolicy = '终止' | '跳过' | '重试'
export type BatchOrigin = 'compensation' | 'manual'
export type ExecutionBatchStatus = '已排队' | '运行中' | '已完成' | '已失败'

export type ScheduleTask = {
  id: number
  taskCode: string
  taskName: string
  /** 同计划内的上游任务编号，仅用于展示依赖关系。 */
  dependsOn: string[]
  enabled: boolean
}

export type SchedulePlan = {
  id: number
  code: string
  name: string
  status: SchedulePlanStatus
  startAt: string
  /** 上次推进到的窗口起点；该窗口内可能仍有失败任务，补偿会从该窗口复查。 */
  lastCompletedWindow: string | null
  concurrencyLimit: number
  failurePolicy: FailurePolicy
  retryLimit: number
  timeoutSeconds: number
  notifyPolicy: string
  tasks: ScheduleTask[]
}

export type ScheduleRule = {
  id: number
  planId: number
  version: number
  expression: string
  status: ScheduleRuleStatus
  effectiveFrom: string
  note: string
}

export type ExecutionBatch = {
  id: number
  batchCode: string
  planId: number
  planCode: string
  taskId: number
  taskCode: string
  taskName: string
  windowStart: string
  windowEnd: string
  /** 批次创建时的规则快照：规则变更不回写历史批次。 */
  scheduleExpression: string
  ruleId: number
  ruleVersion: number
  origin: BatchOrigin
  status: ExecutionBatchStatus
  attempt: number
  maxAttempts: number
  idempotencyKey: string
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  failureReason: string | null
  resultMessage: string | null
}

/**
 * 任务落账：追加式记录，批次每次状态变化（提交/重排/启动/完成/失败）各记一条，
 * 始终按任务分别落账，不再合并成计划级汇总。
 */
export type TaskLedgerEntry = {
  id: number
  planId: number
  planCode: string
  taskId: number
  taskCode: string
  taskName: string
  windowStart: string
  batchId: number
  batchCode: string
  status: ExecutionBatchStatus
  origin: BatchOrigin
  ruleVersion: number
  bookedAt: string
  message: string
}

export type ScheduleState = {
  version: number
  plans: SchedulePlan[]
  rules: ScheduleRule[]
  batches: ExecutionBatch[]
  ledger: TaskLedgerEntry[]
}

export type WindowRange = {
  start: string
  end: string
}

export type ActiveRuleResolution = {
  rule: ScheduleRule | null
  decision: string
  enabledCandidates: ScheduleRule[]
}

export type MissingWindowAction = 'create' | 'retry' | 'skip' | 'defer' | 'blocked'

export type MissingWindowItem = {
  taskId: number
  taskCode: string
  taskName: string
  windowStart: string
  windowEnd: string
  action: MissingWindowAction
  reason: string
  existingBatchId: number | null
}

export type TaskCompensationView = {
  taskId: number
  taskCode: string
  taskName: string
  lastSucceededWindow: string | null
  missing: MissingWindowItem[]
  skipped: MissingWindowItem[]
}

export type CompensationPreview = {
  planId: number
  planCode: string
  planName: string
  now: string
  activeRule: ScheduleRule | null
  ruleDecision: string
  /** 补偿起点：优先取所有启用任务连续完成的位置，其次取计划记录的上次完成位置。 */
  cursorWindow: string | null
  cursorReason: string
  expectedWindows: WindowRange[]
  /** 补偿起点之前、已判定无需复查的窗口数量。 */
  ignoredBeforeCursor: number
  perTask: TaskCompensationView[]
  planned: MissingWindowItem[]
  deferred: MissingWindowItem[]
  /** 手工批次与当前规则网格的对齐情况，只做展示，不参与生成。 */
  manualCoverage: ManualCoverageItem[]
  concurrency: {
    limit: number
    inFlight: number
    available: number
    plannedCount: number
    deferredCount: number
  }
  failure: {
    policy: FailurePolicy
    retryLimit: number
    blocked: boolean
    boundaryWindow: string | null
    note: string
  }
  errors: string[]
  warnings: string[]
}

export type ManualCoverageItem = {
  batchId: number
  batchCode: string
  taskId: number
  taskCode: string
  taskName: string
  windowStart: string
  windowEnd: string
  /** 手工批次起点是否正好落在当前规则网格上。 */
  alignedWithRule: boolean
  /** 被这条手工批次覆盖的当前规则窗口起点。 */
  coversWindowStart: string
  decision: string
  note: string
}

export type CompensationRunResult = {
  ok: boolean
  message: string
  preview: CompensationPreview | null
  /** 本轮补偿新生成的执行批次（不含被复用的历史批次）。 */
  created: ExecutionBatch[]
  /** 失败策略放行后重试的已有批次。 */
  retried: ExecutionBatch[]
  skipped: MissingWindowItem[]
}

export type GroupSubmissionOutcome = 'created' | 'requeued' | 'deduplicated' | 'rejected'

export type GroupSubmissionResult = {
  taskId: number
  taskCode: string
  taskName: string
  outcome: GroupSubmissionOutcome
  batch: ExecutionBatch | null
  message: string
  bookedAt: string
}

export type GroupSubmissionOptions = {
  now?: Date
  /** 立即返回结果、不做逐条延时：供测试直接断言。 */
  immediate?: boolean
  /** 每返回一条任务结果就回调一次，页面可以逐条渲染执行批次。 */
  onBatch?: (result: GroupSubmissionResult) => void
}

export type BatchActionResult = {
  ok: boolean
  message: string
  batch: ExecutionBatch | null
}

export type SchedulePlanOverview = {
  plan: SchedulePlan
  activeRule: ScheduleRule | null
  ruleDecision: string
  derivedCursor: string | null
  missingWindowCount: number
  inFlightCount: number
  lastBatchAt: string | null
}

export type ScheduleWorkspace = {
  plans: SchedulePlanOverview[]
  selectedPlan: SchedulePlan | null
  rules: ScheduleRule[]
  batches: ExecutionBatch[]
  ledger: TaskLedgerEntry[]
  preview: CompensationPreview | null
}

export type ScheduleSummary = {
  planCount: number
  runningPlanCount: number
  compensationBatchCount: number
  downstreamJobCount: number
  pendingLedgerCount: number
}

export type DownstreamJob = {
  batchId: number
  batchCode: string
  planCode: string
  planName: string
  taskCode: string
  taskName: string
  windowStart: string
  windowEnd: string
  status: ExecutionBatchStatus
  ruleVersion: number
  scheduleExpression: string
  attempt: number
  bookedAt: string
}

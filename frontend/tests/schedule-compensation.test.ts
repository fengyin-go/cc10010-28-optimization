/**
 * 漏触发补偿到执行批次的数据流测试：
 *  - 真正缺失的窗口才生成批次，已排队/已完成/手工覆盖的窗口不重复生成；
 *  - 相同补偿窗口重复到达只产生一次；
 *  - 失败后从缺失窗口续跑，不把已成功的任务重跑；
 *  - 新旧规则冲突以启用规则的最新版本为准，历史批次保留原规则快照；
 *  - 多选整组提交逐条回传、按任务分别落账；
 *  - 下游作业清单只接收实际补偿批次。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCompensationPreview, resolveActiveRule } from '../src/data/schedule-engine.ts'
import { getScheduleSeed } from '../src/data/schedule-seed.ts'
import {
  completeBatch,
  failBatch,
  loadDownstreamJobs,
  startBatch,
  submitTaskGroup,
} from '../src/data/schedule-service.ts'
import { SCHEDULE_STORAGE_KEY, clearScheduleCache } from '../src/data/schedule-store.ts'
import type { ExecutionBatch, ScheduleState } from '../src/data/schedule-types.ts'

import * as serviceModule from '../src/data/schedule-service.ts'

const NOW = new Date('2026-11-15T10:00:00.000Z')

function installLocalStorage(initial: ScheduleState): void {
  const store = new Map<string, string>()
  store.set(SCHEDULE_STORAGE_KEY, JSON.stringify(initial))
  const fake = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: fake },
    configurable: true,
    writable: true,
  })
}

function freshService(): typeof import('../src/data/schedule-service.ts') {
  // 每次用例开始前清掉 schedule-store 的模块级缓存，重新读 localStorage。
  clearScheduleCache()
  return serviceModule
}

async function seedState(now = NOW): Promise<ScheduleState> {
  const state = getScheduleSeed(now)
  installLocalStorage(state)
  return JSON.parse(JSON.stringify(state)) as ScheduleState
}

function batchAt(state: ScheduleState, taskId: number, windowStart: string): ExecutionBatch[] {
  return state.batches.filter((batch) => batch.taskId === taskId && batch.windowStart === windowStart)
}

test('规则冲突以版本号更高的启用规则为准', () => {
  const seed = getScheduleSeed(NOW)
  const resolution = resolveActiveRule(seed.rules, 3)
  assert.equal(resolution.rule?.version, 2)
  assert.equal(resolution.rule?.expression, '0 */4 * * *')
  assert.equal(resolution.enabledCandidates.length, 2)
  assert.match(resolution.decision, /v2/)
  // 历史批次仍保留创建时的旧规则快照
  const legacy = seed.batches.find((batch) => batch.batchCode === 'EXE-0009')
  assert.ok(legacy)
  assert.equal(legacy?.ruleVersion, 1)
  assert.equal(legacy?.scheduleExpression, '0 */6 * * *')
})

test('补偿只补真正缺失的窗口，运行中的手工批次不重复生成', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  const preview = service.previewCompensation(1, NOW)
  assert.ok(preview)
  // 计划推进到 08:00 窗口，该窗口三个任务全部完成；
  // 09:00 窗口：用户行为有运行中手工批次（等待），订单/支付流水缺失（补）。
  assert.equal(preview.cursorWindow, '2026-11-15T08:00:00.000Z')
  const planned = preview.planned.map((item) => `${item.taskCode}@${item.windowStart}`)
  assert.deepEqual(planned, [
    'TASK-SILV-01@2026-11-15T09:00:00.000Z',
    'TASK-SILV-03@2026-11-15T09:00:00.000Z',
  ])
  const deferred = preview.deferred.map((item) => `${item.taskCode}@${item.windowStart}`)
  assert.deepEqual(deferred, ['TASK-SILV-02@2026-11-15T09:00:00.000Z'])
  assert.equal(
    preview.perTask.flatMap((view) => view.skipped).length,
    3, // 08:00 三个已完成的窗口记录为去重
  )

  const result = service.runCompensation(1, NOW)
  assert.equal(result.ok, true)
  assert.equal(result.created.length, 2)
  assert.equal(result.retried.length, 0)

  const after = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  assert.equal(batchAt(after, 102, '2026-11-15T09:00:00.000Z').length, 1)
  assert.equal(batchAt(after, 102, '2026-11-15T09:00:00.000Z')[0].status, '运行中')
  // 手工批次原样保留（示例数据里 4 条手工批次）
  assert.equal(
    after.batches.filter((batch) => batch.origin === 'manual').map((batch) => batch.batchCode).sort().join(','),
    'EXE-0004,EXE-0007,EXE-0008,EXE-0009',
  )
})

test('补偿只从上次完成位置往后查，不回到计划起点重跑已推进窗口', () => {
  const seed = getScheduleSeed(NOW)
  // 计划起点早于上次完成位置：更早的窗口即使没有批次也不应被补偿
  const plan = seed.plans.find((item) => item.id === 1)
  assert.ok(plan)
  plan.startAt = '2026-11-14T00:00:00.000Z'
  const preview = buildCompensationPreview(seed, 1, NOW)
  assert.ok(preview)
  assert.equal(preview.cursorWindow, plan.lastCompletedWindow)
  assert.ok(preview.ignoredBeforeCursor > 0)
  assert.equal(
    preview.planned.every((item) => item.windowStart >= (plan.lastCompletedWindow ?? '')),
    true,
    '不能为上次完成位置之前的窗口生成批次',
  )
})

test('相同补偿窗口重复到达只产生一次执行批次', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  service.runCompensation(1, NOW)
  const second = service.runCompensation(1, NOW)
  assert.equal(second.ok, true)
  assert.equal(second.created.length, 0)
  assert.match(second.message, /没有真正缺失的窗口|不会重复生成/)
  const after = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  const created = after.batches.filter((batch) => batch.planId === 1 && batch.origin === 'compensation')
  assert.equal(created.length, 5) // 3 条已完成 + 2 条新排队
  assert.equal(new Set(created.map((batch) => `${batch.taskId}@${batch.windowStart}`)).size, created.length)
})

test('手工批次覆盖的窗口不再生成，即使起点不在当前规则网格上', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  const preview = service.previewCompensation(3, NOW)
  assert.ok(preview)
  const coverage = preview.manualCoverage.find((item) => item.batchCode === 'EXE-0009')
  assert.ok(coverage)
  assert.equal(coverage?.alignedWithRule, false)
  assert.equal(coverage?.decision, '视为已覆盖')
  // 旧手工批次覆盖的当前规则窗口继续不补
  assert.equal(
    preview.planned.some(
      (item) => item.taskCode === 'BATC-0002' && item.windowStart === coverage?.coversWindowStart,
    ),
    false,
  )
})

test('多选整组提交不会重复已有手工批次', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  const results = await service.submitTaskGroup(3, [301], { now: NOW, immediate: true })
  const manualWindow = '2026-11-15T04:00:00.000Z'
  const manual = seed.batches.find(
    (batch) => batch.origin === 'manual' && batch.taskId === 301 && batch.windowStart === manualWindow,
  )
  assert.ok(manual)
  // 该窗口已有运行中手工批次：结果里要么去重、要么等待，绝不能新建第二条
  const after = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  assert.equal(batchAt(after, 301, manualWindow).length, 1)
  assert.ok(results.length > 0)
})

test('失败后从缺失窗口继续，已完成任务不重跑', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  const first = service.runCompensation(3, NOW)
  assert.equal(first.ok, true)
  const afterFirst = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState

  // 取一条已生成的新批次：启动后失败
  const target = first.created.find((batch) => batch.taskCode === 'BATC-0001')
  assert.ok(target)
  service.startBatch(target.id, NOW)
  service.failBatch(target.id, '模拟失败', NOW)
  const afterFail = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  const failed = afterFail.batches.find((batch) => batch.id === target.id)
  assert.equal(failed?.status, '已失败')
  assert.equal(failed?.attempt, 1)

  // 同一窗口用户分区转换已完成，不应再次生成
  const done = first.created.find((batch) => batch.taskCode === 'BATC-0002')
  assert.ok(done)
  service.startBatch(done.id, NOW)
  service.completeBatch(done.id, NOW)

  const second = service.runCompensation(3, NOW)
  assert.equal(second.ok, true)
  // 失败的窗口重新排队（同一批次累加尝试次数），已完成的不重跑
  assert.equal(second.retried.length, 1)
  assert.equal(second.retried[0].id, target.id)
  assert.equal(second.retried[0].attempt, 2)
  assert.equal(second.created.length, 0)
  const afterSecond = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  assert.equal(batchAt(afterSecond, done.taskId, done.windowStart).length, 1)
  assert.equal(batchAt(afterSecond, done.taskId, done.windowStart)[0].status, '已完成')
})

test('失败处理为终止时停在失败窗口，不再往后生成', () => {
  const seed = getScheduleSeed(NOW)
  const plan = seed.plans.find((item) => item.id === 2)
  assert.ok(plan)
  plan.status = '运行中'
  const failedWindow = '2026-11-14T03:00:00.000Z'
  plan.lastCompletedWindow = '2026-11-13T03:00:00.000Z'
  // 失败窗口之前的窗口全部完成
  for (const [index, taskId] of [201, 202].entries()) {
    seed.batches.push({
      id: 90 + index,
      batchCode: `EXE-009${index}`,
      planId: 2,
      planCode: plan.code,
      taskId,
      taskCode: taskId === 201 ? 'TASK-GOLD-01' : 'TASK-GOLD-02',
      taskName: taskId === 201 ? '物化销售聚合' : '物化库存聚合',
      windowStart: '2026-11-13T03:00:00.000Z',
      windowEnd: '2026-11-14T03:00:00.000Z',
      scheduleExpression: '0 3 * * *',
      ruleId: 2,
      ruleVersion: 1,
      origin: 'compensation',
      status: '已完成',
      attempt: 1,
      maxAttempts: 1,
      idempotencyKey: `compensation:2:${taskId}:2026-11-13T03:00:00.000Z`,
      createdAt: '2026-11-13T03:00:00.000Z',
      updatedAt: '2026-11-13T04:00:00.000Z',
      startedAt: '2026-11-13T03:00:00.000Z',
      finishedAt: '2026-11-13T04:00:00.000Z',
      failureReason: null,
      resultMessage: '任务推进成功',
    })
  }
  seed.batches.push({
    id: 99,
    batchCode: 'EXE-0099',
    planId: 2,
    planCode: plan.code,
    taskId: 201,
    taskCode: 'TASK-GOLD-01',
    taskName: '物化销售聚合',
    windowStart: failedWindow,
    windowEnd: '2026-11-15T03:00:00.000Z',
    scheduleExpression: '0 3 * * *',
    ruleId: 2,
    ruleVersion: 1,
    origin: 'compensation',
    status: '已失败',
    attempt: 1,
    maxAttempts: 1,
    idempotencyKey: `compensation:2:201:${failedWindow}`,
    createdAt: failedWindow,
    updatedAt: '2026-11-14T05:00:00.000Z',
    startedAt: failedWindow,
    finishedAt: '2026-11-14T05:00:00.000Z',
    failureReason: '上游失败',
    resultMessage: null,
  })
  const preview = buildCompensationPreview(seed, 2, NOW)
  assert.ok(preview)
  assert.equal(preview.failure.blocked, true)
  // 失败窗口不重试，后续窗口全部阻塞：本轮不生成任何批次
  assert.equal(preview.planned.length, 0)
  assert.ok(preview.deferred.length > 0)
  assert.ok(preview.deferred.every((item) => item.action === 'blocked'))
})

test('并发上限以外的窗口暂缓，不丢窗口', async () => {
  const seed = await seedState()
  const plan = seed.plans.find((item) => item.id === 1)
  assert.ok(plan)
  plan.concurrencyLimit = 2
  installLocalStorage(seed)
  const service = freshService()
  const preview = service.previewCompensation(1, NOW)
  assert.ok(preview)
  assert.equal(preview.concurrency.available, 1) // 已有 1 条运行中手工批次
  assert.equal(preview.planned.length, 1)
  // 另一个缺失窗口 + 与运行中手工批次重叠的窗口
  assert.equal(preview.deferred.length, 2)
  const result = service.runCompensation(1, NOW)
  assert.equal(result.created.length, 1)
  const after = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  assert.equal(after.batches.filter((batch) => batch.planId === 1 && batch.status === '已排队').length, 1)
})

test('多选任务整组提交逐条回传，按任务分别落账', async () => {
  const seed = await seedState()
  installLocalStorage(seed)
  const service = freshService()
  const streamed: string[] = []
  const results = await service.submitTaskGroup(3, [301, 302, 303, 304], {
    now: NOW,
    immediate: true,
    onBatch: (result) => streamed.push(`${result.taskCode}:${result.outcome}`),
  })
  assert.equal(results.length, streamed.length)
  assert.ok(results.length > 0)
  assert.ok(
    results.every((result) =>
      ['created', 'deduplicated', 'requeued'].includes(result.outcome),
    ),
  )
  // 每个任务一条落账，落账里带着各自的批次编号
  const after = JSON.parse(globalThis.window.localStorage.getItem(SCHEDULE_STORAGE_KEY) ?? '{}') as ScheduleState
  const booked = after.ledger.filter((entry) => entry.planId === 3 && entry.batchCode.startsWith('EXE-00'))
  assert.ok(booked.length > 0)
  const taskCodes = new Set(results.filter((result) => result.batch).map((result) => result.taskCode))
  assert.ok(taskCodes.size >= 2)
})

test('下游作业清单只接收实际补偿批次', () => {
  const seed = getScheduleSeed(NOW)
  const state = JSON.parse(JSON.stringify(seed)) as ScheduleState
  installLocalStorage(state)
  clearScheduleCache()
  const jobs = loadDownstreamJobs()
  assert.ok(jobs.length > 0)
  const seedBatches = new Map(state.batches.map((batch) => [batch.id, batch]))
  for (const job of jobs) {
    assert.equal(seedBatches.get(job.batchId)?.origin, 'compensation')
  }
  const manualIds = state.batches.filter((batch) => batch.origin === 'manual').map((batch) => batch.id)
  assert.equal(jobs.some((job) => manualIds.includes(job.batchId)), false)
})

test('调度表达式无法解析时给出错误而不是生成批次', () => {
  const seed = getScheduleSeed(NOW)
  const rule = seed.rules.find((item) => item.planId === 1)
  assert.ok(rule)
  rule.expression = '0 0 * * * *'
  const preview = buildCompensationPreview(seed, 1, NOW)
  assert.ok(preview)
  assert.equal(preview.planned.length, 0)
  assert.match(preview.errors[0], /6 段|秒/)
})

import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  CompensationPreview,
  ExecutionBatch,
  GroupSubmissionResult,
  MissingWindowItem,
  SchedulePlan,
  SchedulePlanOverview,
  ScheduleRule,
  TaskLedgerEntry,
} from '@/data/schedule-types'
import { formatDateTime, toLocalInputValue } from '@/data/schedule-time'
import {
  downloadPlanCsv,
  loadPlanBatches,
  loadLedger,
  loadPlans,
  loadWorkspace,
  previewCompensation,
  resetSchedule,
  runCompensation,
  runPlanAction,
  setRuleStatus,
  startBatch,
  completeBatch,
  failBatch,
  submitTaskGroup,
} from '@/data/schedule-service'

type TabKey = 'overview' | 'preview' | 'batches' | 'ledger' | 'rules'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '计划与规则' },
  { key: 'preview', label: '缺失窗口预览' },
  { key: 'batches', label: '执行批次' },
  { key: 'ledger', label: '任务落账' },
  { key: 'rules', label: '调度规则' },
]

const ACTION_TEXT: Record<MissingWindowItem['action'], string> = {
  create: '补生成',
  retry: '失败重试',
  skip: '去重跳过',
  defer: '暂缓（并发/在飞）',
  blocked: '阻塞（失败处理）',
}

function actionClass(action: MissingWindowItem['action']): string {
  return `action-${action}`
}

function outcomeBadge(outcome: GroupSubmissionResult['outcome']): string {
  if (outcome === 'created') return 'badge ok'
  if (outcome === 'requeued') return 'badge warn'
  if (outcome === 'deduplicated') return 'badge info'
  return 'badge danger'
}

const OUTCOME_TEXT: Record<GroupSubmissionResult['outcome'], string> = {
  created: '已提交',
  requeued: '重新排队',
  deduplicated: '已去重',
  rejected: '被拒绝',
}

export default function ScheduleView() {
  const [plans, setPlans] = useState<SchedulePlanOverview[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null)
  const [rules, setRules] = useState<ScheduleRule[]>([])
  const [batches, setBatches] = useState<ExecutionBatch[]>([])
  const [ledger, setLedger] = useState<TaskLedgerEntry[]>([])
  const [preview, setPreview] = useState<CompensationPreview | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [selectedTasks, setSelectedTasks] = useState<number[]>([])
  const [groupResults, setGroupResults] = useState<GroupSubmissionResult[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [failureReason, setFailureReason] = useState('')
  const [compensationAsOf, setCompensationAsOf] = useState(() => toLocalInputValue(new Date().toISOString()))
  const [busyBatchId, setBusyBatchId] = useState<number | null>(null)

  const reload = useCallback(
    (planId: number | null = selectedPlanId) => {
      const overview = loadPlans()
      setPlans(overview)
      const targetId = planId ?? overview[0]?.plan.id ?? null
      setSelectedPlanId(targetId)
      if (targetId === null) {
        setRules([])
        setBatches([])
        setLedger([])
        setPreview(null)
        return
      }
      // 规则列表直接从服务层拿，页面不自己解析本地存储。
      setRules(loadWorkspace(targetId).rules)
      setBatches(loadPlanBatches(targetId))
      setLedger(loadLedger(targetId))
      setPreview(previewCompensation(targetId, currentMoment()))
    },
    [selectedPlanId, compensationAsOf],
  )

  useEffect(() => {
    reload(null)
    // 首次加载只需要跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const plan: SchedulePlan | null = plans.find((item) => item.plan.id === selectedPlanId)?.plan ?? null
  const overview = plans.find((item) => item.plan.id === selectedPlanId) ?? null
  const enabledTaskList = useMemo(() => plan?.tasks.filter((task) => task.enabled) ?? [], [plan])
  const planRules = useMemo(
    () => rules.filter((rule) => rule.planId === selectedPlanId),
    [rules, selectedPlanId],
  )
  const otherPlanTasks = useMemo(() => plan?.tasks.filter((task) => !task.enabled) ?? [], [plan])

  function currentMoment(): Date {
    // 补偿基准时间由页面控制：默认「现在」，也允许值班同学回放到某个时刻核对窗口。
    if (!compensationAsOf) return new Date()
    const parsed = new Date(compensationAsOf)
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed
  }

  function selectPlan(planId: number) {
    setSelectedPlanId(planId)
    setSelectedTasks([])
    setGroupResults([])
    setMessage('')
    setErrorMessage('')
    reload(planId)
  }

  function refreshWithNotice(text: string) {
    setMessage(text)
    setErrorMessage('')
    reload(selectedPlanId)
  }

  function fail(text: string) {
    setErrorMessage(text)
    setMessage('')
  }

  function handleCompensate() {
    if (selectedPlanId === null) return
    const result = runCompensation(selectedPlanId, currentMoment())
    if (!result.ok) {
      fail(result.message)
      reload(selectedPlanId)
      return
    }
    setTab('batches')
    refreshWithNotice(result.message)
  }

  function toggleTask(taskId: number) {
    setSelectedTasks((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    )
  }

  function toggleAll() {
    setSelectedTasks((prev) =>
      prev.length === enabledTaskList.length ? [] : enabledTaskList.map((task) => task.id),
    )
  }

  async function handleGroupSubmit() {
    if (selectedPlanId === null) return
    if (selectedTasks.length === 0) {
      fail('请先勾选要提交的任务')
      return
    }
    setSubmitting(true)
    setErrorMessage('')
    setMessage('')
    setGroupResults([])
    try {
      const results = await submitTaskGroup(selectedPlanId, selectedTasks, {
        now: currentMoment(),
        onBatch: (result) => {
          // 逐条回传：每拿到一条任务结果就追加一行，并立刻刷新该任务的批次
          setGroupResults((prev) => [...prev, result])
          setBatches(loadPlanBatches(selectedPlanId))
          setLedger(loadLedger(selectedPlanId))
        },
      })
      setGroupResults(results)
      const created = results.filter((result) => result.outcome === 'created').length
      const requeued = results.filter((result) => result.outcome === 'requeued').length
      const deduped = results.filter((result) => result.outcome === 'deduplicated').length
      const rejected = results.filter((result) => result.outcome === 'rejected').length
      setMessage(
        `整组提交完成：新建 ${created} 条，重新排队 ${requeued} 条，去重 ${deduped} 条${
          rejected > 0 ? `，拒绝 ${rejected} 条` : ''
        }`,
      )
      reload(selectedPlanId)
    } finally {
      setSubmitting(false)
    }
  }

  function handleBatchAction(action: 'start' | 'complete' | 'fail', batch: ExecutionBatch) {
    setBusyBatchId(batch.id)
    try {
      const result =
        action === 'start'
          ? startBatch(batch.id)
          : action === 'complete'
            ? completeBatch(batch.id)
            : failBatch(batch.id, failureReason || '值班手工标记失败')
      if (!result.ok) {
        fail(result.message)
        return
      }
      setFailureReason('')
      refreshWithNotice(result.message)
    } finally {
      setBusyBatchId(null)
    }
  }

  function handlePlanAction(action: '提交校验' | '启动编排' | '停止编排') {
    if (selectedPlanId === null) return
    const result = runPlanAction(selectedPlanId, action)
    if (!result.ok) {
      fail(result.message)
      return
    }
    refreshWithNotice(result.message)
  }

  function handleRuleToggle(rule: ScheduleRule) {
    const nextStatus = rule.status === '已启用' ? '已停用' : '已启用'
    const result = setRuleStatus(rule.id, nextStatus)
    if (!result.ok) {
      fail(result.message)
      return
    }
    refreshWithNotice(result.message)
  }

  function handleReset() {
    resetSchedule()
    setSelectedPlanId(null)
    setSelectedTasks([])
    setGroupResults([])
    setTab('overview')
    setMessage('编排调度数据已恢复到示例状态')
    setErrorMessage('')
    reload(null)
  }

  const crossGridManual = preview?.manualCoverage.filter((item) => !item.alignedWithRule) ?? []

  return (
    <section className="page" data-module="schedule">
      <header className="page-head">
        <div>
          <h2>编排调度管理</h2>
          <p className="page-desc">
            按调度表达式、上次完成位置、并发上限和失败处理计算真正漏触发的窗口；已排队、已完成以及手工批次覆盖的窗口不会重复生成执行批次。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => selectedPlanId !== null && downloadPlanCsv(selectedPlanId)}>
            导出补偿批次清单
          </button>
          <button className="btn ghost" type="button" onClick={handleReset}>
            恢复示例数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">编排计划</span>
          <strong className="stat-value">{plans.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">运行中计划</span>
          <strong className="stat-value">{plans.filter((item) => item.plan.status === '运行中').length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">本计划缺失窗口</span>
          <strong className="stat-value">{overview?.missingWindowCount ?? 0}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">在飞批次</span>
          <strong className="stat-value">{overview?.inFlightCount ?? 0}</strong>
        </article>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3 className="panel-title">编排计划</h3>
          <span className="panel-sub">选中计划后查看该计划的补偿窗口与执行批次</span>
        </div>
        <div className="plan-list">
          {plans.map((item) => (
            <button
              key={item.plan.id}
              type="button"
              className={`plan-card${item.plan.id === selectedPlanId ? ' active' : ''}`}
              onClick={() => selectPlan(item.plan.id)}
            >
              <h3>
                {item.plan.code} · {item.plan.name}
              </h3>
              <div className="plan-meta">
                <span>
                  状态 <span className="badge">{item.plan.status}</span> · 缺失窗口 {item.missingWindowCount} · 在飞{' '}
                  {item.inFlightCount}
                </span>
                <span>
                  调度 {item.activeRule ? item.activeRule.expression : '无启用规则'} · 并发上限 {item.plan.concurrencyLimit} ·
                  失败处理 {item.plan.failurePolicy}
                </span>
                <span>补偿起点 {formatDateTime(item.derivedCursor)}</span>
              </div>
            </button>
          ))}
          {plans.length === 0 && <p className="muted">暂无编排计划</p>}
        </div>
      </section>

      {plan && overview && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h3 className="panel-title">
                {plan.code} · {plan.name}
              </h3>
              <span className="panel-sub">
                上次完成位置 {formatDateTime(plan.lastCompletedWindow)} · 超时 {plan.timeoutSeconds}s · {plan.notifyPolicy}
              </span>
            </div>
            <div className="callout">
              <p>
                <strong>规则裁决：</strong>
                {preview?.ruleDecision ?? overview.ruleDecision}
              </p>
              <p>
                <strong>补偿起点：</strong>
                {preview?.cursorReason ?? '—'}
              </p>
              {preview && (
                <p>
                  <strong>并发：</strong>上限 {preview.concurrency.limit}，在飞 {preview.concurrency.inFlight}，本轮可生成{' '}
                  {preview.concurrency.available}，实际计划 {preview.concurrency.plannedCount}，暂缓{' '}
                  {preview.concurrency.deferredCount}
                </p>
              )}
              <p>
                <strong>失败处理：</strong>
                {preview?.failure.note ?? plan.failurePolicy}
              </p>
            </div>
            {preview?.warnings.map((warning) => (
              <div key={warning} className="callout warn">
                {warning}
              </div>
            ))}
            {preview?.errors.map((error) => (
              <div key={error} className="callout danger">
                {error}
              </div>
            ))}
            <div className="toolbar">
              <label className="filter-item">
                <span>补偿基准时间</span>
                <input
                  type="datetime-local"
                  value={compensationAsOf}
                  onChange={(event) => {
                    const value = event.target.value
                    setCompensationAsOf(value)
                    const parsed = new Date(value)
                    setPreview(
                      previewCompensation(plan.id, Number.isNaN(parsed.getTime()) ? new Date() : parsed),
                    )
                  }}
                />
              </label>
              <button className="btn primary" type="button" onClick={handleCompensate}>
                计算并生成补偿批次
              </button>
              <button className="btn" type="button" onClick={() => handlePlanAction('提交校验')}>
                提交校验
              </button>
              <button className="btn" type="button" onClick={() => handlePlanAction('启动编排')}>
                启动编排
              </button>
              <button className="btn" type="button" onClick={() => handlePlanAction('停止编排')}>
                停止编排
              </button>
            </div>
          </section>

          <div className="tabs">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`tab${tab === item.key ? ' active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">任务多选与整组提交</h3>
                <span className="panel-sub">勾选任务后整组提交，执行批次逐条回传，落账按任务分别记录</span>
              </div>
              <div className="toolbar">
                <button className="btn" type="button" onClick={toggleAll}>
                  {selectedTasks.length === enabledTaskList.length ? '取消全选' : '全选启用任务'}
                </button>
                <button
                  className="btn primary"
                  type="button"
                  onClick={handleGroupSubmit}
                  disabled={submitting || selectedTasks.length === 0}
                >
                  {submitting ? '逐条提交中…' : `整组提交（已选 ${selectedTasks.length}）`}
                </button>
                <span className="muted small">
                  并发上限 {plan.concurrencyLimit}，在飞 {preview?.concurrency.inFlight ?? 0}
                </span>
              </div>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        aria-label="全选"
                        checked={enabledTaskList.length > 0 && selectedTasks.length === enabledTaskList.length}
                        onChange={toggleAll}
                      />
                    </th>
                    <th>任务编号</th>
                    <th>任务名称</th>
                    <th>依赖上游</th>
                    <th>上次成功窗口</th>
                    <th>缺失窗口</th>
                    <th>下发来源</th>
                  </tr>
                </thead>
                <tbody>
                  {enabledTaskList.map((task) => {
                    const taskView = preview?.perTask.find((view) => view.taskId === task.id)
                    return (
                      <tr key={task.id}>
                        <td className="checkbox-cell">
                          <input
                            type="checkbox"
                            aria-label={`选择 ${task.taskCode}`}
                            checked={selectedTasks.includes(task.id)}
                            onChange={() => toggleTask(task.id)}
                          />
                        </td>
                        <td>{task.taskCode}</td>
                        <td>{task.taskName}</td>
                        <td>{task.dependsOn.length > 0 ? task.dependsOn.join('、') : '—'}</td>
                        <td>{formatDateTime(taskView?.lastSucceededWindow ?? null)}</td>
                        <td>{taskView?.missing.length ?? 0}</td>
                        <td>{taskView?.missing.some((item) => item.action === 'retry') ? '失败续跑' : '漏触发补偿'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {otherPlanTasks.length > 0 && (
                <p className="muted small">未启用任务：{otherPlanTasks.map((task) => task.taskCode).join('、')}</p>
              )}

              {groupResults.length > 0 && (
                <div className="result-list">
                  {groupResults.map((result, index) => (
                    <div className="result-item" key={`${result.taskId}-${index}`}>
                      <span className={outcomeBadge(result.outcome)}>{OUTCOME_TEXT[result.outcome]}</span>
                      <strong>{result.taskCode}</strong>
                      <span>{result.message}</span>
                      <span className="muted small">
                        {result.batch ? `批次 ${result.batch.batchCode} · ${formatDateTime(result.batch.windowStart)} · ${result.batch.status}` : '未生成批次'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {crossGridManual.length > 0 && (
                <div className="callout warn">
                  <p>
                    <strong>手工批次与规则网格不一致：</strong>以下手工批次起点不在当前规则网格上，但仍会覆盖对应的规则窗口，补偿不会为这些窗口重复生成批次。
                  </p>
                  {crossGridManual.map((item) => (
                    <p key={item.batchId}>
                      {item.batchCode}（{item.taskCode}）起点 {formatDateTime(item.windowStart)}，覆盖规则窗口{' '}
                      {formatDateTime(item.coversWindowStart)}：{item.decision}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === 'preview' && (
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">缺失窗口预览</h3>
                <span className="panel-sub">
                  到期窗口 {preview?.expectedWindows.length ?? 0} 个，补偿起点前已推进 {preview?.ignoredBeforeCursor ?? 0} 个
                </span>
              </div>
              <div className="toolbar">
                <button className="btn primary" type="button" onClick={handleCompensate}>
                  执行补偿（{preview?.planned.length ?? 0} 条）
                </button>
                <span className="muted small">基准时间 {formatDateTime(currentMoment().toISOString())}</span>
                <button className="btn" type="button" onClick={() => refreshWithNotice('已按当前规则重新计算缺失窗口')}>
                  重新计算
                </button>
              </div>
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>任务</th>
                      <th>窗口起点</th>
                      <th>窗口终点</th>
                      <th>判定</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview?.perTask.flatMap((view) =>
                      [...view.missing, ...view.skipped].map((item) => (
                        <tr key={`${view.taskId}-${item.windowStart}-${item.action}`}>
                          <td>
                            {item.taskCode}
                            <div className="muted small">{item.taskName}</div>
                          </td>
                          <td>{formatDateTime(item.windowStart)}</td>
                          <td>{formatDateTime(item.windowEnd)}</td>
                          <td className={actionClass(item.action)}>{ACTION_TEXT[item.action]}</td>
                          <td className="reason-cell">
                            {item.reason}
                            {item.existingBatchId !== null && (
                              <span className="muted small">（关联批次 #{item.existingBatchId}）</span>
                            )}
                          </td>
                        </tr>
                      )),
                    )}
                    {(preview?.perTask.every((view) => view.missing.length === 0 && view.skipped.length === 0) ??
                      true) && (
                      <tr>
                        <td className="empty-state" colSpan={5}>
                          当前没有到期窗口需要补偿
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                「暂缓」表示并发上限已用满或已有在飞批次，窗口不会被丢弃，下一轮补偿继续判断；「阻塞」表示失败处理为终止或已达尝试上限。
              </p>
            </section>
          )}

          {tab === 'batches' && (
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">执行批次</h3>
                <span className="panel-sub">共 {batches.length} 条；批次上的规则版本是创建时的快照</span>
              </div>
              <div className="toolbar">
                <input
                  className="btn"
                  style={{ minWidth: 260 }}
                  placeholder="失败原因（标记失败时使用）"
                  value={failureReason}
                  onChange={(event) => setFailureReason(event.target.value)}
                />
              </div>
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>批次编号</th>
                      <th>任务</th>
                      <th>窗口</th>
                      <th>来源</th>
                      <th>状态</th>
                      <th>尝试次数</th>
                      <th>规则快照</th>
                      <th>更新时间</th>
                      <th>可执行动作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((batch) => (
                      <tr key={batch.id}>
                        <td>{batch.batchCode}</td>
                        <td>
                          {batch.taskCode}
                          <div className="muted small">{batch.taskName}</div>
                        </td>
                        <td>
                          {formatDateTime(batch.windowStart)}
                          <div className="muted small">至 {formatDateTime(batch.windowEnd)}</div>
                        </td>
                        <td>
                          <span className={`badge ${batch.origin === 'compensation' ? 'ok' : 'warn'}`}>
                            {batch.origin === 'compensation' ? '漏触发补偿' : '手工批次'}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              batch.status === '已完成'
                                ? 'ok'
                                : batch.status === '已失败'
                                  ? 'danger'
                                  : batch.status === '运行中'
                                    ? 'info'
                                    : 'warn'
                            }`}
                          >
                            {batch.status}
                          </span>
                          {batch.failureReason && <div className="muted small">{batch.failureReason}</div>}
                        </td>
                        <td>
                          {batch.attempt}/{batch.maxAttempts}
                        </td>
                        <td>
                          v{batch.ruleVersion}
                          <div className="muted small mono">{batch.scheduleExpression}</div>
                        </td>
                        <td>{formatDateTime(batch.updatedAt)}</td>
                        <td className="row-actions">
                          {batch.status === '已排队' && (
                            <button
                              className="link"
                              type="button"
                              disabled={busyBatchId === batch.id}
                              onClick={() => handleBatchAction('start', batch)}
                            >
                              启动任务
                            </button>
                          )}
                          {batch.status === '运行中' && (
                            <>
                              <button
                                className="link"
                                type="button"
                                disabled={busyBatchId === batch.id}
                                onClick={() => handleBatchAction('complete', batch)}
                              >
                                标记完成
                              </button>
                              <button
                                className="link"
                                type="button"
                                disabled={busyBatchId === batch.id}
                                onClick={() => handleBatchAction('fail', batch)}
                              >
                                标记失败
                              </button>
                            </>
                          )}
                          {(batch.status === '已完成' || batch.status === '已失败') && (
                            <span className="muted small">已终态</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {batches.length === 0 && (
                      <tr>
                        <td className="empty-state" colSpan={9}>
                          暂无执行批次，可先执行补偿计算
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'ledger' && (
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">任务落账</h3>
                <span className="panel-sub">按任务分别记录，不合并成计划级汇总</span>
              </div>
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>落账时间</th>
                      <th>任务</th>
                      <th>批次</th>
                      <th>窗口起点</th>
                      <th>来源</th>
                      <th>状态</th>
                      <th>规则版本</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry) => (
                      <tr key={entry.id}>
                        <td>{formatDateTime(entry.bookedAt)}</td>
                        <td>
                          {entry.taskCode}
                          <div className="muted small">{entry.taskName}</div>
                        </td>
                        <td>{entry.batchCode}</td>
                        <td>{formatDateTime(entry.windowStart)}</td>
                        <td>{entry.origin === 'compensation' ? '漏触发补偿' : '手工批次'}</td>
                        <td>{entry.status}</td>
                        <td>v{entry.ruleVersion}</td>
                        <td className="reason-cell">{entry.message}</td>
                      </tr>
                    ))}
                    {ledger.length === 0 && (
                      <tr>
                        <td className="empty-state" colSpan={8}>
                          暂无落账记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === 'rules' && (
            <section className="panel">
              <div className="panel-head">
                <h3 className="panel-title">调度规则</h3>
                <span className="panel-sub">多条规则同时启用时按版本号取最新，历史批次保留原规则快照</span>
              </div>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>调度表达式</th>
                    <th>状态</th>
                    <th>生效时间</th>
                    <th>说明</th>
                    <th>是否当前生效</th>
                    <th>动作</th>
                  </tr>
                </thead>
                <tbody>
                  {planRules.map((rule) => {
                    const isActive = overview.activeRule?.id === rule.id
                    return (
                      <tr key={rule.id} className={rule.status === '已启用' && !isActive ? 'rule-row-conflict' : ''}>
                        <td>v{rule.version}</td>
                        <td className="mono">{rule.expression}</td>
                        <td>{rule.status}</td>
                        <td>{formatDateTime(rule.effectiveFrom)}</td>
                        <td className="reason-cell">{rule.note}</td>
                        <td>
                          {isActive ? (
                            <span className="badge ok">当前生效</span>
                          ) : rule.status === '已启用' ? (
                            <span className="badge warn">被更高版本覆盖</span>
                          ) : (
                            <span className="muted small">未生效</span>
                          )}
                        </td>
                        <td>
                          <button className="link" type="button" onClick={() => handleRuleToggle(rule)}>
                            {rule.status === '已启用' ? '停用规则' : '启用规则'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <footer className="page-foot">
        <span>
          补偿窗口只按当前启用规则计算；已排队/已完成批次不重复生成，失败批次从缺失窗口续跑。
        </span>
        <span>
          {message && <span className="muted">{message}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}

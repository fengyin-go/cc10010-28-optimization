import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { loadDownstreamJobs, loadScheduleSummary } from '@/data/schedule-service'
import { formatDateTime } from '@/data/schedule-time'
import type { DownstreamJob } from '@/data/schedule-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('batch')
const columns = [
  "任务编号",
  "输入路径",
  "处理脚本",
  "输出路径",
  "分区覆盖",
  "依赖上游",
  "重试策略",
  "超时终止"
]
const actions = [
  "提交调度",
  "启动任务",
  "终止任务",
  "归档结果"
]
const statuses = [
  "草稿",
  "待调度",
  "运行中",
  "已完成",
  "已失败"
]
const stats = [
  {
    "label": "批处理任务总数",
    "value": 0
  },
  {
    "label": "运行中任务",
    "value": 0
  },
  {
    "label": "已完成任务",
    "value": 0
  }
]

function downstreamBadge(status: DownstreamJob['status']): string {
  if (status === '已完成') return 'badge ok'
  if (status === '已失败') return 'badge danger'
  if (status === '运行中') return 'badge info'
  return 'badge warn'
}

export default function BatchView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [downstreamJobs, setDownstreamJobs] = useState<DownstreamJob[]>([])
  const [scheduleSummary, setScheduleSummary] = useState<ReturnType<typeof loadScheduleSummary> | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      // 跨模块下游作业清单：只接收编排调度中实际补偿产生的执行批次
      setDownstreamJobs(loadDownstreamJobs())
      setScheduleSummary(loadScheduleSummary())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '批量转换列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="batch">
      <header className="page-head">
        <div>
          <h2>批量转换管理</h2>
          <p className="page-desc">维护批量转换任务的输入、执行约束与结果记录，为批量转换提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('批处理任务登记入口尚未接入审批流')}>
            登记批处理任务
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出批量转换清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无批量转换数据，可先登记批处理任务</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="panel" data-panel="downstream-jobs">
        <div className="panel-head">
          <h3 className="panel-title">下游作业清单（仅漏触发补偿批次）</h3>
          <span className="panel-sub">
            补偿批次 {scheduleSummary?.compensationBatchCount ?? 0} 条 · 待落账{' '}
            {scheduleSummary?.pendingLedgerCount ?? 0} 条
          </span>
        </div>
        <p className="muted small">
          清单来自编排调度模块的补偿结果：手工批次和被去重的窗口不会进入下游，同一补偿窗口重复到达也只出现一次。
        </p>
        <div className="table-scroll">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>批次编号</th>
                <th>编排计划</th>
                <th>任务</th>
                <th>窗口</th>
                <th>规则快照</th>
                <th>尝试次数</th>
                <th>状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {downstreamJobs.map((job) => (
                <tr key={job.batchId}>
                  <td>{job.batchCode}</td>
                  <td>
                    {job.planCode}
                    <div className="muted small">{job.planName}</div>
                  </td>
                  <td>
                    {job.taskCode}
                    <div className="muted small">{job.taskName}</div>
                  </td>
                  <td>
                    {formatDateTime(job.windowStart)}
                    <div className="muted small">至 {formatDateTime(job.windowEnd)}</div>
                  </td>
                  <td>
                    v{job.ruleVersion}
                    <div className="muted small mono">{job.scheduleExpression}</div>
                  </td>
                  <td>{job.attempt}</td>
                  <td>
                    <span className={downstreamBadge(job.status)}>{job.status}</span>
                  </td>
                  <td>{formatDateTime(job.bookedAt)}</td>
                </tr>
              ))}
              {downstreamJobs.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={8}>
                    暂无补偿批次，编排调度执行补偿后这里才会出现下游作业
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="page-foot">
        <span>共 {total} 条批量转换记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}

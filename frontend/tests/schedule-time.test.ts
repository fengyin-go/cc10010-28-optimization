/**
 * 调度表达式与补偿窗口内核的单元测试。不依赖浏览器，直接 node --test 跑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addSeconds,
  diffSeconds,
  formatDateTime,
  parseScheduleExpression,
  tryParseScheduleExpression,
} from '../src/data/schedule-time.ts'

test('小时表达式生成整点窗口', () => {
  const spec = parseScheduleExpression('0 * * * *')
  const starts = spec.listStarts('2026-11-15T08:30:00.000Z', '2026-11-15T11:00:00.000Z')
  assert.deepEqual(
    starts.map((item) => item.slice(11, 16)),
    ['09:00', '10:00'],
  )
  assert.equal(spec.windowSeconds(starts[0]), 3600)
})

test('每 4 小时表达式在本地零点锚定', () => {
  const spec = parseScheduleExpression('0 */4 * * *')
  const starts = spec.listStarts('2026-11-15T07:30:00.000Z', '2026-11-15T17:00:00.000Z')
  assert.deepEqual(
    starts.map((item) => item.slice(11, 16)),
    ['08:00', '12:00', '16:00'],
  )
})

test('每日表达式落在固定时刻而不是零点', () => {
  const spec = parseScheduleExpression('0 3 * * *')
  const starts = spec.listStarts('2026-11-13T05:00:00.000Z', '2026-11-16T05:00:00.000Z')
  assert.deepEqual(starts, [
    '2026-11-14T03:00:00.000Z',
    '2026-11-15T03:00:00.000Z',
    '2026-11-16T03:00:00.000Z',
  ])
  assert.equal(spec.windowSeconds(starts[0]), 86400)
  assert.equal(spec.firstStartAtOrAfter('2026-11-13T05:00:00.000Z'), '2026-11-14T03:00:00.000Z')
})

test('工作日表达式只在周一至周五触发', () => {
  const spec = parseScheduleExpression('0 2 * * 1-5')
  // 2026-11-13 是周五，2026-11-14 周六，2026-11-15 周日
  const starts = spec.listStarts('2026-11-12T00:00:00.000Z', '2026-11-17T00:00:00.000Z')
  assert.deepEqual(starts, [
    '2026-11-12T02:00:00.000Z',
    '2026-11-13T02:00:00.000Z',
    '2026-11-16T02:00:00.000Z',
  ])
  assert.equal(spec.windowSeconds('2026-11-13T02:00:00.000Z'), diffSeconds('2026-11-16T02:00:00.000Z', '2026-11-13T02:00:00.000Z'))
})

test('每月 1 日表达式跨月扫描', () => {
  const spec = parseScheduleExpression('0 0 1 * *')
  const starts = spec.listStarts('2026-11-15T00:00:00.000Z', '2027-02-02T00:00:00.000Z')
  assert.deepEqual(starts, [
    '2026-12-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    '2027-02-01T00:00:00.000Z',
  ])
})

test('非法表达式给出可读报错', () => {
  assert.match(tryParseScheduleExpression('0 0 * * * *').error, /秒/)
  assert.match(tryParseScheduleExpression('0 0 * *').error, /5 段/)
  assert.match(tryParseScheduleExpression('99 * * * *').error, /超出范围/)
  assert.equal(tryParseScheduleExpression('0 * * * *').spec?.normalized, '0 * * * *')
})

test('@daily 别名与 5 段表达式等价', () => {
  const alias = parseScheduleExpression('@daily')
  const explicit = parseScheduleExpression('0 0 * * *')
  assert.equal(alias.normalized, explicit.normalized)
})

test('窗口结束时间等于下一个边界', () => {
  const spec = parseScheduleExpression('30 */6 * * *')
  const first = spec.firstStartAtOrAfter('2026-11-15T00:00:00.000Z')
  assert.ok(first)
  const next = spec.nextStartAfter(first)
  assert.ok(next)
  assert.equal(addSeconds(first, spec.windowSeconds(first)), next)
  assert.ok(formatDateTime(first).length > 0)
})

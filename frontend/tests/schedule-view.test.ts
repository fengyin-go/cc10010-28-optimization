/**
 * 编排调度页面的交互测试：在测试用的 React 桩里渲染页面，
 * 直接触发「整组提交」「执行补偿」「勾选任务」等按钮，验证页面层的数据流：
 *  - 补偿后批次表只多出真正缺失的批次，与运行中手工批次重叠的窗口不重复；
 *  - 整组提交逐条回传，每条结果都带批次编号；
 *  - 页面展示规则裁决与手工批次网格对齐提示。
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { build } from 'esbuild'

const SRC = new URL('../src/', import.meta.url).pathname
const TESTS = new URL('./', import.meta.url).pathname
const ROOT = new URL('..', import.meta.url).pathname

function fakeLocalStorage(initial: Record<string, string>): Storage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

test('编排调度页面：整组提交逐条回传、手工重叠窗口不重复', async () => {
  const outDir = join(ROOT, '.interaction-smoke')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const entry = join(outDir, 'entry.tsx')
  await writeFile(
    entry,
    `
import React from 'react'
import ScheduleView from '@/views/schedule/ScheduleView'
export default ScheduleView
export { React }
`,
  )
  const outfile = join(outDir, 'bundle.mjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    alias: {
      '@': SRC,
      react: join(TESTS, 'react-shim.mjs'),
      'react/jsx-runtime': join(TESTS, 'jsx-runtime.mjs'),
      'react/jsx-dev-runtime': join(TESTS, 'jsx-runtime.mjs'),
    },
    logLevel: 'silent',
  })

  const { getScheduleSeed } = await import('../src/data/schedule-seed.ts')
  const scheduleSeed = getScheduleSeed(new Date('2026-11-15T10:00:00.000Z'))
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: fakeLocalStorage({ 'lake-govern-config:schedule': JSON.stringify(scheduleSeed) }) },
    configurable: true,
    writable: true,
  })

  const shim = await import('./react-shim.mjs')
  const module = await import(`${pathToFileURL(outfile).href}?ts=${Date.now()}`)
  const renderer = shim.createRenderer(module.default)

  const rowsOf = (tree: unknown): string[][] => {
    const rows: string[][] = []
    shim.walk(tree, (element: { type: unknown; props: Record<string, unknown> }) => {
      if (element.type !== 'tr') return
      const cells: string[] = []
      shim.walk(element.props.children, (cell: { type: unknown; props: Record<string, unknown> }) => {
        if (cell.type === 'td' || cell.type === 'th') cells.push(shim.text(cell))
      })
      if (cells.length > 0) rows.push(cells)
    })
    return rows
  }
  const click = (tree: unknown, label: string) => {
    const button = shim.findButton(tree, label)
    assert.ok(button, `页面上应该有「${label}」按钮`)
    return button.props.onClick?.()
  }
  const clickPrefixed = (tree: unknown, prefix: string) => {
    let found: { props: Record<string, unknown> } | null = null
    shim.walk(tree, (element: { type: unknown; props: Record<string, unknown> }) => {
      if (found) return
      // 按钮内容是模板字符串拼接，JSX 里会变成数组，这里展平后再匹配
      const flatten = (node: unknown): string => {
        if (typeof node === 'string' || typeof node === 'number') return String(node)
        if (Array.isArray(node)) return node.map(flatten).join('')
        return ''
      }
      if (element.type !== 'button') return
      const label = `${flatten(element.props?.children)} ${shim.text(element)}`.trim()
      if (label.startsWith(prefix)) found = element as { props: Record<string, unknown> }
    })
    assert.ok(found, `页面上应该有以「${prefix}」开头的按钮`)
    const target = found as { props: Record<string, unknown> & { onClick?: () => unknown } }
    return target.props.onClick?.()
  }

  try {
    let tree = renderer.render()
    assert.match(shim.text(tree), /编排调度管理/)

    // 1) 勾选全部启用任务，整组提交
    click(tree, '全选启用任务')
    tree = renderer.render()
    const submit = shim.findButton(tree, '整组提交（已选 3）')
    assert.ok(submit, '勾选后出现整组提交按钮')
    await submit.props.onClick?.()
    tree = renderer.render()
    const pageText = shim.text(tree)
    const streamed = (pageText.match(/批次 EXE-/g) ?? []).length
    assert.ok(streamed > 0, '整组提交结果逐条回传批次编号')

    // 2) 切到缺失窗口预览，再执行一次补偿：上一轮刚生成的排队批次会被去重，
    //    然后检查批次表没有重复的 (任务, 窗口)
    click(tree, '缺失窗口预览')
    tree = renderer.render()
    clickPrefixed(tree, '执行补偿（')
    tree = renderer.render()
    click(tree, '执行批次')
    tree = renderer.render()
    const batchRows = rowsOf(tree).filter((cells) => cells[0]?.startsWith('EXE-'))
    assert.ok(batchRows.length > 0)
    const keys = batchRows.map((cells) => `${cells[1]?.split(' ')[0]}@${cells[2]?.split(' ')[0]} ${cells[2]?.split(' ')[1]}`)
    assert.equal(new Set(keys).size, keys.length, '同一任务同一窗口只能有一条批次')

    // 3) 示例数据里与运行中手工批次重叠的窗口仍只有一条手工批次
    const manualRows = batchRows.filter((cells) => cells[3]?.includes('手工批次'))
    assert.ok(manualRows.length > 0)
    const manualKeys = manualRows.map((cells) => `${cells[1]?.split(' ')[0]}@${cells[2]?.split(' ')[0]} ${cells[2]?.split(' ')[1]}`)
    assert.equal(new Set(manualKeys).size, manualKeys.length, '手工批次不会被补偿复制')

    // 4) 落账页签按任务分别记录：至少每个已终态批次一条
    click(tree, '任务落账')
    tree = renderer.render()
    const ledgerRows = rowsOf(tree).filter((cells) => cells[0]?.includes('2026'))
    assert.ok(ledgerRows.length >= 3, '每个已终态批次都有各自的落账记录')

    // 5) 切到同时启用新旧规则的 SCHE-0003，确认冲突裁决可见
    clickPrefixed(tree, 'SCHE-0003')
    tree = renderer.render()
    click(tree, '调度规则')
    tree = renderer.render()
    const ruleText = shim.text(tree)
    assert.match(ruleText, /规则裁决：?\s*检测到 2 条已启用规则/)
    assert.match(ruleText, /v2/)
    assert.match(ruleText, /当前生效/)
    assert.match(ruleText, /被更高版本覆盖/)
    // 历史批次保留旧规则快照
    click(tree, '执行批次')
    tree = renderer.render()
    const batchText = shim.text(tree)
    assert.match(batchText, /0 \*\/6 \* \* \*/)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

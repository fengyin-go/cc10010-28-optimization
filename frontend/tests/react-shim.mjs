/**
 * 页面交互测试用的极简 React 替代品：只实现 useState / useEffect / useCallback / useMemo
 * 与 jsx-runtime，让页面组件能在 Node 里被渲染并触发事件处理器。
 * 它不是 React 的实现，只服务于本仓库的冒烟测试。
 */
// 页面 bundle 和测试各自会加载一份本文件，渲染上下文因此挂在 globalThis 上共享。
function getContext() {
  return globalThis.__renderContext ?? null
}

function setContext(value) {
  globalThis.__renderContext = value
}

export function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
}

export function useState(initial) {
  const ctx = getContext()
  const index = ctx.index++
  if (!(index in ctx.states)) {
    ctx.states[index] = typeof initial === 'function' ? initial() : initial
  }
  const setState = (next) => {
    const value = typeof next === 'function' ? next(ctx.states[index]) : next
    if (Object.is(value, ctx.states[index])) return
    ctx.states[index] = value
    ctx.dirty = true
  }
  return [ctx.states[index], setState]
}

export function useEffect(fn, deps) {
  const ctx = getContext()
  const index = ctx.index++
  const previous = ctx.deps[index]
  const changed =
    previous === undefined ||
    deps === undefined ||
    deps.length !== previous.length ||
    deps.some((dep, i) => !Object.is(dep, previous[i]))
  ctx.deps[index] = deps
  if (changed) ctx.effects.push(fn)
}

export function useCallback(fn) {
  return fn
}

export function useMemo(fn) {
  return fn()
}

export function useRef(initial) {
  const ctx = getContext()
  const index = ctx.index++
  if (!(index in ctx.states)) ctx.states[index] = { current: initial }
  return ctx.states[index]
}

export const Fragment = 'Fragment'
export const StrictMode = 'StrictMode'

const React = { createElement, Fragment, StrictMode, useState, useEffect, useCallback, useMemo, useRef }
export default React

/** 渲染控制器：保存 hook 状态，驱动重新渲染并返回组件树。 */
export function createRenderer(Component) {
  const harness = { index: 0, states: [], deps: [], effects: [], dirty: false }
  const render = () => {
    let tree = null
    for (let pass = 0; pass < 30; pass += 1) {
      harness.index = 0
      harness.effects = []
      harness.dirty = false
      setContext(harness)
      try {
        tree = Component()
      } finally {
        setContext(null)
      }
      const effects = harness.effects
      harness.effects = []
      for (const effect of effects) effect()
      if (!harness.dirty) return tree
    }
    return tree
  }
  return { render, harness }
}

export function walk(tree, visit) {
  if (Array.isArray(tree)) {
    for (const child of tree) walk(child, visit)
    return
  }
  if (tree === null || tree === undefined || typeof tree !== 'object') return
  visit(tree)
  walk(tree.props?.children, visit)
}

export function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  if (tree && typeof tree === 'object' && 'props' in tree) return text(tree.props.children)
  return ''
}

export function findButton(tree, label) {
  let found = null
  walk(tree, (element) => {
    if (found) return
    if (element.type === 'button' && element.props?.children === label) found = element
  })
  return found
}

export function findInput(tree, ariaLabel) {
  let found = null
  walk(tree, (element) => {
    if (found) return
    if (element.type === 'input' && element.props?.['aria-label'] === ariaLabel) found = element
  })
  return found
}

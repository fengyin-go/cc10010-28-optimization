/** jsx-runtime 的测试桩：转发到 tests/react-shim.mjs 的 createElement。 */
import { createElement } from './react-shim.mjs'

export function jsx(type, props) {
  const { children, ...rest } = props ?? {}
  if (children === undefined) return createElement(type, rest)
  return createElement(type, rest, ...(Array.isArray(children) ? children : [children]))
}

export const jsxs = jsx
export const jsxDEV = jsx
export const Fragment = 'Fragment'

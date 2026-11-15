/** 测试用 React 桩的类型声明，仅覆盖 tests/react-shim.mjs 导出的部分。 */
export type ShimElement = {
  type: unknown
  props: Record<string, unknown> & { onClick?: (...args: unknown[]) => unknown }
}

export declare function createElement(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): ShimElement

export declare function useState(initial: unknown): [unknown, (next: unknown) => void]
export declare function useEffect(fn: () => void, deps?: unknown[]): void
export declare function useCallback<T>(fn: T): T
export declare function useMemo<T>(fn: () => T): T
export declare function useRef<T>(initial: T): { current: T }
export declare const Fragment: string
export declare const StrictMode: string

export declare function createRenderer(component: () => unknown): {
  render: () => unknown
  harness: { index: number; states: unknown[]; deps: unknown[][]; effects: unknown[]; dirty: boolean }
}

export declare function walk(tree: unknown, visit: (element: ShimElement) => void): void
export declare function text(tree: unknown): string
export declare function findButton(tree: unknown, label: string): ShimElement | null
export declare function findInput(tree: unknown, ariaLabel: string): ShimElement | null

declare const React: {
  createElement: typeof createElement
  Fragment: string
  StrictMode: string
  useState: typeof useState
  useEffect: typeof useEffect
  useCallback: typeof useCallback
  useMemo: typeof useMemo
  useRef: typeof useRef
}
export default React

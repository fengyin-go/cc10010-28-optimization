/**
 * tests/register.mjs 用到的解析钩子：
 *  - 把 '@/data/...' 等别名映射到 src 目录；
 *  - 给省略扩展名的相对导入补上 .ts。
 */
import { pathToFileURL } from 'node:url'

const SRC_URL = new URL('../src/', import.meta.url)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const target = new URL(`${specifier.slice(2)}.ts`, SRC_URL).href
    return { url: target, shortCircuit: true }
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.(ts|tsx|js|mjs|json)$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL)
      return { url: `${base.href}.ts`, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}

export { pathToFileURL }

/**
 * 测试用 ESM 解析钩子：让 node --test 也能读懂项目里的 '@/xxx' 别名和省略扩展名的导入。
 * 只影响测试进程，不改变 Vite 的解析方式。
 */
import { register } from 'node:module'

register('./resolve-hook.mjs', import.meta.url)

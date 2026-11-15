# 数据湖治理配置中心

离线版数据湖治理配置工具，涵盖多源接入通道、分层表结构设计、湖区分区策略、流批转换编排、元数据编目检索与资源计量管理，所有配置持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   │   └── schedule-*.ts     编排调度领域层：表达式窗口、补偿算法、批次与落账
│   ├── tests/                node --test 用例（调度表达式、补偿数据流、页面交互）
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 编排调度：漏触发补偿

编排调度模块（`/schedule`）在原有配置列表之外补上了「补偿 → 执行批次 → 任务落账」的数据流，
核心代码在 `frontend/src/data/schedule-*.ts`：

- `schedule-time.ts`：把分钟级 5 段 cron 表达式解释成窗口边界，支持 `*`、`*/N`、固定值、列表、
  区间星期以及 `@daily` 等别名；带日期/星期约束的表达式走逐日扫描。
- `schedule-engine.ts`：只读的补偿预览。先取当前启用规则（同计划多条启用规则按版本号取最新，
  历史批次保留原规则快照），展开到期窗口，再结合「上次完成位置、并发上限、失败处理」逐窗口
  比对已有批次，得出真正缺失的窗口；已排队、已完成、被手工批次覆盖的窗口不会重复生成。
- `schedule-service.ts`：补偿提交（按计划+任务+窗口幂等）、多选任务整组提交（逐条回传执行批次）、
  批次状态流转、按任务落账，以及只包含实际补偿批次的下游作业清单。
- `schedule-store.ts`：计划与规则、执行批次、任务落账分开持久化到 `lake-govern-config:schedule`。

失败批次按计划的「失败处理」决定去向：「重试」在原批次上累加尝试次数、从缺失窗口继续；
「跳过」记入跳过清单后继续；「终止」停在失败窗口，后续窗口全部标记为阻塞。相同补偿窗口
重复到达时幂等键相同，不会产生第二条批次。

批量转换页（`/batch`）底部的「下游作业清单」只消费 `origin` 为补偿的批次。

测试：

```bash
cd frontend
npm test
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 数据编目 | `catalog` | 数据目录 | 编目编号、数据集名称、存储路径 |
| 多源接入 | `ingest` | 接入通道 | 通道编号、源端类型、连接参数 |
| 原始层管理 | `bronze` | 原始表 | 表编号、来源通道、目标路径 |
| 清洗层管理 | `silver` | 清洗表 | 表编号、上游原始表、清洗脚本 |
| 聚合层管理 | `gold` | 聚合视图 | 视图编号、上游清洗表、聚合维度 |
| 湖区分区 | `lakezone` | 分区方案 | 方案编号、目标表名、分区字段 |
| 流式处理 | `stream` | 流处理作业 | 作业编号、输入Topic、处理逻辑 |
| 批量转换 | `batch` | 批处理任务 | 任务编号、输入路径、处理脚本 |
| 版本快照 | `snapshot` | 快照记录 | 快照编号、目标表名、快照时间 |
| 湖仓治理 | `govern` | 治理规则 | 规则编号、治理对象、治理类型 |
| 元数据中心 | `meta` | 元数据条目 | 条目编号、对象类型、对象名称 |
| 血缘图谱 | `lineage` | 血缘节点 | 节点编号、节点类型、节点名称 |
| 质量监控 | `quality` | 质量指标 | 指标编号、监控对象、指标类型 |
| 编排调度 | `schedule` | 编排计划 | 计划编号、任务列表、依赖图定义 |
| 历史回填 | `backfill` | 回填作业 | 作业编号、目标表名、回填起始 |
| 数据检索 | `search` | 检索索引 | 索引编号、索引名称、覆盖表名 |
| 资源计量 | `resource` | 计量记录 | 记录编号、计算引擎、作业名称 |
| 操作审计 | `audit` | 审计日志 | 日志编号、操作类型、操作对象 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.tsx`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`；编排调度走 `frontend/src/data/schedule-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `lake-govern-config:entries` 这一项，或调用 `resetModule(模块)`。

领域：数据工程
子方向：数仓与数据湖

# 设计文档：订票 Agent 工作台（暂名 TripDesk）

> 目标：做一个类似 [adits](https://adits.ai) 的产品，但围绕**机票预订全流程**，有自己的 UI。
> 本文档是动手前的方案，先评审再实现。
>
> 本阶段范围（已拍板）：**新仓库、借用 adits 架构、本地单机优先、不碰托管多用户/支付合规**。
>
> ⚠️ **实现现状（2026-06，与下文方案有出入，以此为准）**：① 卡片组件实际在 `src/components/`（非 §6 的 `src/app/domain-views/`）；② 后端主线已从"本地 spawn claude"**转到 rebyte 托管 relay**（§3 的本地架构图只对 `local` 模式适用；frames/卡片层不变）。运行/架构/现状以 **CLAUDE.md** 为准；本文留作产品与卡片设计参考。

---

## 1. 背景：从 adits 学到什么

adits 不是"设计工具"，本质是一个 **「把编码 agent 丢进项目文件夹、用 UI 帮你拼下一句 prompt」的编排器**。核心三件套：

1. **agent 即 runtime**：后端 `spawn('claude', ['-p', '--output-format', 'stream-json', ...])`，把 Claude Code CLI 当子进程跑在 `projects/<id>/` 目录里（`adits/server/backend/local/task-runner.ts:78`、`commandForExecutor` 在 `:62`）。可按 turn 换 Gemini/Codex。
2. **turn 模型**：`tasks`(会话) → `prompts`(每一轮) → `frames`(每行 stream-json 输出)。前端用 **SSE**（`GET /prompts/:id/stream`）实时读 frames（`adits/server/routes.ts:229`）。
3. **bench + chip composer**：右侧画布渲染 agent 产出的**文件**；用户在文件上的手势（拉滑块、圈选、评论）不直接生效，而是**攒成 chip 拼进下一句 prompt**，整批发给 agent。"chat 装对话，bench 装文件"。

### 关键洞察（决定本设计）

**我们不需要替换 agent，也不需要自己写 MCP 客户端。**

- travelkit 本身就是一个 HTTP MCP server（`.mcp.json` → `https://mcp.travelkit.ai/mcp`）。
- Claude Code CLI 原生消费 `.mcp.json` + `.claude/skills/`。
- 所以 adits 已经在做的"把 claude CLI 丢进带配置的文件夹"**正好就是订票 agent 的运行方式**——本仓库里的对话（搜索→验价→收集乘客信息）走的就是这套。

> **结论：复用 adits 的 agent 编排内核（spawn + stream-json + turn + SSE + chip），真正重做的是 bench——从"渲染文件"换成"渲染订票领域状态"，外加订票独有的支付/PII/确认闸。**

---

## 2. 复用 vs 重做

| adits 部件 | TripDesk | 改动量 |
|---|---|---|
| spawn claude `-p` + stream-json | 完全照搬 | ✅ ~0 |
| tasks/prompts/frames + SSE 流 | 照搬（turn 就是 turn） | ✅ ~0 |
| session resume（同会话续连） | 照搬，且**更重要**（验价 orderKey 有时效） | ✅ ~0 |
| chip composer（手势→下一句 prompt） | 核心复用，换 chip 种类 | 🟡 改 |
| system.md（设计师人设） | 换成 travelkit skill（仓库已有） | 🟡 换内容 |
| FileStore + file-types 渲染文件 | **重做**：渲染搜索结果/订单/支付/售后 | 🔴 主要工作 |
| design-systems / building-skills | **删掉**（设计领域专用，与订票无关） | 🔴 剥离 |
| 无支付 / 无 PII | **新增**：真钱、真证件、幂等、确认闸 | 🔴 全新 |

---

## 3. 架构

```
┌─────────────────────────────────────────────┐
│  前端 (React + Vite)                          │
│  ┌──────────────┐   ┌────────────────────┐   │
│  │ Chat (左)     │   │ Bench (右)          │   │
│  │ - 对话历史    │   │ - 搜索结果表        │   │
│  │ - Composer    │   │ - 验价详情卡        │   │
│  │   + chips     │   │ - 乘客信息表单      │   │
│  └──────────────┘   │ - 订单/支付状态     │   │
│         │           │ - 售后(退/改/行程单) │   │
│         │           └────────────────────┘   │
│         │ 手势→chip→prompt   ▲ 解析 frames    │
└─────────┼────────────────────┼───────────────┘
          │ POST /tasks/prompts │ SSE frames
┌─────────▼────────────────────┴───────────────┐
│  后端 (Hono + tsx)                            │
│  - routes: tasks/prompts/stream/cancel        │
│  - task-runner: spawn claude -p (local)       │
│  - SQLite/Postgres: tasks/prompts/frames      │
└─────────┬─────────────────────────────────────┘
          │ spawn, cwd = projects/<id>/
┌─────────▼─────────────────────────────────────┐
│  claude CLI 子进程                             │
│  cwd 里有: .mcp.json(travelkit) +              │
│            .claude/skills/travelkit/           │
│  → 调用 flight_search / verify / create / pay  │
└─────────┬─────────────────────────────────────┘
          │ HTTP MCP
          ▼  https://mcp.travelkit.ai/mcp
```

### 3.1 项目目录布局（每个会话一个文件夹）

```
~/.tripdesk/projects/<id>/
  .mcp.json                 # travelkit MCP（key 从环境注入，不落盘进 git）
  .claude/skills/travelkit/ # 复用本仓库的 skill（软链/拷贝）
  state/                    # agent 可选落盘的领域状态快照（见 §4 方案讨论）
```

### 3.2 后端骨架（借 adits，砍掉文件领域）

- `task-runner.ts`：`spawn('claude', ['-p','--permission-mode','bypassPermissions','--output-format','stream-json','--verbose','--include-partial-messages', resume?'--resume':'--session-id', sid, prompt])`，cwd 指向项目目录。**几乎逐行照搬 adits 的 claude 分支。**
- DB：`tasks / prompts / frames` 三张表照搬。本地用 SQLite 即可（adits 的 `db.ts` 已有方言抽象）。
- 路由：`POST /projects/:id/tasks`、`POST /tasks/:id/prompts`、`GET /prompts/:id/stream`(SSE)、`POST /tasks/:id/cancel`。

---

## 4. Bench：从"文件"到"订票领域状态"（本设计的核心）

### 4.1 数据来源：解析 frames 里的 tool_result（推荐）

stream-json 流里本来就有每次 MCP 工具调用的 `tool_use` 和 `tool_result`。前端/后端识别是哪个 travelkit 工具，把结构化 JSON 渲染成对应卡片。**UI 永远是工具结果的镜像，agent 无需额外写文件。**

> 备选方案 B：让 agent 把视图写成 `state/results.json` 等落盘，bench 像 adits 渲染文件。改动更小但多一跳、且与 skill"不暴露内部字段"易冲突。**采用方案 A。**

### 4.2 领域状态机（bench 按当前阶段切换视图）

```
  搜索 ──→ 选项已选/验价 ──→ 收集乘客 ──→ 待支付订单 ──→ 已出票
   │                                                      │
   └─(改条件重搜)                                  售后：退票/改签/发票/行程单
```

| 阶段 | 触发工具 | bench 渲染 |
|---|---|---|
| 搜索 | `flight_search` | 6 列结果表（选项/航班/行程/时间/舱位/价格），按 skill 的展示规则 |
| 验价 | `flight_verify_solution` | 验价详情卡：最终价(票面+税)、行李额、退改规则、低余票提醒 |
| 收集乘客 | （无工具，skill 引导） | 乘客信息表单（国内证件 / 国际护照两套字段） |
| 下单 | `flight_create_order` | 订单卡 + **二次确认闸** |
| 支付 | `flight_pay_order` | 支付方式选择 + 状态 |
| 售后 | `flight_refund_* / change_* / download_itinerary / invoice` | 对应操作面板 |

### 4.3 chip composer：手势如何回传

复用 adits 的 chip 机制，把 UI 手势变成下一句 prompt：

- 用户点结果表"选项 1 预订" → composer 拼出 prompt「预订选项 1」→ 发给 agent → agent 自己拿内部映射去验价/下单。
- **内部 ID（`solutionId`/`orderKey`/`PNR`/票号）全留在 agent 侧，永不进 UI、不进 URL、不进 chip。** 这与 skill 的红线一致，也与 adits"内部 ID 不暴露"一致。
- 表单提交、支付方式选择、确认退票等，同样转成 prompt（写操作必须经 §5 确认闸）。

---

## 5. 订票独有的硬问题（adits 没有）

| 问题 | 方案（本地单机阶段） |
|---|---|
| **写操作确认闸** | 下单/支付/退改前，bench 弹**不可跳过的二次确认**；确认动作生成带摘要的 prompt（金额=票面+税、航班、乘客）。对齐 skill"每次写操作显式确认"。 |
| **真 PII（证件/手机/邮箱）** | 本地阶段：只存在项目目录、不进 git（`.gitignore` 已忽略 `.env`/`*.key`，需补充忽略 `state/`、乘客信息）。**不做明文日志**。上线前再上加密存储+最小化采集。 |
| **幂等 / 防重复扣款** | 下单/支付带幂等键（agent 侧已有 idempotency 概念）；UI 上写操作按钮提交后立即禁用，靠 SSE 回来的真实状态解禁，不靠乐观更新。 |
| **会话时效（orderKey）** | 验价→下单必须同一 claude session 内完成；复用 adits session resume。若 turn 间隔过久导致 orderKey 失效，agent 重新验价（skill 已规定）。 |
| **状态对账** | frame 是"对真实世界的副作用"，不是纯产出。订单状态以 MCP 返回为准，UI 不臆测；必要时 `flight_order_detail` 刷新。 |

---

## 6. 前端文件类型 → 领域卡片组件

照搬 adits `src/app/file-types/` 的注册表思路（一个组件 = 一种渲染），但注册的不是文件类型而是 travelkit 工具结果类型：

```
src/app/domain-views/
  index.ts            # 注册表：tool name → 渲染组件
  search-results.tsx  # flight_search
  fare-detail.tsx     # flight_verify_solution
  passenger-form.tsx  # 收集乘客（含确认闸前置）
  order-card.tsx      # flight_create_order / order_detail
  payment.tsx         # flight_pay_order
  aftersale/          # refund / change / itinerary / invoice
```

新增一种 travelkit 流程 = 加一个组件 + 注册一行，和 adits"加文件类型"一样。

---

## 7. 分阶段路线图

- **M1 — 最小链路（验证可行性）**：聊天框 + 后端 spawn claude + SSE；bench 只做"搜索结果表"一种卡片；chip 只支持"选项 N 预订"。目标：跑通『前端读 stream-json 渲染卡片 + chip 回传 prompt』。
- **M2 — 完整下单到支付**：补验价卡、乘客表单、订单卡、支付面板、二次确认闸、幂等。目标：本地能从搜索一路走到模拟/真实支付。
- **M3 — 售后**：退票/改签/发票/行程单面板。
- **M4（后续，超出本阶段）**：托管多用户、鉴权、支付合规、PII 加密存储——参考 adits 的 rebyte/Clerk/Stripe 路径。

---

## 8. 待定 / 风险

- **stream-json 里 tool_result 的稳定性**：travelkit 返回结构若变，卡片会碎；M1 先验证解析链路。
- **skill 不暴露 ID vs UI 需要驱动**：已用 chip 模型化解（ID 留 agent 侧），需在 M1 实测确认 agent 能稳定从"选项 N"反查映射。
- **支付**：本地阶段是否接真实支付待定；建议 M2 先用 travelkit 的真实下单但**支付环节人工确认/沙箱**，避免误扣款。
- **技术栈**：默认照搬 adits（React 19 + Vite + Hono + SQLite）。如要换栈需在动手前定。
```

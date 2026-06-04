# CLAUDE.md

AI 机票预订工作台（TripDesk）：左聊天、右 bench 渲染订票领域状态。agent 走完整在线机票流程（搜索→验价→下单→支付→售后），数据来自 **TravelKit MCP**（`https://mcp.travelkit.ai/mcp`）。产品与卡片设计见 **DESIGN.md**。

## 跑起来

```bash
pnpm install      # better-sqlite3 是原生模块，已在 pnpm.onlyBuiltDependencies 允许编译
pnpm dev:all      # vite(4000) + server(4001) → http://127.0.0.1:4000
pnpm typecheck    # tsc --noEmit
pnpm build        # vite build（远程访问看的是这个产物）
```

机密放 `.env.local`（gitignored，**永不提交/打印**）：`REBYTE_API_KEY`、`TRIPDESK_BACKEND`、`TRIPDESK_PAYMENT_MODE` 等。

## 架构

- 前端 React+Vite(4000)，后端 Hono+SQLite(4001)，`/api/app/*` 走代理。
- **后端选择** `TRIPDESK_BACKEND`（`server/env.ts`）：
  - `local` —— 后端 `spawn claude -p --output-format stream-json`（`server/task-runner.ts`），cwd=`~/.tripdesk/projects/<id>/`（seed `.mcp.json`+travelkit skill）。
  - `rebyte` —— agent 跑在 rebyte 托管 relay（`api.rebyte.ai/v1`，`API_KEY` 头）。**整条订票路已在 rebyte 验证跑通**（`pnpm test:rebyte:full`）。
- **领域状态机** `src/frames.ts`：解析 stream-json / relay 事件里的 travelkit `tool_result`，派生 `stage`(search/verify/order/payment) + 各阶段数据 + `notice`。**UI 是工具结果的镜像**，agent 不额外写文件。
- **bench 卡片**（`src/components/`）：`SearchResultsTable`、`FareDetailCard`（验价卡）、`PassengerForm`、`ConfirmGate`（二次确认闸）已有；订单卡 / 支付面板 / 售后待做。`Bench.tsx` 按 stage 切视图，`Composer.tsx` 把 UI 手势拼成下一句 prompt 回传 agent。
- **内部 ID（solutionId / orderKey / PNR / 票号）全留 agent 侧**，永不进 UI / URL / chip。

## rebyte 集成（后端工作时）

- SDK `POST /v1/tasks` 统一走 **agent-loop**：manager 先跑，需编码时**委派**沙箱子 agent（`coding_agent__run_claude_code_in_sandbox` / `run_codex_in_sandbox`）；**travelkit `flight_search` 在子 agent 里**，父任务事件流只见委派 + 最终文本。
- 取结果：`/events`（SSE，`Accept: text/event-stream`）或轮询 `/content?include=events`。事件信封 `{seq,eventType,payload}`，eventType ∈ thinking/tool_use/tool_result/text/result，末 `done{status,lastSeq,finalResult}`。
- 测试：`pnpm test:rebyte`（L0 存活 + L1 鉴权 + L2 manager 往返，秒级）、`pnpm test:rebyte:full`（+L3 全链路 travelkit，会开 VM/烧额度）。诊断脚本都在 `server/rebyte/`。
- **下一步**：写 `server/rebyte/task-runner.ts`（`POST /tasks` + 消费 `/events` 或轮询 `/content` → 灌进 `frames` 表）+ 后端选择器，前端卡片零改动。webhook 暂不做（走 SSE/轮询）。

## 约定（skill 红线）

- 先搜索 → 实时验价 → 验价过了才收乘客证件；**写操作（下单/支付/取消/退/改）每次都要用户明确确认**（`ConfirmGate`）。
- 接口没返回的数据（行李额、退改规则等）如实说"未返回"，不要编。
- 默认**简体中文**回复。
- 支付：`TRIPDESK_PAYMENT_MODE=sandbox` 禁真实支付。

## 远程访问（Tailscale Serve）

- `https://finn-mini-v2.tigris-bigeye.ts.net:8443/`（仅本 tailnet）= Hono(4001) + 生产构建；改前端后要重 `pnpm build` 远程才更新。
- ⚠️ **别动 `:443`**（那是 tmux-mobile 手机网关，属生产）；TripDesk 只用 `:8443`。

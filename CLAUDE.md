# CLAUDE.md

AI 机票预订工作台（TripDesk）：左聊天、右 bench 渲染订票领域状态。agent 走完整在线机票流程（搜索→验价→下单→支付→售后），数据来自 **TravelKit MCP**（`https://mcp.travelkit.ai/mcp`）。产品定位/用户/原则见 **PRODUCT.md**；视觉设计系统（色板/字体/组件，kami house style）见 **DESIGN.md**。

## 这是什么：Rebyte 能力的模板 demo（先读这条）

TripDesk 不是"一个订票应用"——它和姊妹项目 **adits**（`../adits`，做设计）是同一套东西的两个垂直示例：**真正卖的是 Rebyte 的能力**——① 跑 agent，② 跑 VM 沙箱，③ 跑你私有 skill。每个 demo = 这套能力 + 为某场景配的一套 UI。换场景 = 换 skill + 换 key/API + 配套卡片，所以**业务 UI/skill 与「Rebyte 连通/存储」要彻底解耦**：改动越往前者集中、越不碰后者越好。部署主打 **Cloudflare**，存储/后端保持平台无关，可按场景切 **AWS/GCP**。

## 跑起来 & 部署

```bash
pnpm dev          # vite(4000) + wrangler dev(8787, 本地 Worker+D1+DO)，前端 /api/app/* 代理到 8787
pnpm typecheck    # tsc --noEmit（predeploy/pretypecheck 会先 gen:seed）
pnpm build        # vite build → build/（wrangler deploy 上传的就是这个）
```

Node 固定 **22**（`.node-version`）。机密**永不提交/打印**：
- `.env.local`（CLI 诊断脚本用，走 `server/env.ts`）：`REBYTE_API_KEY` 等。
- `.dev.vars`（`wrangler dev` 用）：`REBYTE_API_KEY` + `DEV_EMAIL`（本地绕过 Access，扮演该 email）。
- `cloudflare.env`（部署用，gitignored）：`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`。
- 线上 `REBYTE_API_KEY` 是 Worker secret（`wrangler secret put`）。

**部署**（线上 `https://tripdesk.impo.ai`，Cloudflare Access OTP 网关后）：
```bash
set -a; . ./cloudflare.env; set +a && pnpm run deploy
```
踩过的坑：
- wrangler **没登录**、shell 里也没 token；必须先 source `cloudflare.env`。
- 用 **`pnpm run deploy`**，别用 `pnpm deploy`（被 pnpm 内建命令拦截）。
- 部署输出 **`No targets deployed` 是无害的**：`workers_dev:false` 且 wrangler.jsonc 无 `routes`（token 缺 zone Workers-Routes 权限，自定义域是**账号级 API 外挂**，别往 config 加 routes 否则 403）；活动部署照样指向新 version。
- 验证：`wrangler deployments list` 最新条目应是 `(100%) <Current Version ID>`；`curl -so/dev/null -w '%{http_code}' https://tripdesk.impo.ai/` → `302`（跳 cloudflareaccess.com = worker 活着、Access 正常）。
- schema 改了才需 `pnpm db:migrate`（远程 D1）/ `pnpm db:migrate:local`。

## 架构

- **全栈 Workers**：`worker/index.ts`（Hono，组合根）挂 `server/routes.ts`（`/api/app/*`），其余落 SPA（`build/`）。Access JWT 校验在 `worker/auth.ts`（jose）。
- **存储 = D1**：`server/store-d1.ts` 实现异步 `Store`（`server/store.ts`），`server/db.ts` 唯一出口 `createD1Store(env.DB)`。`wrangler dev` 给本地 D1，所以 dev 也是它，无单独 sqlite 驱动。三表 `tasks/prompts/frames`。pg/mysql（AWS/GCP）= 加同接口的 `store-<driver>.ts`，call site 不变。
- **每任务一个 Durable Object** `TaskDO`（`worker/task-do.ts`）：turn 跑在 `alarm()` 里（`ctx.waitUntil` 长 turn 会被驱逐），分 20s 窗口流式推进，进度持久化（relayTaskId/lastSeq）可幂等续。**一个 session 复用同一个 relay task**：首轮 `POST /tasks`，续轮 `POST /tasks/:tid/prompts`——这样 agent 保留多轮上下文。
- **领域状态机** `src/frames.ts`：把 relay 事件翻译成的 stream-json frame 里的 travelkit `tool_result` 解析成 `stage`(search/verify/order/payment) + 各阶段数据 + `notice`。**UI 是工具结果的镜像**，agent 不额外写文件。
- **bench 卡片**（`src/components/`）：`SearchResultsTable`/`FareDetailCard`/`PassengerForm`/`ConfirmGate` 已有；订单卡/支付/售后待做。`Bench.tsx` 按 stage 切视图，`Composer.tsx` 把 UI 手势拼成下一句 prompt。
- **内部 ID（solutionId/orderKey/PNR/票号）全留 agent 侧**，永不进 UI/URL/chip。

## rebyte 集成

- `POST /v1/tasks` 走 **agent-loop**：manager 不直连 travelkit MCP，而是**委派**沙箱子 agent（`coding_agent__run_claude_code_in_sandbox`）去调 `flight_search`；父任务事件流只见委派 + manager 散文总结。鉴权用 `API_KEY` 头（非 Bearer），client 见 `server/rebyte/client.ts`。
- **不传 `model` / `executor`**：`/v1/tasks` 直接 `void` 掉这俩字段（cctools `relay/src/routes/v1/tasks.ts`，仅为旧客户端向后兼容保留）。模型是 **org 级**的（`org_settings.agent_loop_model`，默认 `claude-sonnet-4.6`，可选含 `deepseek-v4-pro`），**在 rebyte 管理台切，不在代码里传**。所以 POST 体只发 `{prompt, workspaceId}`，自动跟随 org 当前模型。
- 取结果：`/tasks/:id/events`（SSE，`Accept: text/event-stream`），信封 `{seq,eventType,payload}`，eventType ∈ thinking/tool_use/tool_result/text/result，末 `event:done {status,finalResult}`。**注意空 done 竞态**：连得太早 relay 回个无前置事件的空 done（非终止），要按"本连接收到过事件才算 done"判（`task-do.ts streamWindow`、smoke/multiturn 都这么守）。
- 每用户一个沙箱，首轮在 DO 里按需 provision + seed travelkit（纯 fetch，不用 SDK；`worker/seed.ts`），存 `agent_computers` 表。
- 测试：`pnpm test:rebyte`（L0 存活+L1 鉴权+L2 manager 往返，秒级）；全链路回归 `pnpm test:rebyte:multiturn`。数据层卡片探针 `node --import tsx server/rebyte/cardprobe.ts`（开 VM/烧额度）。
- **已知约束（REBYTE-ISSUE.md）**：经 agent-loop，结构化 `flight_search` 结果**到不了父任务**（含 `solutionId`），父级只拿到 manager 的中文散文表 → **搜索/验价卡渲染不出（数据层缺料，非前端 bug）**；聊天文本正常。`cardprobe.ts` 在数据层证实过。这是 rebyte 侧 issue，待解（直调路 / relay 不过滤子事件 / 用 `subPromptId` 捞子 agent 结果）。
- **待 rebyte 平台支持（REBYTE-NEEDS.md）**：① 沙箱 env 注入——`settings.json` 的 `env` 不进 agent shell，现靠 seed 一个 `/code/.simplifly.env` + `SKILL.md` 加一句兜底；② skill 更新——envd 无 DELETE，老沙箱换不干净，现靠覆写废弃文件 / 换新 VM。**vendored 的 skill 别动**（只许那一句 Credentials 指引）。

## 约定（skill 红线）

- 先搜索 → 实时验价 → 验价过了才收乘客证件；**写操作（下单/支付/取消/退/改）每次都要用户明确确认**（`ConfirmGate`）。
- 接口没返回的数据（行李额、退改规则等）如实说"未返回"，不要编。
- 默认**简体中文**回复。
- 支付走**沙箱/演示**：可发起支付返回第三方链接给用户自行完成，**绝不替用户付款、也绝不谎称已付**。

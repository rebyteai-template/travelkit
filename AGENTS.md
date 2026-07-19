# TravelKit Repository Instructions

先读 [README.md](./README.md) 了解当前架构，再按 [PRODUCT.md](./PRODUCT.md) 和 [DESIGN.md](./DESIGN.md) 处理产品与视觉问题。代码事实优先于历史 TODO 和旧问题记录。

## 当前系统事实

- UI 是“会话侧栏 + 单列聊天流”，领域表格、推荐和写操作流程都在聊天内联渲染；没有独立右侧 bench。
- 航班能力来自 `simplifly-flyai-skill` CLI 直连 Simplifly Flight OpenAPI，不是 TravelKit MCP。
- Skill 由 Rebyte skills v3 从 `TravelKit-AI/simplifly-flyai-skill` 的远端 `main` 安装。改 Skill 要在 sibling repo 提交并 push；不要把 Skill 逻辑复制进 TravelKit。
- 当前鉴权是 `worker/index.ts` 的 embed handoff：`k`（配置 `EMBED_KEY` 时）、`uid`、`org`、`token`。`worker/auth.ts` 的 Cloudflare Access JWT 不在请求链上。
- `TaskDO.replaySubPrompt()` 已能把子会话结构化 `tool_result` 回放进父任务。不要再按“结构化结果回不来”的旧假设设计 fallback。

## TravelKit dev + Playwright CLI 固定流程

当用户说“启动 / 拉起 dev TravelKit”“用 Playwright CLI 打开 dev TravelKit”或要在 dev 手工跑 case 时，必须执行本节。不要把普通裸 localhost 页面当作 dev TravelKit。

### 1. 启动前确认

1. 运行 `command -v playwright-cli`、`playwright-cli --help`、`playwright-cli list`；只使用全局 `playwright-cli`。
2. 阅读本仓库 `README.md`，使用 Node 22。
3. TravelKit dev 是本地 UI/Worker + dev D1；Rebyte 环境与 VM 和 production 共享。当前仓库应运行 `pnpm rebyte:prod` 让 `.dev.vars` 指向共享 Rebyte API，再启动 `pnpm dev`。不能因为产品叫“dev TravelKit”就改接 `127.0.0.1:34567` 的 cctools dev relay。
4. 必须取得用户当前的真实 `uid`、`org` 与有效 `token`。完整 Trailhead handoff URL 可以提供这些值；若用户说明 URL 中的 `uid/org` 只属于 production，则只取 token，dev 的 `uid/org → VM` 映射由 TravelKit dev D1 独立维护。
5. 如果没有 token，或 token 已过期，停下来向用户索取新的 Trailhead handoff/token。不能用测试值、旧 token、其他用户 token 或 `local:manual-test` 顶替。

### 2. 正确打开浏览器

1. 生成本地 handoff URL：origin 使用 `http://127.0.0.1:4000/`；`uid/org` 使用 TravelKit dev 要维护的真实映射键；`token` 使用用户提供的当前有效 Simplifly token；需要时带 `k`。不得在日志或聊天中打印 fragment/token。
2. 使用固定命名的可见 session，例如：
   `playwright-cli -s=travelkit-dev open <local-handoff-url> --browser chrome --headed --persistent --profile <project-profile>`。
3. 需要用户接手时，headed Chrome 必须真实打开并切到前台；后台 headless session 或 `playwright-cli show` 不算完成。
4. SPA 清除 fragment 后，只检查 `sessionStorage` 是否存在 `td_uid`、`td_org`、`td_tk`。可以显示 `uid/org` 用于核对，绝不能显示 `td_tk` 的值。
5. `uid/org` 必须是用户要测试的真实映射键。看到 `local:manual-test` 就立即停止，它只适合纯 UI 本地测试，不能运行真实 Skill。

### 3. `org+uid → Rebyte VM` 映射核对

1. `org + uid` 是 TravelKit 的用户映射键。TravelKit dev D1 与 production D1 分别维护各自的 `agent_computers` 记录，不能复制、查询或修改错的数据库。
2. Rebyte 环境与 VM 是共享的，不存在独立的“dev VM / prod VM”。本地 dev D1 的映射最终可以指向用户已经存在的共享 Rebyte workspace/VM。
3. 首个 case 前，只读核对本地 dev D1：`user_email` 必须等于 `<org>:<uid>`；其 workspace 名称应为 `tripdesk:<org>:<uid>`，并有对应 sandbox/VM。不能用 `local:manual-test` 的记录，也不能把另一个用户的 VM 绑定过来。
4. 如果 dev D1 没有该用户映射或映射已经失效：
   - 共享 Rebyte 中已有 `tripdesk:<org>:<uid>` 时，将 **dev D1 当前用户记录** 绑定到该 workspace/sandbox；
   - 共享 Rebyte 中确实没有时，才通过受支持的 `POST /api/app/debug/new-sandbox` / UI“新 VM”流程 provision，并写入 dev D1；不能清空整库。
5. 新 VM 或重新绑定只在 **下一个新会话** 生效。完成后点击“新会话”，再提交 case。

### 4. token 与 Skill 的关系

- handoff `token` 会被 TravelKit 写入该用户 VM 的 `.simplifly.env`，是 `simplifly-flyai-skill` 调用 Simplifly Flight API 的 bearer token。
- Rebyte 登录成功不代表 Skill token 有效。若 trace/结果出现 Simplifly 401/403、`invalid token`、`token expired` 或所有航班请求统一鉴权失败，停止重试并向用户索取新的 Trailhead dev token/handoff。
- 获得新 token 后，用真实 `uid/org` 重新打开本地 handoff；TravelKit 会比较 token hash 并刷新映射到的同一用户 VM 凭证。随后必须新建会话再跑 case。
- token 永远不能出现在命令输出、截图、日志、提交或聊天中。

### 5. 交付前检查

- 可见 headed Chrome 已在前台，页面不是“无法访问 Kitty”。
- `uid/org` 是目标 dev 用户，绝不是 `local:manual-test`。
- TravelKit 使用 dev D1，但 Rebyte endpoint/VM 是与 production 共享的；当前 dev D1 映射到正确用户的共享 VM。
- 页面停在空白“新会话”；新会话会从远端 `main` 安装最新 Skill。
- 只有以上全部成立，才告诉用户“可以跑 case”。

### 6. 故障定位顺序

严格按以下顺序排查，不能看到 500 就先改 Skill 或跑数据库 migration：

1. handoff 身份是否正确；
2. token 是否存在、是否过期；
3. 是否误把 TravelKit dev 接到了 cctools dev relay，而不是共享 Rebyte；
4. dev D1 的 `<org>:<uid>` 是否映射到正确用户的共享 workspace/VM；
5. 共享 Rebyte relay/VM/runtime 是否健康；
6. 最后才检查 schema migration、Skill 安装和 Skill 业务逻辑。

## 推荐边界

- `flight-recommendations/v1` 是唯一权威最终推荐；search/pricing/verify 是中间证据。
- TravelKit 只做契约与安全校验：版本、字段、唯一 `planId`、人数、票组覆盖、币种、总价、capability。
- TravelKit 不评价方案质量，不按价格、时间窗、经停次数或本地时钟删除、合并、重排方案，也不根据 `partial` 或 `budgetStatus` 自行生成业务警告。
- 有方案时原样渲染；只有 Skill 明确提供 `message` 或 `reason` 时才展示说明。推荐不好、缺直飞或排序不合理，一律修 FlyAI Skill。
- 同一用户轮次若出现多个不同的 plan-bearing `flight.recommendations`，视为 Agent 拆分了最终推荐协议并 fail closed；不得静默采用最后一个，也不得在 TravelKit 合并。相同结果的事件回放可去重。
- 不从 Agent Markdown 或 tool event 顺序推断最终航班事实。

## 安全红线

- 写操作（下单、支付、取消、退票、改签）执行前必须获得用户明确确认。
- API 未返回的行李、退改、中转信息不得编造。
- `solutionId`、`orderKey`、PNR、票号可以在内部工作台流转；token、环境变量、请求头和凭证文件内容绝不进入 UI、日志、提交或聊天。
- 不替用户付款，不谎称支付成功。

## 常用命令

```bash
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm db:migrate:local   # 仅 schema 变化时
```

Node 固定 22。保留工作区中与当前任务无关的用户修改；不要用破坏性 git 命令清理它们。

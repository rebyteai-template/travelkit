# 需要 rebyte 平台支持的能力（开放项）

> 这些是 TripDesk 目前靠「临时旁路」绕过、但本该由 rebyte 沙箱平台**原生支持**的能力。
> 旁路都收敛在我们自己的层（`worker/seed.ts`、UI），未改动 vendored 的 travelkit skill 主体
> （仅在 `SKILL.md` Credentials 段加了一句指引，见下）。
> 另见 `REBYTE-ISSUE.md`（agent-loop 结构化结果无法到达父任务，是独立的另一个问题）。

---

## 1. 沙箱 env 注入：`.claude/settings.json` 的 `env` 不进 agent 的 shell — 已用文件契约绕开 ✅

**现象**：早期我们把每用户的 Simplifly 凭证写进沙箱 `/code/.claude/settings.json` 的 `env` 块，
期望无头 Claude Code 把 `SIMPLIFLY_BASE_URL` / `SIMPLIFLY_AUTH_TOKEN` 注入到 agent 的 bash 环境。
实跑发现**根本没注入**——子 agent `env | grep SIMPLIFLY` 为空，于是它到处翻 `.env*` / home
目录都找不到、放弃，导致整条机票流程拿不到 token 跑不起来。

**解决（2026-06-08，已落实）**：换用 `travelkit-pro` skill，它**不再依赖 shell env var**，而是自己
从 CWD 向上找最近的 `.simplifly.env` **dotenv 文件并直接解析**。于是 rebyte 那个 env 注入 gap 变得
无关紧要。代码侧已对齐：`worker/seed.ts` `credentialsEnv()` 写**纯 `KEY=value`** 的 `/code/.simplifly.env`
（去掉了 `export` 前缀和 `source` 兜底注释），**删掉**了 `.claude/settings.json` 的 `env` 镜像写入
（`settingsJson()` 已移除），CLI 探针 `server/rebyte/seed.ts` 同步改写。`STALE_FILES` 增加
`.claude/settings.json` + 旧 `.claude/skills/travelkit/**`，re-seed 时真删。`CREDENTIAL_SCHEMA` bump 到
`v2` 触发存量沙箱 re-seed。**vendored skill 不再需要任何 Credentials 旁路指引**（旧的那句 `source` 已无）。

**`.simplifly.env` 契约**（`travelkit-pro` repo `rebyteai-template/skills-travelkit-wfl` 的
`SKILL.md` Core Boundaries + `references/api-map.md`，我们 seed 侧据此写文件）：

- 从 CWD **向上逐层找最近的 `.simplifly.env`**，按标准 dotenv 解析；不许 hardcode 绝对路径。
- 若最近的 `.simplifly.env` 落在 `skills/` 目录内 → 视为非法位置拒用（必须放在 skill 包外）。
  我们写 `/code/.simplifly.env`（在 `/code` 根、CWD 向上可达、在 `.claude/skills/` 外）即满足。
- skill 绝不创建/改/输出该文件（=我们 seed 写的外部私有配置）；缺了就停并让用户提供。
- 字段：`SIMPLIFLY_BASE_URL`、`SIMPLIFLY_AUTH_TOKEN`（必需）；`SIMPLIFLY_ACCEPT_LANGUAGE`
  （默认 `zh-Hans`）、`SIMPLIFLY_SF_MODE`（默认 `buyer`，可 `buyer|seller`）可选 → seed 不写，用默认。
- skill 鉴权 `Authorization: Bearer ${SIMPLIFLY_AUTH_TOKEN}`（skill 内部，不影响 seed）。

**仍是 nice-to-have（非阻塞）**：rebyte 若能把每用户 env 真正注入 agent 运行时，可省掉落地明文
`.simplifly.env` 文件。但当前文件契约已让整条流程不再受阻，**不再 block**。

---

## 2. skill 更新：已 provision 的沙箱里干净替换 skill — 已解决 ✅

**原以为的现象**：skill 搬运进沙箱 `/code/.claude/skills/...`，上游一变老沙箱拿不到新版，
因为 envd 的 **REST 文件 API `/files` 没有 DELETE（405，`allow: GET,HEAD,POST`）**，re-seed
只能「覆盖同名文件」，废弃的旧文件（如 MCP 时代的 reference 文档）残留。

**真相**：REST `/files` 确实没 DELETE，但 envd 另外暴露了 **gRPC-Web Filesystem 服务**
`filesystem.Filesystem/Remove`，它**能真删**，且接受和写入相同的鉴权（`X-API-KEY` +
`Authorization: Basic base64("user:")`，无需 JWT/team_id）。对一台 live 沙箱实测：写→200、
`Remove`→`grpc-status:0`、再 GET→404；删不存在的文件→`grpc-status:5`（当幂等成功）。

**现在的做法**：`worker/seed.ts` 的 `removeFile()` 手搓一个 gRPC-Web 一元调用（纯 fetch、零依赖、
Workers 原生，和 `writeFile` 同构）。`removeStaleArtifacts()` 改成对 `STALE_FILES` 真删，re-seed
（`seed_version` bump）时自动清理废弃文件。**不再需要**覆写 inert，也不必靠「新 VM」按钮换沙箱。
探针：`server/rebyte/removeprobe.ts`。

**为什么不用 SDK 的 `files.remove`**：rebyte-sandbox SDK 跑不进 Worker（Template 模块静态
`import fs/tar`），即便拆出 fs-free 子入口，其 gRPC ransport 还会附带 `Rebyte-Sandbox-Id` /
mint 出来的 `X-Access-Token` 等网关头，在 rebyte envd 上**反而 401**（实测）；其 REST `write`
也因响应体结构不符报错。结论：rebyte envd 网关只认我们这套 raw 鉴权，手搓比 SDK 更可靠。

**残留的小建议（非阻塞）**：若 rebyte 想让 SDK 可用，可① 给 envd 网关的 gRPC 路同样接受
`X-API-KEY`（或修正 `X-Access-Token` minting 不需 team_id）；② SDK 拆一个不含 Template 的
fs-free 入口。但 TripDesk 侧已无需求。

---

## 3. manager（front-line agent-loop）没有 per-workspace/org 的指令钩子 — 机制已落地，剩 /v1 暴露 🟡

> **更新 2026-06-13（重新核对 cctools `origin/main`，迁移 `20260531`～`20260612`）**：
> 我们当初「期望 rebyte 支持」的那几样，cctools 这几天已经整体迁到 dust 的 **MCPServerView 模型**，
> **机制层面基本都落地了**——只是公开 `/v1` API 还够不着。逐条对照：
>
> 1. **per-workspace instructions 钩子：已落地。** `workspace_as_agent.ts` 现在读
>    `workspaces.agent_instructions`，非空就**追加**在 `AUX_TRADER_SYSTEM_PROMPT` 之后
>    （`${SYSTEM_INSTRUCTIONS}\n\n${employeeInstructions}`，注释里叫它 "the employee's own
>    system prompt"，出现了**数字员工**框架）。即我们要的「在默认 manager prompt 之上追加领域指令」
>    已实现，且正是「追加」而非整替。
> 2. **per-workspace 工具开关 + 领域 MCP 直挂：已落地。** 工具不再硬编码三件套，改从
>    **`workspace_mcp_servers`** 表动态组装（每行 = 一个 MCPServerView，带 `enabled` 布尔）。
>    注册表 `INTERNAL_MCP_SERVERS` 用 `availability` 三态：`auto`（默认开、可 per-workspace 关）
>    **恰好就是 web_search / sandbox / coding_agent**；`manual` = ~40 个 opt-in 连接器。另有
>    **`remote_mcp_servers`** 表（org 级注册）可 per-workspace **挂载自定义远程 MCP**。
>    → 垂直 workspace 的配方现在物理上成立：写 `agent_instructions`（路由+人格）+ 把 web_search
>    那行 `enabled=FALSE`（掐掉误路由）+ 留 coding_agent + **把 travelkit MCP 作为 remote 挂到
>    manager 上**。最后这条若做了，还会**顺带解掉 `REBYTE-ISSUE.md`**——manager 直调 MCP，
>    结构化 `tool_result` 原样进父任务事件流，搜索/验价卡立刻有料。
> 3. **基座 prompt 没变**：`AUX_TRADER_SYSTEM_PROMPT` 一字未改，仍是通用「task routing /
>    需要外部信息就用工具」措辞，垂直人格只是 append 上去——和「绝不编造航班」会轻微打架，是次要项。
>
> **仍未解（真正的开放项）**：上面这些 primitive **全锁在 Clerk 内部路由**后——`agent_instructions`
> → `/api/workspaces`（clerkAuth）；workspace_mcp_servers 开关 + remote MCP 注册/挂载 →
> `/api/mcp`、`/api/connectors`（clerkAuth）。**公开 `/v1` 一个都够不着**：`/v1/tasks` 依旧
> `void` 掉 executor/model、不收 `agent_instructions`、自动建的 `api-task-*` workspace 拿通用 prompt
> + 三件套 auto 工具；`/v1/workspaces` 只有 artifacts 读写，**无任何 workspace 配置写路由**。
> TripDesk 只走 `rbk_*` API key 的 `/v1`，**无法纯 API 把 workspace 配成垂直 agent**。
>
> **因此对 rebyte 的诉求收窄为一件事**：把这套 per-workspace agent 配置（`agent_instructions`
> + 工具 allowlist/禁用 + remote MCP 挂载）**开到公开 `/v1`**（如 POST/PATCH `/v1/workspaces`，
> 或 `/v1/tasks` 内联同名字段），底层全部复用现成写逻辑。这件做了，下面的 `MANAGER_ROUTE_HINT`
> 旁路就能彻底拿掉。**待 cctools 侧决定（用户后续跟进）。**
>
> 注：cctools 那边我们的 WIP 分支 `fix/agent-loop-file-upload` 落后 `origin/main` 25 个 commit，
> 正好没含这次 MCP 重构；后续要动 manager 需基于最新 main。

---

**现象（历史记录，2026-06-09）**：rebyte 的请求经过**两层 agent**——① **manager**（agent-loop / dust-loop，拿到我们
POST 的 prompt，手里有 `web_search` / `sandbox` / `coding_agent` 三个工具，**决定**是 web 搜还是
委派进沙箱）；② **沙箱里的 Claude Code 子 agent**（真正干活，读 `/code/CLAUDE.md` + skill）。
我们 seed 的 `/code/CLAUDE.md`（VM system prompt）只管得了**②**；但**决定要不要走 skill 的是①**，
而当时 manager 的 system prompt 是**硬编码** `AUX_TRADER_SYSTEM_PROMPT`
（cctools `relay/src/agent-framework/cctools-impl/repos/workspace_as_agent.ts`：
`instructions: SYSTEM_INSTRUCTIONS`，写死；`workspaces.instructions` 列存在但**没接线**，
`org_custom_prompts` 只喂 system_prompt.md = 沙箱子 agent）。
〔↑ 这段已被顶部 2026-06-13 更新推翻：`agent_instructions` 现已接线并追加到基座之后。〕

**后果**：把领域指令从用户 prompt 里完全移走后，manager 对「搜索机票」没有路由依据 →
默认调 `web_search` 并**编造**航班/价格（实测：6 次 websearch、答案是「~S$110 / 建议去携程查」
的假数据，完全没碰 skill）。即「VM system prompt 解决不了 manager 的路由」。

**当前做法（临时旁路）**：在**首轮** relay prompt 前拼**一行** `MANAGER_ROUTE_HINT`
（`worker/task-do.ts`）——只做路由：「机票一律委派沙箱 travelkit-pro skill，禁用 web search」，
**不含**任何业务/安全红线（那些在 `/code/CLAUDE.md` + skill）。会随 relay task 上下文带到后续轮。
multiturn 测试加了断言：任一轮出现 `web_search` 即判失败，防回归。

**期望 rebyte 支持**：给 manager 一个 **per-workspace/org 的 instructions 钩子**——例如
`getWorkspaceAsAgent()` 把 `org_custom_prompts`（或接线 `workspaces.instructions`）追加到
`AUX_TRADER_SYSTEM_PROMPT` 之后。这样路由指令也能像 system prompt 一样配置，**用户 prompt 零污染**，
就能把那一行 `MANAGER_ROUTE_HINT` 也去掉。**待 cctools 侧决定怎么做（用户后续跟进）。**

**还观察到的两个 rebyte 侧抖动（待跟进，2026-06-09，验证 MANAGER_ROUTE_HINT 时撞到）**：
- **coding_agent 委派偶发挂起/超长**：路由提示生效后 manager 走 `coding_agent__run_claude_code_in_sandbox`，
  但有一次委派后 **240s 内父流零事件**（连 manager 的总结文本都没有）→ turn 超时。今早同路径
  ~140s 能回（manager 先用轻量 `sandbox` 工具读 skill 文档再委派），所以「直奔 coding_agent」这条
  路要么冷启动太慢要么挂。怀疑也可能与「我们用 `/code/CLAUDE.md` 整个替换 cctools 默认
  system_prompt.md，移除了子 agent 需要的操作脚手架」有关——待查（可能要改成「在默认之上追加」而非
  整替）。`TURN_TIMEOUT_MS=240s`，若 coding_agent 合法需要更久，生产 task-do 也会超时。
- **envd 文件写偶发 409 Conflict**：复用一台可能已 hibernate 的旧 VM 时，`POST /files` 写
  `.simplifly.env` 返回 409。疑似 VM 非运行态 / 文件锁，非我们逻辑问题。

> 结论：`MANAGER_ROUTE_HINT` 已让**路由**正确（不再 web_search/编造），但**端到端**受上面两个
> rebyte 侧行为影响未跑出稳定绿。代码改动已落分支，**暂不 deploy**（线上仍是 working 的 preamble 版）。

---

## 4. 交互式 UI：`ask_user_question`(R1) 对 api 来源不可用 / `interactive_content`(R2) 需开 — 开放项

核 cctools 源码（2026-06-13）为「让 agent 声明 UI / 产 HTML 报告」选型，两条结论：

**① `ask_user_question`（结构化多选）在 `/v1/tasks`（我们的 api 来源）不可用 —— 我们已决定不依赖，记录备查。**
- agent-loop 工具注册表（`relay/.../dust-loop/lib/actions/mcp_internal_actions/constants.ts`）只自动挂 `web_search_browse` / `sandbox` / `coding_agent`，无 `ask_user_question`。
- 即便实现存在，`run_model.ts` 按 origin 过滤，白名单只含 `web/slack/extension/agent_sidekick`，**`api` 不在内**。
- 若开：其 tool_use 的 `{question,options,multiSelect}` 能 verbatim 到父流（`AgentLoopPublicView` 透传）；答案回传只有 free-text `POST /tasks/:id/prompts`（无结构化 resume）。
- **TripDesk 决定砍掉 R1**：L1 解析 compact 渲染的富卡更适合「选航班」；澄清/确认走纯聊天。**故此项不阻塞，仅备查**——rebyte 若想让 api 来源也能声明式选择：把 `api` 纳入白名单 + 注册该工具即可。

**② `interactive_content`（agent 产 HTML artifact）是 opt-in，需为我们工作区开启 —— R2 北极星依赖。**
- 这是「OP 报方案报价 → 生成好看 HTML 报告 → 导 PDF 发客户」的支撑路。
- agent 用 `create_interactive_content` 产 HTML（`relay/.../actions/servers/interactive_content`）；主机用**公开端点** `GET /v1/workspaces/{wid}/artifacts[/{file}]`（`routes/v1/workspaces.ts`，存 GCS）取回；前端 iframe 渲染。**HTML→PDF 是主机的活**。
- 它是 **manualServer（per-workspace opt-in）**，默认不挂。**需要 rebyte 给我们这个工作区开启 `interactive_content` 服务**（配置级，非改码）。开了即可接 R2 报告卡。

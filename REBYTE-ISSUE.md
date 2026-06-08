# rebyte agent-loop：远程领域 MCP 工具的结构化结果无法到达父任务

> 把这份交给 rebyte / cctools 侧。两个目标：
> **(1) 复现并验证下面的现象；(2) 在此基础上研究后续如何修复。**
> 本文只描述现象与诉求，不预设实现方案。

---

## 1. 背景与用例

我们在做一个 **ToB 场景：让 agent 调用某个领域的 MCP 工具，并把该工具返回的「结构化结果」交给宿主应用去渲染、以及驱动后续多步流程。**

- demo 是机票预订。领域能力来自 **TravelKit —— 一个第三方的远程 streamable-HTTP MCP**（`https://mcp.travelkit.ai/mcp`，Bearer 鉴权）。
- 诉求是通用的：**任何垂直的领域能力，基本都会是这种「远程 HTTP MCP 工具」**（不是写代码，是调外部领域 API）。
- 运行方式：通过公开 API `POST /v1/tasks {prompt, workspaceId}` 跑在 rebyte 的 **agent-loop** 上；该领域 MCP 的配置（`.mcp.json`）被 seed 进沙箱的 `/code`。

领域工具 `flight_search` 的返回是**结构化 JSON**：一个航班选项数组，每条带 价格 / 航班号 / 时刻 / 舱位，以及一个**不透明手柄 `solutionId`**。后续的验价、下单（`flight_verify_solution` / `flight_create_order`）**必须靠这个 `solutionId`** 才能锁定同一个票价——它是整条流程的关键。

---

## 2. 现象（观察到的症状）

**触发方式**：`POST /v1/tasks`，prompt 要求用领域工具搜索（例如「搜 2026-06-20 北京到上海的直飞机票」）。

1. **manager 不直接调领域工具，而是委派**给 `coding_agent__run_claude_code_in_sandbox`，让沙箱里的 claude 去调 `flight_search`。

2. **领域工具的结构化结果到不了父任务。** 父任务经公开 API（`GET /v1/tasks/:id/content?include=events`、`/events` SSE）能拿到的只有：
   - 那个 `coding_agent` 委派的 tool_use；
   - manager 最后的一段**自然语言总结**（它把结果复述成一张中文表格）。
   - **完全看不到** `flight_search` 本身的 tool_use / 结构化 tool_result。

3. **公开 API 只返回顶层（用户发起的）那个 prompt。** 委派出去的子 agent 的 prompt 及其事件（包括它真正调 `flight_search` 的那次）**不在公开 API 的返回里**。

4. **初期更严重的一层（已在调用方绕过，但请一并验证）：** 沙箱里的 claude 在无头 `--print` 模式下**根本没加载 seed 进去的远程 MCP**（项目 `.mcp.json` 未被信任），于是 `flight_search` **从未被调用**——manager 直接**编造**了一张看似合理、实则虚构的航班表（过程里反复出现 `is_error:false` 的「空成功」）。我们在调用方补了 MCP 预信任后，工具才真的被调用；**但即便工具真调了，第 2、3 条依旧成立：结构化结果仍困在子 agent，父任务只拿到散文总结。**

**对照证据**：同一条搜索——
- **本地直跑**（claude 直接连 travelkit）：拿到约 8KB 的结构化 JSON（`data.displayOptions` 共 10 条，每条含 `solutionId`、`priceTotal`、`route` 等），`totalCount=162`。
- **经 rebyte agent-loop 跑**：父任务只有 4 个事件（委派 + 散文总结），上述结构化 JSON **无从获取**。

---

## 3. 诉求（期望 vs 实际）

- **期望**：宿主应用消费公开 API 时，**能拿到领域工具的结构化 tool_result**——用于 ① 渲染结构化界面，② 携带 `solutionId` 驱动后续多步流程。更理想的是，agent 能**直接调用领域工具**，而不必经「委派沙箱子 agent」这层间接。
- **实际**：只拿得到 manager 的一段自然语言总结。它 ① **无法被程序可靠解析**（自然语言、格式会变、字段会被改写或漏掉），② **丢失了 `solutionId`**。后果不只是 UI 渲染不了——**整条多步领域流程（验价 / 下单）也断了**，因为后续步骤拿不到锁定票价的那个手柄。

> 一句话：**agent-loop 把「调领域工具看结构化结果」变成了「委派进沙箱、只回一段总结」，结构化数据与关键句柄在这层间接里丢失/不可见。**

---

## 4. 你要做的

1. **复现 / 验证**上述现象。建议确认这几点是否属实：
   - 经 agent-loop 时，远程领域 MCP 工具的**结构化 tool_result 是否真的无法经公开 API 取到**；
   - 父任务对委派只透出 manager 的**总结文本**、不透出子 agent 的工具调用；
   - 公开 API 是否**只暴露顶层 prompt、过滤掉子 agent 事件**；
   - manager 是否**无法直连远程 MCP**（只能走委派沙箱）；
   - 无头 claude 在沙箱里**默认是否加载 seed 进去的项目 MCP**（信任问题）。
2. **在此基础上研究后续如何修复**——方案由你定。核心要回答的是：**怎样让「agent 调远程领域 MCP 工具」这个 ToB 场景，能把结构化结果（含不透明句柄）可靠地交付给宿主应用。**

---

## 附：我们的初步定位（供参考，请以你的复现为准，不必采信）

翻 cctools（`relay/`、`backend/`）得到的几条线索，仅作排查起点：

- 子 agent 的事件似乎写在与父级**不同的存储层**，公开视图按「顶层 prompt」过滤，故子 agent 的工具调用不透出。
- 父任务对该委派的记录似乎**只承载 manager 的最终总结文本**，不承载子 agent 的结构化 tool_result。
- manager 自身似乎**只能用一组内置工具**；**远程 MCP 连接在当前 cctools 里似乎是关闭/不支持的**——这可能正是它「只能委派进沙箱、不能直连领域 MCP」的原因。
- agent-loop 的定位（从其系统提示词看）更像「把活委派给 Claude Code / Codex 的代码任务路由器」，与「ToB agent 直接调领域工具」这个用例存在错配。

---

## 5. 机制定位（已读 cctools 源码确认）+ 已落地的修复

经 cctools 源码确认，结构化结果丢失发生在**两道切口**，第一道决定结局：

- **切口 1（委派工具返回边界，决定性）** —— `relay/src/agent-framework/dust-loop/lib/api/actions/servers/coding_agent/tools/index.ts:197-222`。
  `run_claude_code_in_sandbox` 把子会话全量事件经 `extractFinalResult(events)` 压成**一段 final text**，只 `return Ok([{type:"text", text:finalText}])`。manager 从这一刻起就没拿到结构化数据。
- **切口 2（公开 API 投影）** —— `relay/src/routes/v1/tasks.ts` 的 `/events`、`/content` 与 `relay/src/services/AgentLoopPublicView.ts` 都硬过滤 `parent_prompt_id IS NULL`，子会话被排除；`synthesizeEvents` 只吐 manager 的 action，其 `tool_result.content = outputsToText(outputs)` 即切口 1 那段文本。

**关键**：子会话事件其实**完整存在**（GCS 对象存储，`fetchEventsForPrompt(taskId, subPromptId)` 可读，含 travelkit `tool_use` + 完整 JSON 的 `tool_result`，经 `eventNormalizer.ts` 规范成 `{eventType, payload}`，未截断），且 manager 委派的 tool_use/tool_result payload 里**已带 `subPromptId`** 句柄。

**已落地修复（方案 B：透出子会话事件，frames.ts 零改动）：**

1. **cctools** —— 新增只读、org 域校验的 `GET /v1/tasks/:id/prompts/:promptId/events`（`relay/src/routes/v1/tasks.ts`）：校验 `promptId` 是本 task 的子会话（`parent_prompt_id IS NOT NULL`）后，包一层已有的 `fetchEventsForPrompt` 返回 `{promptId, events}`。
2. **TripDesk** —— `worker/task-do.ts`：`translate()` 遇到带 `subPromptId` 的 `tool_result` 时调 `replaySubPrompt()`，拉子会话的 `tool_use`/`tool_result` 并 replay 进当前 prompt 的 frames（每个 subPromptId 只拉一次）。`src/frames.ts` 现成按工具名路由，无需改动。

> 待办：在真实子会话上回归一次，核对 `data.displayOptions` / `solutionId` 字段齐全；并确认线上 relay 的 GCS 凭证可用（`fetchEventsForPrompt` 依赖 `getGcsClient()`）。

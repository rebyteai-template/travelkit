# TravelKit 仓库 — 当前状态

> 给切过来的 Claude / 给我自己看的交接说明。最后更新见 git log。

## 这个仓库是什么

AI 机票 agent 实验仓库。已经安装了 **TravelKit skill**（来自
<https://github.com/TravelKit-AI/travelkit-skill>），用来让 agent 走完整的
在线机票流程：搜索 → 验价 → 下单 → 支付 → 售后（退/改/发票/行程单）。

skill 本身只是 prompt/policy，真正的机票数据要靠 TravelKit 的 **MCP server**。

## 已完成 ✅

- `git init` + 首次提交
- 安装 skill 到 `.claude/skills/travelkit/`（`SKILL.md` + 15 个 references）
- `README.md`、`.gitignore`（已忽略 `.env`、`*.key`，防止 API key 进 git）
- 开了 tmux session `travelkit`，在本目录启动了 `claude`

## 待办 ⏳（需要 API key 才能继续）

1. 用户提供 `TRAVELKIT_API_KEY`
2. 写进 `.env`（不进 git，不打印到任何输出）
3. 配置 MCP server，二选一：
   - **项目级**（只这个 repo 用）
   - **全局**（所有项目可用）
4. 验证连接 + 跑一次 `flight_search` 试水

## MCP 连接信息（来自 skill README）

- Endpoint: `https://mcp.travelkit.ai/mcp` （Streamable HTTP）
- Auth: `Authorization: Bearer ${TRAVELKIT_API_KEY}`
- Headers: `Content-Type: application/json`，`Accept: application/json, text/event-stream`

## skill 的几条核心红线（用的时候注意）

- 先搜索 → 再实时验价 → 验价过了才收集乘客证件信息
- 写操作（下单/支付/取消/退票/改签）每次都要用户**明确确认**才执行
- 内部字段（`solutionId`、`orderKey`、`PNR`、票号、API key 等）绝不能出现在给用户的回复里
- 接口没返回的数据（行李额、退改规则等）如实说"未返回"，不要编
- 默认简体中文回复

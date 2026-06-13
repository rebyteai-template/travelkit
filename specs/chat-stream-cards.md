# chat-stream 方案卡 + 交互 UI 选型

> **状态**: In progress（L1 入聊天流已落地；验价卡 / 写流 / R2 待接）  ·  **创建**: 2026-06-13
> **相关**: `src/frames.ts` · `src/components/FlightCompareCards.tsx` · `src/components/ChatPanel.tsx` · `src/App.tsx` · `src/styles.css` · 记忆 `tripdesk-rebyte-status` · `REBYTE-NEEDS.md` §4

## 背景 / 为什么

卡片渲染曾被当成「卡在 rebyte」。**2026-06-13 实跑证实不卡了**：relay 6/7 修复（`subPromptId`）+ `worker/task-do.ts` 的 `replaySubPrompt()` 双侧已接，沙箱子 agent 的 **compact JSON**（travelkit-pro skill 的 `flight_search_compact.py` stdout，顶层 `displayOptions`+`displayMapping`，含 `solutionId`）随 `Bash` tool_result 到达我们的 frames。bench 之前空，只因 `frames.ts` 按 MCP 工具名找 `flight_search`，而真实是 Bash 结果 + **顶层** `displayOptions`。

用户（FDE）定位：终端用户是 **OP / 机票专家**，给客户**报方案报价**；这是给专家看的探索性 demo。诉求「专项聊天流」+ 一层一层做、能砍。

## 决策

- **砍 R1**（`ask_user_question`）：核 cctools 确认它在 `/v1/tasks`（api 来源）**不可用**（origin 白名单不含 api）；且 L1 解析 compact 渲染的富卡比 R1 的 `{label,description}` 文本选项更好。展示选项 L1 完胜；澄清/确认用纯聊天即可。
- **L1**（前端解析 compact 家族 → 富卡）做应用内方案卡，**入聊天流**。
- **R2**（agent `interactive_content` 产 HTML → 主机取回 iframe → 导 PDF）做「报方案报价」交付物**北极星**。需先开 `interactive_content`（见 `REBYTE-NEEDS.md` §4）。

## 已落地（L1 入聊天流）

- `frames.ts`：按 **shape**（`displayOptions`+`displayMapping`）认 compact → `CompactOption[]`（`parseCompactSearch`/`toCompactOption`）；`solutionId` 只在 displayMapping、不进 UI；选择按**序号** `optionNumber`。卡片**内联挂在产生它的 assistant 轮**，`stripTables()` 剥该轮 markdown 表防重复，留全历史；同搜索按 sig 去重（防 verify 轮重渲搜索卡）；attach 只在有真实文本的帧（tool_use-only 的 `Write` 帧不吞 pendingSearch）。
- 新 `FlightCompareCards.tsx`（富卡：徽章 / 价格 / 整段行程 / 时长 / 舱位 / 行李 /「选这个·去验价」）。
- `ChatPanel.tsx` 内联渲染卡；`App.tsx` 聊天为主、右 bench 条件化（`showBench` = 仅 passenger/confirm 写流）；退役 `SearchResultsTable.tsx`；`styles.css` 加 `.flight-card`/`.chat-cards`/`.split.no-bench`。
- 验证：`pnpm typecheck` 绿；复用真实 capture（task `e245085a`）实测 搜索→2 卡、序号1→CZ8899 验价命中、无重复。

## 待接（下一层，别一口吃胖）

1. **验价卡**：`flight_verify_selected.py` 也是 compact 家族 → 同套路认 shape 渲染成验价卡；接通后乘客表单 / 二次确认**写流**（现 `showBench` 暂不可达）随之复活。
2. **R2 报告卡 + PDF**：确认 `interactive_content` 可开后，加「报告卡」（iframe 嵌 agent 产的 HTML）+「导出 PDF」（主机 print-to-PDF）。
3. onBook 现一键直发「我选序号N验价」（实测可用）；可选改 draft-fill（填输入框由人确认，cctools 同款）。
4. 边角：mobile 的「看板」pane 在 no-bench 下空；`stripTables` 是行级 `| … |` 启发式（够用）。

## 验收

- 搜索 → 聊天内联富卡、留历史、无表格重复；点序号 → 验价（现文本，接卡后成卡）。
- `pnpm typecheck` 绿。无 schema 改动（免 `db:migrate`）。
- 浏览器：`node data/td-verify.cjs`（gitignored，复用测试 token 打开既有 session）复跑确认渲染。

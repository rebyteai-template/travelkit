# chat-stream 方案卡 + 交互 UI 选型

> **状态**: In progress（单列纯聊天：搜索卡 + 验价卡 + 写流全部内联、无左右分栏已落地；R2 待接）  ·  **创建**: 2026-06-13  ·  **更新**: 2026-06-13
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

## 已落地（验价卡 + MCP 清理）

- `frames.ts`：按 **shape**（`selectedOption`+`verifiedOption`）认 compact 验价（`flight_verify_selected.py` stdout，Bash 结果）→ `parseCompactVerify` 映射成 `FareVerification`。只读 curated 的 `verifiedOption`（solutionId/orderKey 留在脚本私有字段）；`comparison.changed` → 「验价后 X 较所选有变化」提示（`changeNotice`）；过期/失败（`ok!==true` / `expired_search`）→ `notice`，**不**切 stage 让用户从刷新后的搜索里重选。compact 没有的（per-pax 价拆分 / 结构化退改 / 余票）**留空不编**，卡片按 `.length` 守空隐藏。
- compact 验价无结构化 base/tax，只给 `priceBreakdownDisplay`（"票价 ¥X + 税费 ¥Y"）→ `booking.ts amountLine` & `FareDetailCard` 优先显示它；passenger 行按 `request.passengerCount` 播种（够 seed 表单行数，`salePrice=0` 故 per-pax 表隐藏）。
- `App.tsx`：`showBench` 纳入 `stage==='verify'`（**破了 showBench 死锁**——验价卡现可达，「继续预订」→ 乘客表单 → 二次确认写流复活）；新搜索 `stage==='search'` 时重置 `mode='auto'`，避免半截写流卡在右 bench。
- **MCP 清理**：删掉 `frames.ts` 里按 MCP 工具名认验价的死路（`stageOfTool`/`toolNameById`/`parseCoreSegment`/`errorMessage`/旧 `parseVerify`）——新版 skill 全直连 HTTP、不用 MCP；顺手纠正 `store.ts`/`provision.ts`/`worker/index.ts`/`env.ts` 把"token 写进 `.mcp.json`"改成 `.simplifly.env`，`task-do.ts` "domain MCP calls"→"tool calls"。`seed.ts` 删 `.mcp.json` 的逻辑是对的、保留。
- 验证：`pnpm typecheck` + `pnpm build` 绿；合成 compact 验价过 `derive()` 实测——成功（中转/多乘客/变价）渲对、过期走 notice。

## L2 决策修正：**全部进聊天流、彻底取消左右分栏**（2026-06-13，用户拍板 B）

把验价卡放进右 bench 是沿用旧架构（search/verify/写流都在 bench），**违背了「卡片都进消息流」原则**——又把左右分栏带回来了。修正方向：**只 streaming chat，单列，无分栏**。

已落地（2026-06-13）：
1. **验价卡进聊天流**：`ChatBubble.fare?: FareVerification`；`derive` 把验价结果挂到验价那轮气泡（同搜索卡 `cards` 套路，`pendingFare`）。`view.fare`（最新）与最新验价气泡的 `fare` **是同一对象引用** → `ChatPanel` 据此判断哪张「最新可操作」。`ChatPanel` 内联渲染 `FareDetailCard`；验价 turn 的 markdown 表用 `stripTables` 剥掉。
2. **写流进聊天流尾部**：乘客表单 / 二次确认由 `flowModeAtom`(auto/passengers/confirm) 驱动，新组件 `WriteFlow` 作为 `children` 传给 `ChatPanel`、渲染在历史**末尾**（滚动区内、Composer 之上）。
3. **「继续预订」CTA**：只在最新验价卡（`b.fare === view.fare`）且 `mode==='auto'` 时显示；进写流后收起。`FareDetailCard.onContinue` 改可选。
4. **删分栏**：删 `Bench.tsx` / `showBench` / `.split·.no-bench·.right·.bench*` / mobile `paneAtom`+看板切换；`benchModeAtom`→`flowModeAtom`、`BenchMode`→`FlowMode`。App 单列 = `<main>` → `ChatPanel`(历史+内联卡+尾部 `WriteFlow`) + `Composer`。`orderGate`/`journeyText` 随写流进 `WriteFlow.tsx`。
5. **样式**：`.chat`/`.composer` 居中 `max-width:960px`；表单卡 720px·2 列（比旧 bench ~590px 更宽）。CSS 瘦身（删死样式）17.3→16.4KB。
6. **设计依据**（impeccable shape）：选 inline 不选 modal——modal 撞 PRODUCT.md「不要弹窗」反例 + product register「modal=laziness」，且 inline 本就更宽、无额外收益。free-text 天然保留（就是聊天）。

验收：✅ `typecheck`/`build` 绿；浏览器实测 `e245085a`（`#org=351&uid=99`）——单列无分栏（`hasSplit:false`）、搜索卡+验价卡内联 `.chat`、点继续预订→乘客表单内联流尾+CTA 收起、0 console 报错。

## 待接（下一层，别一口吃胖）

1. **R2 报告卡 + PDF**：确认 `interactive_content` 可开后，加「报告卡」（iframe 嵌 agent 产的 HTML）+「导出 PDF」（主机 print-to-PDF）。
2. **下单/支付卡**：`flight_create_order` / `flight_pay_order` 的 skill 脚本输出也是 compact 家族 → 同套路加 shape 网关 + stage（order/payment），把 `// order / payment stages parsed in a later milestone` 那行接掉。
3. onBook 现一键直发「我选序号N验价」（实测可用）；可选改 draft-fill（填输入框由人确认，cctools 同款）。
4. 边角：`stripTables` 是行级 `| … |` 启发式（够用）；验价 turn 的 markdown 表目前不剥——验价卡进流后可考虑同搜索一样剥掉重复表。

## 验收

- 搜索 → 聊天内联富卡、留历史、无表格重复；点序号 → 验价（现文本，接卡后成卡）。
- `pnpm typecheck` 绿。无 schema 改动（免 `db:migrate`）。
- 浏览器：`node data/td-verify.cjs`（gitignored，复用测试 token 打开既有 session）复跑确认渲染。

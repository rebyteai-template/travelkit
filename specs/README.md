# specs/ — 任务级 spec & todo 文档

放**有生命周期的、针对某件「要做的事」**的需求/设计/todo 文档：开工前写清楚要做什么、怎么验收，
开工后当 checklist，做完归档。每篇一个 kebab-case 文件。

> 与**根级常驻文档**区分:`CLAUDE.md` / `PRODUCT.md` / `DESIGN.md` / `REBYTE-ISSUE.md` / `REBYTE-NEEDS.md`
> 是「长期为真」的参考(且被按文件名引用,别挪);`specs/` 是「这件事要做」的任务 spec,做完可标 Done / 归档。

## 当前

| 文档 | 状态 | 摘要 |
|---|---|---|
| [skill-eval-gate.md](skill-eval-gate.md) | TODO | skill 迭代验收:评分版 eval harness（`server/rebyte/eval.ts`）+ pre-deploy 手动门控,关键红线全绿才 promote 新 skill |
| [template-layering.md](template-layering.md) | 决策锚 | 模板分层 & 三条已定结论:AI SDK 不做 streaming 地基 / streaming 缝在 `RouteVars`(没和 DO 绑死) / "rebyte SDK"≠"kit"。下面 3 篇的定位锚 |
| [rebyte-edge-sdk.md](rebyte-edge-sdk.md) | TODO | 【改 cctools】两个 edge-native client(`@rebyte/relay` 控制面 / `@rebyte/sandbox` 基质面)+ edge checklist + typed 可续迭代器;我们手搓的可 upstream 成参考实现 |
| [rebyte-protocol-asks.md](rebyte-protocol-asks.md) | TODO | 【改 cctools/relay】递给 Rebyte 的 6 条平台行为改动(按杠杆排序),每条注明 kit 删掉啥 = REBYTE-ISSUE/NEEDS 的"平台需求"版 |
| [streaming-experience-contract.md](streaming-experience-contract.md) | TODO | 【改 travelkit/kit】streaming 皇冠层:可测不变量 I0–I4(frames 为源/可续/刷新重建/后端独立跑)+ load-bearing race R1–R4 + 硬化 todo(收敛重复 translate、回流 replaySubPrompt) |
| [chat-stream-cards.md](chat-stream-cards.md) | In progress | 搜索方案卡入聊天流(L1,已落地)+ 交互UI选型:砍 R1(`ask_user_question` api 来源不可用)、L1 解析 compact 家族富卡、R2 HTML报告→PDF 北极星;待接 验价卡/写流/R2 |

## 约定
- 新增一篇 = 建 `specs/<kebab-name>.md` + 在上表加一行。
- 顶部带 meta:**状态**(TODO / In progress / Done / Archived)、**创建日期**、**相关**(代码路径 / 其它 spec / 记忆)。
- 做完后把状态改 Done;长期不再相关的标 Archived(或移 `specs/archive/`)。

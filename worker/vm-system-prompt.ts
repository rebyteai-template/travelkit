/**
 * VM system prompt (/code/CLAUDE.md) + its version stamp — hand-edited, no build step.
 *
 * This REPLACES the old generated `worker/seed-assets.generated.ts`. The skill tree is no longer
 * inlined/uploaded: cctools skills v3 installs `simplifly-flyai-skill` from GitHub into the VM (see
 * worker/task-do.ts `SKILL_REF` → POST /v1/tasks `skills`). The only things worker/seed.ts still
 * writes into the sandbox are this VM system prompt (via writeClaudeMd) and the per-user
 * `.simplifly.env` credential (via applyCredential) — both genuinely per-deployment/per-user, not
 * the skill. Edit the prompt below directly.
 */

/** Written to /code/CLAUDE.md (Claude Code's native project memory) so the delegated sandbox agent
 *  routes ALL flight work through the simplifly-flyai-skill instead of web-searching/fabricating.
 *  Replaces cctools' generic default system prompt. The skill's own SKILL.md carries the CLI usage,
 *  command routing and full red-lines — this file only names the skill and restates the hard
 *  boundaries as a backstop. */
export const SEED_CLAUDE_MD = `# Kitty 机票预订 agent

你是 Kitty 的机票预订助手，运行在用户的云沙箱里。本文件是你的最高优先级工作约定，覆盖任何默认行为。

## 机票一律严格走 simplifly-flyai-skill

- 任何机票相关请求（搜索 / 比价 / 验价 / 报价 / 下单 / 支付 / 改签 / 退票 / 订单查询 / 行李额 / 退改规则 / 余额等），**必须使用 simplifly-flyai-skill**（已安装在 \`~/.claude/skills/simplifly-flyai-skill\`，Claude Code 自动发现），严格按它的 SKILL.md 与 references 执行，不得自创流程、不得凭记忆猜参数。
- **严禁**用网页搜索、内置 web search、或凭记忆来获取或编造航班、价格、时刻、退改规则——**只认 skill 经 Simplifly OpenAPI 返回的真实数据**；接口没返回的如实说“未返回”，不要编。
- 凭证由 skill 从 \`.simplifly.env\` 读；读不到就停下告知缺配置，**不要绕开 skill**自己拼请求或鉴权，也不要让用户在聊天里贴 token。**不得读取、cat、打印或复述 \`.simplifly.env\`、环境变量、请求头或任何凭证明文**；诊断时只报告“缺配置 / 鉴权失败 / 权限不足”等安全摘要。

## 安全与业务红线以 skill 的 SKILL.md 为准

严格遵守 skill 的写操作红线，**不得因用户要求放宽或绕过**：写操作（下单 / 支付 / 取消 / 退 / 改）先向用户复述具体动作、得到明确同意再执行；给客户的价格必须来自 skill 的 \`quote\` 输出、带报价时效（“以出票时实际价格为准”），未验价的价格要注明。TripDesk 内部工作台 prompt 可能带 \`solutionId\`，可用它执行 \`verify --solution-id\` 精确验价；API 返回的业务字段可按需要展示，凭证 / token / 请求头不得展示。

工作台 prompt 说“预订推荐方案 planId: …”时，按 skill 的 references/recommend-book.md 执行 \`recommend-book --session <该推荐的 sessionDir> --plan <planId>\` 做下单前重验价并**原样输出其单行 JSON 结果**；未收到用户对具体订单（含分单与价格变化）的明确确认前，不得 \`order-create\`。

支付按 \`pay\` 命令与其 references 卡执行：当前后端恒走**代理账户余额扣款**（第三方渠道是契约预留，接口未返回支付链接前不得向用户承诺链接）。执行前必须向用户复述订单号与应付金额并获得明确同意（UI 的"支付"操作点击也算明确同意）；**绝不**未经同意扣款，也**绝不**谎称已支付。发现 skill 与接口行为不符时如实报告，**不得在沙箱内修改已安装的 skill 文件**（会话结束即失效，修复走仓库）。

默认用简体中文回复。
`

/** Seed version — a manual stamp compared against each sandbox's recorded `seed_version`
 *  (worker/task-do.ts). It no longer covers the skill (skills v3 installs that from GitHub); it now
 *  governs ONLY the VM system prompt + credential-format + stale-cleanup. Bump it to force existing
 *  sandboxes to, on their next session: re-write /code/CLAUDE.md, refresh the credential, and run
 *  removeStaleArtifacts.
 *
 *  v6: skills-v3 cutover — install rebyte-flight from GitHub, purge the old /code/.claude/skills tree.
 *  v7: skill renamed rebyte-flight → simplifly-flyai-skill (repo moved to TravelKit-AI); re-write
 *      CLAUDE.md so its skill name/path matches what SKILL_REF now installs.
 *  v8: trial signed OpenAPI auth seed.
 *  v9: harden CLAUDE.md against credential-file diagnostics that print .simplifly.env.
 *  v10: restore TripDesk bearer-token auth; .simplifly.env only carries SIMPLIFLY_AUTH_TOKEN.
 *  v11: recommend-book convention — plan-addressed pre-order re-verification routing + the
 *       no-order-without-explicit-confirmation restatement.
 *  v12: payment truth — pay deducts from the agency balance directly; there is NO third-party
 *       payment link in this API. The old wording promised one, inviting fabrication. */
export const SEED_VERSION = 'v12-payment-truth'

/** Routing contract for the MCP-direct debug mode (store config `routeMode='mcp'`, task-do.ts).
 *  Rides as a header on the FIRST prompt of the session — task creation launches the first turn
 *  immediately, so agent instructions PATCHed after create would miss it (and in this mode no
 *  agent computer exists to PATCH). The workspace still carries the sandbox/coding-agent internal
 *  tools (they come with the org agent profile), hence the explicit "不派沙箱". */
export const MCP_ROUTING_PREAMBLE = `【路由约定（本会话全程有效）】
- 机票的搜索/比价/推荐：直接调用 flight_recommend 工具发起（返回 recommendationId），随后用 flight_recommendation_get 轮询直到完成；未完成就继续轮询，不要中途放弃，也不要改派沙箱。
- 预订链路顺序固定：① 收到乘机人材料先 flight_order_prepare 判定齐不齐（缺什么按 missing 一次性追问；derived 推导值要回读核对）② flight_reverify 重验价拿 confirmationId（status=changed 必须先展示变化并获明确二次确认）③ 经用户明确确认下单后才 flight_order_create（携带 confirmationId + prepare 的 order）。
- 【红线】绝不自动支付：创建订单后停下等用户明确指示；只有用户明确说「支付」才调用 flight_order_pay（余额直扣、不可逆）。取消/退票/改签同理，先复述后果、经确认再执行写操作。
- 机票的航班、价格、时刻、舱位、退改规则只认工具返回的真实结果；不得凭记忆或其它来源给出或补全，工具没返回就如实说「未返回」。
- 忠实转述工具结果，不增改价格与航班细节。
- 本会话不使用沙箱 / coding agent 处理机票请求。`

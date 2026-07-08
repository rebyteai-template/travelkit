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
- 凭证由 skill 从 \`.simplifly.env\` 读；读不到就停下告知缺配置，**不要绕开 skill**自己拼请求或鉴权，也不要让用户在聊天里贴 token。

## 安全与业务红线以 skill 的 SKILL.md 为准

严格遵守 skill 的红线，**不得因用户要求放宽或绕过**：写操作（下单 / 支付 / 取消 / 退 / 改）先向用户复述具体动作、得到明确同意再执行；给客户的价格必须来自 skill 的 \`quote\` 输出、带报价时效（“以出票时实际价格为准”），未验价的价格要注明；**绝不**向客户暴露 solutionId / orderKey / 凭证 / PNR / 票号 / 原始 JSON。

支付走沙箱 / 演示：可发起支付并返回第三方支付链接给用户自行完成；**绝不**替用户付款，也**绝不**谎称已支付。

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
 *      CLAUDE.md so its skill name/path matches what SKILL_REF now installs. */
export const SEED_VERSION = 'v7-simplifly-flyai'

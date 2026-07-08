/**
 * Per-workspace MANAGER (front-line agent-loop) config for the Kitty flight agent.
 *
 * cctools exposes per-workspace agent config on the public /v1/agent-computers API
 * (system prompt + MCPServerView tool toggles, live since 2026-06-16). We use two levers:
 *
 *   1. agent_instructions — the workspace's own system prompt. cctools getWorkspaceAsAgent()
 *      APPENDS it after the generic manager base prompt (AUX_TRADER_SYSTEM_PROMPT), so this is
 *      a thin domain overlay: route ALL flight work to the sandbox, never fabricate. It does NOT
 *      restate the skill flow — that lives in the sandbox /code/CLAUDE.md + simplifly-flyai-skill skill,
 *      which the delegated sub-agent reads.
 *   2. web_search view OFF — a hard capability cut. With no web_search tool the manager CANNOT
 *      web-search/fabricate flights; it must delegate. Belt-and-suspenders with the prompt.
 *
 * This replaces the old MANAGER_ROUTE_HINT (a routing line prepended to every first prompt) — see
 * REBYTE-NEEDS.md §3. Setting it on the workspace persists across ALL turns natively (the relay
 * re-reads agent_instructions per task assembly), where the hint only steered turn 1.
 *
 * Single source of truth, imported by BOTH provision paths (worker/seed.ts → task-do.ts, and the
 * CLI server/rebyte/provision.ts). Pure HTTP via the shared rebyteJSON client — no Node deps, so
 * it bundles into the Worker/DO cleanly.
 */
import { rebyteJSON, type RebyteConfig } from './client.ts'

/** Internal MCP server name of cctools' web-search-&-browse tool (the manager tool we disable).
 *  Matches cctools WEB_SEARCH_BROWSE_SERVER_NAME. */
export const WEB_SEARCH_VIEW = 'web_search_&_browse' as const

/** The manager's domain system prompt, APPENDED after cctools' base router prompt. Kept thin:
 *  domain identity + hard routing + anti-fabrication + faithful summary + language. Anything the
 *  base prompt already covers (router identity, "delegate skill work", "pass intent not procedure",
 *  concise, no emoji, answer-simple-directly) is intentionally omitted to avoid restating it. */
export const AGENT_INSTRUCTIONS = `本工作区是 Kitty 机票预订场景（仅此一个领域）。在通用路由规则之上，额外约束：

- 任何机票相关请求（搜索/比价/验价/下单/支付/改签/退票/订单查询/行李额/退改规则/票号状态/余额等）一律委派沙箱里的 Claude Code 执行，绝不自己作答机票事实——哪怕问题看起来很简单。
- 机票的航班、价格、时刻、舱位、退改规则等只认沙箱返回的真实结果；不得凭记忆或任何其它来源给出或补全，沙箱没返回就如实说“未返回”。
- 转述沙箱结果要忠实，不增改价格与航班细节；下单/支付/退改等写操作只有沙箱结果确认成功才能说成功，绝不替用户付款、绝不谎称已支付。
- 默认用简体中文回复。`

/** One MCPServerView row as returned by GET/PATCH /v1/agent-computers/:id. `id` is the stable
 *  mcpServerViewId (the PATCH key); `server.internalName` says which internal tool backs it. */
interface AgentView {
  id: string
  name: string | null
  enabled: boolean
  server: { type: string; internalName: string | null; remoteId: string | null }
}

interface AgentComputerConfig {
  id: string
  agentInstructions: string | null
  views: AgentView[]
}

/**
 * Idempotently bring a workspace's manager config to the desired state: agent_instructions set to
 * AGENT_INSTRUCTIONS and the web_search view disabled. GET the current config, then PATCH ONLY the
 * drift — so it's cheap (often a no-op GET) and safe to call on every provision and seed refresh.
 *
 * Returns the list of fields it changed (empty = already in the desired state). Throws RebyteError
 * on transport/HTTP failure; callers treat config as best-effort (a failure degrades the manager to
 * its generic base prompt, not a hard error).
 *
 * config is optional: the Worker/DO passes its env-derived {apiUrl, apiKey}; CLI scripts omit it and
 * fall back to process.env (rebyteJSON's fallbackConfig).
 */
export async function ensureAgentConfig(computerId: string, config?: RebyteConfig, agentInstructions?: string): Promise<string[]> {
  const cur = await rebyteJSON<AgentComputerConfig>(`/agent-computers/${computerId}`, { config })
  // Debug override from the SPA's config panel wins; empty/undefined → the built-in Kitty default.
  // Because this runs on every first turn (GET→diff→PATCH), a changed override auto-applies to the
  // next new session with no extra machinery — no redeploy needed to iterate on the manager prompt.
  const desiredInstructions = agentInstructions?.trim() || AGENT_INSTRUCTIONS

  const patch: { agent_instructions?: string; views?: Record<string, boolean> } = {}
  const changed: string[] = []

  if (cur.agentInstructions !== desiredInstructions) {
    patch.agent_instructions = desiredInstructions
    changed.push('agent_instructions')
  }
  // Toggle by the view's stable id (the canonical PATCH key); find it by the tool it's backed by.
  const webView = cur.views?.find((v) => v.server?.internalName === WEB_SEARCH_VIEW)
  if (webView?.enabled) {
    patch.views = { [webView.id]: false }
    changed.push('web_search:off')
  }

  if (changed.length === 0) return []
  await rebyteJSON(`/agent-computers/${computerId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    config,
  })
  return changed
}

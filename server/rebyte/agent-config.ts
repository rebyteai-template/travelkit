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

/** The three internal tools that give the manager its OWN way into the sandbox. Disabled on the
 *  MCP route, where the flight work is supposed to happen entirely through the `flight_*` tools.
 *
 *  This is a capability cut, not a request. The MCP workspace's instructions already say "不进沙箱、
 *  不派 coding agent" and it was ignored: cctools mounts `skills` on every workspace by default
 *  (GLOBAL_AGENT_INTERNAL_MCP_NAMES, backfilled onto live workspaces 2026-08-11), so the manager
 *  found `simplifly-flyai-skill` sitting in ~/.skills, read its reference docs, and drove
 *  `sandbox__bash` itself. A prompt cannot beat a tool that is present and obviously fits the task;
 *  removing the tool can. Measured consequence of NOT cutting it: the run produced a valid
 *  flight.recommendations, but through `sandbox__bash`, whose output arrives wrapped in
 *  `<stdout>…</stdout>` — a shape the frame parser refused, so the recommendation table silently
 *  disappeared and the chat fell back to the agent's Markdown retelling.
 *
 *  Left alone on the VM route: that route's whole design is to delegate into the sandbox. */
export const SANDBOX_ROUTE_VIEWS = ['skills', 'sandbox', 'coding_agent'] as const

/**
 * Whether the MCP route actually cuts the sandbox tools.
 *
 * ON since 2026-08-17, when the flight MCP chain was verified end to end (rebyte
 * remote_mcp_servers → simplifly-mcp-staging → Simplifly, real recommendations rendered).
 * With the primary path healthy, keeping the sandbox trio would only let an MCP outage
 * degrade SILENTLY into the skills route — whose `<stdout>`-wrapped output the frame parser
 * cannot render. Cut, an MCP failure is a loud "没有可用的 flight_* 工具" instead of a table
 * that quietly never appears.
 *
 * Only flip back to false if the flight MCP registration is broken and the sandbox route is
 * temporarily the only way to answer at all.
 */
export const CUT_SANDBOX_ON_MCP_ROUTE = true

/** The manager's domain system prompt, APPENDED after cctools' base router prompt. Kept thin:
 *  domain identity + hard routing + anti-fabrication + faithful summary + language. Anything the
 *  base prompt already covers (router identity, "delegate skill work", "pass intent not procedure",
 *  concise, no emoji, answer-simple-directly) is intentionally omitted to avoid restating it. */
export const AGENT_INSTRUCTIONS = `本工作区是 Kitty 机票预订场景（仅此一个领域）。在通用路由规则之上，额外约束：

- 任何机票相关请求（搜索/比价/验价/下单/支付/改签/退票/订单查询/行李额/退改规则/票号状态/余额等）一律委派沙箱里的 Claude Code 执行，绝不自己作答机票事实——哪怕问题看起来很简单。
- 机票的航班、价格、时刻、舱位、退改规则等只认沙箱返回的真实结果；不得凭记忆或任何其它来源给出或补全，沙箱没返回就如实说“未返回”。
- 转述沙箱结果要忠实，不增改价格与航班细节；下单/支付/退改等写操作只有沙箱结果确认成功才能说成功，绝不替用户付款、绝不谎称已支付。
- 默认用简体中文回复。`

/** MCP-route counterpart of AGENT_INSTRUCTIONS — the workspace carries ONE of the two, picked by
 *  the task's route stamp at first turn (ensureAgentConfig PATCHes on drift, so flipping the route
 *  toggle converges the workspace on its next session). Deliberately minimal: tool procedure,
 *  confirmation gates, and polling cadence live in the flight tools' own descriptions and
 *  server-side gates (confirmationId two-phase, pay is its own explicit tool) — the agent judges
 *  the rest. */
export const MCP_AGENT_INSTRUCTIONS = `本工作区是 Kitty 机票预订场景（仅此一个领域）。机票相关操作一律直接调用 flight_* 工具完成，不进沙箱、不派 coding agent。机票的航班、价格、时刻、舱位、退改规则只认工具返回的真实结果，工具没返回就如实说"未返回"，不增改细节。默认用简体中文回复。`

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
export async function ensureAgentConfig(
  computerId: string,
  config?: RebyteConfig,
  agentInstructions?: string,
  /** Which route this workspace serves. `mcp` additionally cuts the sandbox-reaching tools;
   *  `vm` (the default, and what the CLI provisioner passes) leaves them, since delegating into
   *  the sandbox IS that route. */
  route: 'mcp' | 'vm' = 'vm',
): Promise<string[]> {
  const cur = await rebyteJSON<AgentComputerConfig>(`/agent-computers/${computerId}`, { config })
  // Debug override from the SPA's config panel wins; empty/undefined → the built-in Kitty default.
  // Because this runs on every first turn (GET→diff→PATCH), a changed override auto-applies to the
  // next new session with no extra machinery — no redeploy needed to iterate on the manager prompt.
  const desiredInstructions = agentInstructions?.trim() || (route === 'mcp' ? MCP_AGENT_INSTRUCTIONS : AGENT_INSTRUCTIONS)

  const patch: { agent_instructions?: string; views?: Record<string, boolean> } = {}
  const changed: string[] = []

  if (cur.agentInstructions !== desiredInstructions) {
    patch.agent_instructions = desiredInstructions
    changed.push('agent_instructions')
  }

  // Views we want off, by the internal tool backing them. web_search on both routes (the manager
  // must never source a flight fact itself); the sandbox trio only on the MCP route.
  const offNames: readonly string[] = route === 'mcp' && CUT_SANDBOX_ON_MCP_ROUTE
    ? [WEB_SEARCH_VIEW, ...SANDBOX_ROUTE_VIEWS]
    : [WEB_SEARCH_VIEW]
  // Toggle by the view's stable id (the canonical PATCH key); find it by the tool it's backed by.
  const views: Record<string, boolean> = {}
  for (const view of cur.views ?? []) {
    const internalName = view.server?.internalName
    if (!internalName || !offNames.includes(internalName) || !view.enabled) continue
    views[view.id] = false
    changed.push(`${internalName}:off`)
  }
  if (Object.keys(views).length > 0) patch.views = views

  if (changed.length === 0) return []
  await rebyteJSON(`/agent-computers/${computerId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    config,
  })
  return changed
}

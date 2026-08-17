/**
 * The manager's per-workspace capability cut.
 *
 * The regression this locks: on the MCP route the workspace must not keep the tools that reach
 * into the sandbox. cctools mounts `skills` on EVERY workspace by default
 * (GLOBAL_AGENT_INTERNAL_MCP_NAMES; backfilled onto live workspaces on 2026-08-11), and a manager
 * holding it will find `simplifly-flyai-skill` in ~/.skills and drive `sandbox__bash` itself —
 * despite instructions that say 不进沙箱. The run then produces a real flight.recommendations
 * wrapped in `<stdout>…</stdout>`, which the frame parser refuses, and the recommendation table
 * silently disappears from the chat. Instructions did not prevent it; removing the tool does.
 *
 * Run: node --import tsx --test server/rebyte/agent-config.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ensureAgentConfig,
  AGENT_INSTRUCTIONS,
  MCP_AGENT_INSTRUCTIONS,
  SANDBOX_ROUTE_VIEWS,
  WEB_SEARCH_VIEW,
} from './agent-config.ts'

const view = (id: string, internalName: string, enabled = true) => ({
  id,
  name: null,
  enabled,
  server: { type: 'internal', internalName, remoteId: null },
})

/** Every internal tool cctools mounts by default, all enabled — the real starting state. */
const defaultViews = () => [
  view('v-web', WEB_SEARCH_VIEW),
  view('v-sandbox', 'sandbox'),
  view('v-skills', 'skills'),
  view('v-coding', 'coding_agent'),
  view('v-ask', 'ask_user_question'),
  view('v-report', 'report_builder'),
  view('v-company', 'company'),
]

/** Stubs the relay: GET returns `current`, PATCH is captured. Restores fetch on return. */
function withRelay(current: { agentInstructions: string | null; views: ReturnType<typeof defaultViews> }) {
  const patches: Array<Record<string, unknown>> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'PATCH') {
      patches.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ id: 'ws', agentInstructions: null, views: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({ id: 'ws', ...current }), { status: 200 })
  }) as typeof fetch
  return {
    patches,
    restore: () => { globalThis.fetch = original },
  }
}

const config = { apiUrl: 'http://relay.test/v1', apiKey: 'k' }

test('mcp route cuts every path into the sandbox', async () => {
  const relay = withRelay({ agentInstructions: MCP_AGENT_INSTRUCTIONS, views: defaultViews() })
  try {
    const changed = await ensureAgentConfig('ws', config, undefined, 'mcp')
    const views = (relay.patches[0]?.views ?? {}) as Record<string, boolean>

    // web_search is cut on both routes — the manager must never source a flight fact itself.
    assert.equal(views['v-web'], false)
    // Untouched either way: nothing else is collateral.
    assert.equal(views['v-ask'], undefined)
    assert.equal(views['v-report'], undefined)

    for (const name of SANDBOX_ROUTE_VIEWS) {
      assert.ok(changed.includes(`${name}:off`), `${name} must be cut on the mcp route`)
    }
    assert.equal(views['v-skills'], false)
    assert.equal(views['v-sandbox'], false)
    assert.equal(views['v-coding'], false)
  } finally {
    relay.restore()
  }
})

test('vm route KEEPS the sandbox tools — delegating there is its whole design', async () => {
  const relay = withRelay({ agentInstructions: AGENT_INSTRUCTIONS, views: defaultViews() })
  try {
    const changed = await ensureAgentConfig('ws', config, undefined, 'vm')
    const views = relay.patches[0]?.views as Record<string, boolean>
    assert.equal(views['v-skills'], undefined)
    assert.equal(views['v-sandbox'], undefined)
    assert.equal(views['v-coding'], undefined)
    assert.equal(views['v-web'], false)
    assert.deepEqual(changed, ['web_search_&_browse:off'])
  } finally {
    relay.restore()
  }
})

test('the route also picks the default instructions', async () => {
  const relay = withRelay({ agentInstructions: 'stale', views: [] })
  try {
    await ensureAgentConfig('ws', config, undefined, 'mcp')
    assert.equal(relay.patches[0]?.agent_instructions, MCP_AGENT_INSTRUCTIONS)
  } finally {
    relay.restore()
  }

  const relay2 = withRelay({ agentInstructions: 'stale', views: [] })
  try {
    await ensureAgentConfig('ws', config, undefined, 'vm')
    assert.equal(relay2.patches[0]?.agent_instructions, AGENT_INSTRUCTIONS)
  } finally {
    relay2.restore()
  }
})

test('a debug override still wins over both defaults', async () => {
  const relay = withRelay({ agentInstructions: null, views: [] })
  try {
    await ensureAgentConfig('ws', config, '  自定义提示  ', 'mcp')
    assert.equal(relay.patches[0]?.agent_instructions, '自定义提示')
  } finally {
    relay.restore()
  }
})

test('already-cut workspace is a no-op — safe to call every first turn', async () => {
  const settled = [
    view('v-web', WEB_SEARCH_VIEW, false),
    view('v-sandbox', 'sandbox', false),
    view('v-skills', 'skills', false),
    view('v-coding', 'coding_agent', false),
    view('v-ask', 'ask_user_question'),
  ]
  const relay = withRelay({ agentInstructions: MCP_AGENT_INSTRUCTIONS, views: settled })
  try {
    const changed = await ensureAgentConfig('ws', config, undefined, 'mcp')
    assert.deepEqual(changed, [])
    assert.equal(relay.patches.length, 0, 'no PATCH when there is no drift')
  } finally {
    relay.restore()
  }
})

test('default route is vm, so the CLI provisioner cuts nothing extra', async () => {
  const relay = withRelay({ agentInstructions: AGENT_INSTRUCTIONS, views: defaultViews() })
  try {
    const changed = await ensureAgentConfig('ws', config)
    assert.deepEqual(changed, ['web_search_&_browse:off'])
  } finally {
    relay.restore()
  }
})

/**
 * Rebyte relay HTTP client. Talks to the relay REST API only (agent-computers,
 * tasks, events); the relay authenticates via the `API_KEY` header (not Bearer).
 *
 * Binding-agnostic by design: config ({apiUrl, apiKey}) is injected by the caller,
 * so this file imports NOTHING Node-specific and bundles cleanly into the Worker /
 * Durable Object. The DO passes `{ config: { apiUrl, apiKey } }` from its env binding.
 * Node scripts (bootstrap, smoke) can omit it and fall back to process.env.
 */
export interface RebyteConfig {
  apiUrl: string
  apiKey: string
}

const DEFAULT_API_URL = 'https://api.rebyte.ai/v1'

/** Node-only fallback for the CLI scripts (run with `--env-file=.env.local`). The
 *  Worker/DO always pass `config` explicitly, so this never runs there. */
function fallbackConfig(): RebyteConfig {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const e = proc?.env ?? {}
  return { apiUrl: e.REBYTE_API_URL ?? DEFAULT_API_URL, apiKey: e.REBYTE_API_KEY ?? '' }
}

export class RebyteError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'RebyteError'
  }
}

type RebyteInit = RequestInit & { apiKey?: string; config?: RebyteConfig }

/** Low-level fetch against the relay, injecting the API_KEY header. Returns the raw
 *  Response so callers can stream (SSE) or read JSON. */
export function rebyteFetch(path: string, opts: RebyteInit = {}): Promise<Response> {
  const { apiKey, config, ...init } = opts
  const cfg = config ?? fallbackConfig()
  const key = apiKey ?? cfg.apiKey
  if (!key) throw new RebyteError(0, 'REBYTE_API_KEY 未设置（配置 secret/.env.local 后再用 rebyte 后端）')
  const headers = new Headers(init.headers)
  headers.set('API_KEY', key)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  return fetch(`${cfg.apiUrl}${path}`, { ...init, headers })
}

/** Fetch JSON from the relay or throw RebyteError. */
export async function rebyteJSON<T = unknown>(path: string, opts: RebyteInit = {}): Promise<T> {
  const res = await rebyteFetch(path, opts)
  const text = await res.text()
  if (!res.ok) {
    // Prefer a structured relay error message; for a non-JSON body (e.g. a gateway's HTML 503
    // page) DON'T surface the raw markup — fall back to a clean `HTTP <status>`.
    let msg = `HTTP ${res.status}`
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string; realMessage?: string }
      msg = j?.error?.message || j?.message || j?.realMessage || msg
    } catch { /* non-JSON body (gateway HTML, etc.) → keep the clean status */ }
    throw new RebyteError(res.status, msg)
  }
  if (!text) return {} as T
  try { return JSON.parse(text) as T } catch { throw new RebyteError(res.status, `非 JSON 响应：${path}`) }
}

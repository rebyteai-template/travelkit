const BASE = '/api/app'

// Embed identity: the host frames us as `…/#uid=<uid>&token=<travelkitToken>`. We read the
// fragment once at load (it never hits the server logs / Referer), stash it for the iframe's
// lifetime, then clear it from the URL. uid = tenant key; token = the caller's travelkit
// credential (seeded into their sandbox on first turn). Both ride as headers on every call.
const _h = new URLSearchParams(location.hash.slice(1))
const UID = _h.get('uid') || sessionStorage.getItem('td_uid') || ''
// A user can belong to multiple orgs, so the tenant is (org, uid) — same person in two orgs =
// two separate tenants (own sandbox + history). The Worker composes the key; we just carry org.
const ORG = _h.get('org') || sessionStorage.getItem('td_org') || ''
const TOKEN = _h.get('token') || sessionStorage.getItem('td_tk') || ''
// Shared embed gate key (a global secret we hand the integrator). Blocks strangers who only
// know the domain from spinning sandboxes — the API rejects any call without it. Not per-user
// auth; the signed-handoff upgrade adds that later.
const KEY = _h.get('k') || sessionStorage.getItem('td_k') || ''
if (UID) sessionStorage.setItem('td_uid', UID)
if (ORG) sessionStorage.setItem('td_org', ORG)
if (TOKEN) sessionStorage.setItem('td_tk', TOKEN)
if (KEY) sessionStorage.setItem('td_k', KEY)
if (location.hash) history.replaceState(null, '', location.pathname + location.search)

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (UID) h['X-Tenant-Uid'] = UID
  if (ORG) h['X-Tenant-Org'] = ORG
  if (TOKEN) h['X-Travelkit-Token'] = TOKEN
  if (KEY) h['X-Embed-Key'] = KEY
  return h
}
/** EventSource can't set headers, so the SSE stream carries uid + org + token + key as query
 *  params. token rides in the query (not just a header) only here — test-phase tradeoff, gated
 *  by `k`; see worker/index.ts. */
function withAuthQuery(path: string): string {
  const q = new URLSearchParams()
  if (UID) q.set('uid', UID)
  if (ORG) q.set('org', ORG)
  if (TOKEN) q.set('token', TOKEN)
  if (KEY) q.set('k', KEY)
  const s = q.toString()
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: authHeaders(init?.headers as Record<string, string>) })
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${r.status}`)
  return r.json() as Promise<T>
}
const postJson = <T>(path: string, body: unknown): Promise<T> =>
  json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export interface PromptContent {
  id: string
  prompt: string
  status?: string
  frames: { seq: number; data: unknown }[]
}

/** One conversation in the per-user session list. */
export interface SessionSummary {
  id: string
  status: string
  created_at: string
  title: string
}

/** The signed-in user (from Cloudflare Access). 401 → not authenticated. */
export const getMe = (): Promise<{ email: string }> => json('/me')

/** The caller's sessions (newest first). */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await json<{ tasks: SessionSummary[] }>('/tasks')).tasks
}

export const createTask = (prompt: string): Promise<{ taskId: string; promptId: string }> =>
  postJson('/tasks', { prompt })

export const followup = (taskId: string, prompt: string): Promise<{ promptId: string }> =>
  postJson(`/tasks/${taskId}/prompts`, { prompt })

/** Debug-only: provision a fresh sandbox VM for the caller (old one abandoned). Slow — it waits
 *  for the VM to boot. Hidden behind the topbar 10-click easter egg in App.tsx. */
export const newSandbox = (): Promise<{ sandboxId?: string }> => postJson('/debug/new-sandbox', {})

export async function loadContent(
  taskId: string,
): Promise<{ task: { id: string; status: string }; prompts: PromptContent[] } | null> {
  const r = await fetch(`${BASE}/tasks/${taskId}/content`, { headers: authHeaders() })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`loadContent failed: ${r.status}`)
  return r.json()
}

/** Streams frames for a prompt. Calls onFrame per frame, onDone when the turn
 *  ends. Returns a stop() to close early. */
export function streamPrompt(
  promptId: string,
  onFrame: (seq: number, data: unknown) => void,
  onDone: (status: string) => void,
): () => void {
  const es = new EventSource(withAuthQuery(`${BASE}/prompts/${promptId}/stream`))
  es.onmessage = (e) => {
    const seq = Number(e.lastEventId) || 0
    try { onFrame(seq, JSON.parse(e.data)) } catch { /* ignore malformed */ }
  }
  es.addEventListener('done', (e) => {
    es.close()
    try { onDone(JSON.parse((e as MessageEvent).data).status) } catch { onDone('completed') }
  })
  es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ }
  return () => es.close()
}

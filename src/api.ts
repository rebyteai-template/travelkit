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

/** Tenant key for this embed session = (org, uid). Namespaces the persisted React
 *  Query cache so one tenant's snapshot never hydrates for another in the shared
 *  iframe. Empty when unidentified (→ no persistence). */
export const TENANT_ID = UID ? (ORG ? `${ORG}:${UID}` : UID) : ''

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
function withAuthQuery(path: string, extra?: Record<string, string>): string {
  const q = new URLSearchParams(extra)
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

/** Per-attachment metadata: relay file id + name + type. The server sends it on /content, and the
 *  composer also emits it on send — `toAttachment` derives the rendition URLs from it either way. */
export interface AttachmentMeta {
  fileId: string
  filename: string
  contentType: string
}

/** A bubble attachment with its authed rendition URLs (the `<img src>` targets,
 *  GET /api/app/files/:id?size=…&<tenant>) — rendered above the user bubble. */
export interface Attachment extends AttachmentMeta {
  thumbUrl: string
  largeUrl: string
}

/** A reference to an uploaded file (relay temp-file id + normalized name). Rides on a turn to
 *  stage it into the agent's sandbox at /code/<filename>. */
export interface FileRef { id: string; filename: string }

export interface PromptContent {
  id: string
  prompt: string
  status?: string
  /** UTC send time of the user turn (SQLite `datetime('now')`, bare form — see lib/time.ts).
   *  Optional: an optimistic turn fills it with an ISO string before the server row exists. */
  created_at?: string
  /** UTC completion time of the agent turn; null while the turn is still running. The assistant
   *  bubbles take this as their "sent" time (falling back to created_at mid-stream). */
  completed_at?: string | null
  frames: { seq: number; data: unknown }[]
  attachments?: Attachment[]
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

/** Org credit for the low-balance banner. `low` is server-decided against the threshold;
 *  `totalAvailable` is null when the relay was unreachable (→ low:false). */
export interface CreditStatus {
  totalAvailable: number | null
  threshold: number
  low: boolean
}
export const getCredit = (): Promise<CreditStatus> => json('/credit')

/** The caller's sessions (newest first). */
export async function listSessions(): Promise<SessionSummary[]> {
  return (await json<{ tasks: SessionSummary[] }>('/tasks')).tasks
}

/** Authed URL for a stored image rendition (the chat bubble / lightbox `<img src>`). The tenant
 *  identity rides in the QUERY (withAuthQuery), not a header — `<img>` can't set headers and we
 *  have no auth cookie (identity comes via the embed handoff). Same pattern as the SSE stream. */
export const fileUrl = (fileId: string, size: 'thumb' | 'large'): string =>
  withAuthQuery(`${BASE}/files/${fileId}`, { size })

/** Derive a bubble Attachment from server metadata — the ONE place rendition URLs are built, so the
 *  optimistic (send) and reloaded (/content) views are byte-identical (streaming I0). */
export const toAttachment = (m: AttachmentMeta): Attachment => ({
  ...m,
  thumbUrl: fileUrl(m.fileId, 'thumb'),
  largeUrl: fileUrl(m.fileId, 'large'),
})

/** Eager-upload ONE file (multipart) via the worker: it PUTs the original to the relay (staged into
 *  the sandbox next turn) and stores the WebP `thumb`/`large` renditions for display. Returns the
 *  FileRef. authHeaders() carries the tenant identity; content-type is left to the browser so it
 *  sets the multipart boundary. */
export async function uploadFile(file: File, renditions: { thumb: Blob; large: Blob } | null): Promise<FileRef> {
  const fd = new FormData()
  fd.append('file', file)
  if (renditions) {
    fd.append('thumb', renditions.thumb, 'thumb.webp')
    fd.append('large', renditions.large, 'large.webp')
  }
  const r = await fetch(`${BASE}/files`, { method: 'POST', headers: authHeaders(), body: fd })
  if (!r.ok) throw new Error(`upload failed: ${r.status}`)
  return (await r.json()) as FileRef
}

export const createTask = (prompt: string, files?: FileRef[]): Promise<{ taskId: string; promptId: string; routeMode: string }> =>
  postJson('/tasks', files?.length ? { prompt, files } : { prompt })

export const followup = (taskId: string, prompt: string, files?: FileRef[]): Promise<{ promptId: string }> =>
  postJson(`/tasks/${taskId}/prompts`, files?.length ? { prompt, files } : { prompt })

export const answerQuestion = (
  promptId: string,
  answer: import('./user-question.ts').UserQuestionAnswer,
): Promise<{ ok: boolean }> => postJson(`/prompts/${promptId}/answer`, { answer })

/** Cancel the in-flight turn. The server finalizes it as 'canceled'; a live SSE then ends with
 *  `done`. ok:false = the turn was already finalized (raced completion) — nothing to do. */
export const cancelPrompt = (promptId: string): Promise<{ ok: boolean }> =>
  postJson(`/prompts/${promptId}/cancel`, {})

/** Debug-only: provision a fresh sandbox VM for the caller (old one abandoned). Slow — it waits
 *  for the VM to boot. Hidden behind the sidebar-brand 10-click easter egg in App.tsx. */
export const newSandbox = (): Promise<{ sandboxId?: string }> => postJson('/debug/new-sandbox', {})

/** The GLOBAL debug config (skill ref + manager prompt) shared by EVERY user — not per-browser.
 *  `defaults` are the built-in fallbacks (shown as placeholders; an empty field = use the default).
 *  `isAdmin` says whether THIS caller may save (uid ∈ ADMIN_UIDS). */
export interface DebugConfig {
  skillRef: string
  systemPrompt: string
  /** '' | 'vm' = 沙箱 VM + skill（现状路径）；'mcp' = 首轮不建 VM，manager 直连 flight MCP 工具。 */
  routeMode: string
  defaults: { skillRef: string; systemPrompt: string }
  isAdmin: boolean
}
/** Read the global debug config (any authenticated caller). */
export const getDebugConfig = (): Promise<DebugConfig> => json('/debug/config')
/** Write the global debug config (admin only → 403 otherwise). Empty string reverts that field to the
 *  built-in default. The panel re-fetches on success (invalidateQueries), so this just acks. */
export const saveDebugConfig = (patch: { skillRef: string; systemPrompt: string; routeMode: string }): Promise<{ ok: boolean }> =>
  postJson('/debug/config', patch)

export async function loadContent(
  taskId: string,
): Promise<{ task: { id: string; status: string; routeMode?: string }; prompts: PromptContent[] } | null> {
  const r = await fetch(`${BASE}/tasks/${taskId}/content`, { headers: authHeaders() })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`loadContent failed: ${r.status}`)
  const data = (await r.json()) as {
    task: { id: string; status: string; routeMode?: string }
    prompts: Array<Omit<PromptContent, 'attachments'> & { attachments?: AttachmentMeta[] }>
  }
  // Derive rendition URLs client-side (single source: toAttachment) so a reload matches the
  // optimistic view the composer built with the same helper (I0).
  return { task: data.task, prompts: data.prompts.map((p) => ({ ...p, attachments: p.attachments?.map(toAttachment) })) }
}

/** Streams frames for a prompt. Calls onFrame per frame, onDone when the turn
 *  ends. Returns a stop() to close early. */
export function streamPrompt(
  promptId: string,
  onFrame: (seq: number, data: unknown) => void,
  onDone: (status: string) => void,
  onWaiting: () => void,
  fromSeq = 0,
): () => void {
  // fromSeq resumes after frames already loaded (reload-reattach): the SSE endpoint streams only
  // seq > fromSeq. EventSource can't set Last-Event-ID on a fresh connect, so it rides as a query
  // param (withAuthQuery merges it with the auth params); auto-reconnects then send Last-Event-ID.
  const es = new EventSource(withAuthQuery(`${BASE}/prompts/${promptId}/stream`, fromSeq ? { fromSeq: String(fromSeq) } : undefined))
  es.onmessage = (e) => {
    const seq = Number(e.lastEventId) || 0
    try { onFrame(seq, JSON.parse(e.data)) } catch { /* ignore malformed */ }
  }
  es.addEventListener('done', (e) => {
    es.close()
    try { onDone(JSON.parse((e as MessageEvent).data).status) } catch { onDone('completed') }
  })
  es.addEventListener('waiting', () => {
    // This is an intentional server-side pause, not a broken connection.
    // Close locally so EventSource does not auto-reconnect while the user is idle.
    es.close()
    onWaiting()
  })
  es.onerror = () => {
    // Transient drop → EventSource auto-reconnects (readyState CONNECTING). A terminal failure
    // (CLOSED — 4xx / prompt gone, no retry) would otherwise leave busy stuck + the stream entry
    // open, blocking reload-reattach — so finish it, freeing the entry for a later reattach.
    if (es.readyState === EventSource.CLOSED) onDone('error')
  }
  return () => es.close()
}

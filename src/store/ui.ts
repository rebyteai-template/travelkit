import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { PassengerDraft } from '../booking.ts'
import { TENANT_ID } from '../api.ts'

// The current session lives in the URL (?t=…) so refresh / deep-link restores it.
// Identity comes from the embed handoff, so a session belongs to a tenant, not a tab.
const LAST_TASK_KEY_PREFIX = 'tripdesk-last-task-v1'

function readUrlTaskId(): string | null {
  return new URLSearchParams(location.search).get('t')
}

function lastTaskKey(): string | null {
  return TENANT_ID ? `${LAST_TASK_KEY_PREFIX}-${TENANT_ID}` : null
}

function readLastTaskId(): string | null {
  const key = lastTaskKey()
  if (!key) return null
  try {
    return localStorage.getItem(key) || null
  } catch {
    return null
  }
}

function rememberLastTaskId(id: string): void {
  const key = lastTaskKey()
  if (!key) return
  try {
    localStorage.setItem(key, id)
  } catch {
    /* ignore */
  }
}

function readInitialTaskId(): string | null {
  return readUrlTaskId() ?? readLastTaskId()
}

function writeUrlTaskId(id: string | null): void {
  const u = new URL(location.href)
  if (id) u.searchParams.set('t', id)
  else u.searchParams.delete('t')
  history.replaceState(null, '', u)
}

const _taskIdAtom = atom<string | null>(readInitialTaskId())
/** Current session id. Reads are plain; writes also mirror to the URL (?t=). */
export const taskIdAtom = atom(
  (get) => get(_taskIdAtom),
  (_get, set, id: string | null) => {
    set(_taskIdAtom, id)
    writeUrlTaskId(id)
    if (id) rememberLastTaskId(id)
  },
)

/** Booking write-flow step. 'auto' = nothing active (the inline verify card shows its CTA);
 *  the others are driven by UI gestures and render inline at the chat tail. */
export type FlowMode = 'auto' | 'passengers' | 'confirm'
export const flowModeAtom = atom<FlowMode>('auto')

/** In-progress passenger details for the current order draft. */
export const orderDraftAtom = atom<PassengerDraft[]>([])

/** planId of the ONE recommended plan being booked, or null. Passenger collection is
 *  conversational (the agent asks; operators paste WeChat text / spreadsheets), so this
 *  is the entire flow state: while set, the matching recommend-book result renders the
 *  confirm gate at the chat tail. It deliberately SURVIVES ordinary user turns (they are
 *  the collection); cleared on cancel, on confirm, when the plan leaves every table, or
 *  on session switch — keyed by planId so a stale plan can never be confirmed against a
 *  fresh result. */
export const planBookingPlanIdAtom = atom<string | null>(null)

/** Mobile session drawer open/closed. */
export const navOpenAtom = atom(false)

// Light/dark, persisted as a raw string under the legacy key so existing users
// keep their choice (default JSON storage would fail to parse the old raw value).
const rawThemeStorage = {
  getItem: (key: string, initial: 'light' | 'dark'): 'light' | 'dark' => {
    try {
      const v = localStorage.getItem(key)
      return v === 'dark' || v === 'light' ? v : initial
    } catch {
      return initial
    }
  },
  setItem: (key: string, value: 'light' | 'dark') => {
    try { localStorage.setItem(key, value) } catch { /* ignore */ }
  },
  removeItem: (key: string) => {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  },
}
export const themeAtom = atomWithStorage<'light' | 'dark'>('tripdesk-theme', 'light', rawThemeStorage)

/** Hidden debug mode (revealed by tapping the brand 10×) — gates the right-side debug config panel
 *  (global skill-ref + manager-prompt config, and "new VM"). Session-only: a reload hides it again
 *  until the next 10-tap. The config it edits is GLOBAL and server-stored (not this atom) — see
 *  hooks/useDebugConfig.ts. */
export const debugAtom = atom(false)

// A brand-new session has no taskId yet, so its first send is "busy" only via this
// flag during the createTask round-trip. Lives here (not in conversation.ts) so the
// nav actions below can clear it when the user leaves the new-session slot.
export const creatingAtom = atom(false)

// Bumped on every explicit session navigation (new / open). An in-flight createTask
// snapshots this before awaiting and, if it changed, declines to adopt its task as
// the current view — so a slow POST can't yank the user back after they've moved on.
export const navEpochAtom = atom(0)

/** Reset to a brand-new session (clears the task + its draft/write-flow state). */
export const newSessionAtom = atom(null, (get, set) => {
  set(taskIdAtom, null)
  set(orderDraftAtom, [])
  set(flowModeAtom, 'auto')
  set(planBookingPlanIdAtom, null)
  set(navOpenAtom, false)
  set(creatingAtom, false) // a prior new-session createTask must not keep this slot busy
  set(navEpochAtom, get(navEpochAtom) + 1)
})

/** Open an existing session: switch task, reset transient write-flow state, close drawer. */
export const openSessionAtom = atom(null, (get, set, id: string) => {
  set(taskIdAtom, id)
  set(orderDraftAtom, [])
  set(flowModeAtom, 'auto')
  set(planBookingPlanIdAtom, null)
  set(navOpenAtom, false)
  set(creatingAtom, false)
  set(navEpochAtom, get(navEpochAtom) + 1)
})

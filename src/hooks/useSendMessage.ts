import { useCallback } from 'react'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { createTask, followup, toAttachment, type Attachment, type AttachmentMeta } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'
import { attachStream } from '../lib/stream.ts'
import { flowModeAtom, creatingAtom, navEpochAtom, taskIdAtom } from '../store/ui.ts'
import { addTurnAtom, busyTasksAtom, markBusyAtom } from '../store/conversation.ts'

// The Provider-less default store — lets us read live atom values AFTER an await
// (closures captured stale values at call time).
const store = getDefaultStore()

/**
 * Returns `send(text, atts?)` — the one turn-driver. New session → createTask, otherwise
 * followup; then optimistically add the turn (with any attachments), mark THIS task busy, and
 * stream frames into the jotai store. On done it clears that task's busy and refetches sessions
 * + this task's content so the server snapshot catches up.
 *
 * The busy/creating guards are per-session, so a running task never blocks sending from a
 * different or brand-new session (this is the multi-task fix).
 */
export function useSendMessage() {
  const qc = useQueryClient()
  const taskId = useAtomValue(taskIdAtom)
  const busyTasks = useAtomValue(busyTasksAtom)
  const creating = useAtomValue(creatingAtom)
  const setTaskId = useSetAtom(taskIdAtom)
  const setMode = useSetAtom(flowModeAtom)
  const setCreating = useSetAtom(creatingAtom)
  const addTurn = useSetAtom(addTurnAtom)
  const markBusy = useSetAtom(markBusyAtom)

  return useCallback(
    async (text: string, atts?: AttachmentMeta[]) => {
      const sessionId = taskId
      // Re-entry guard scoped to the targeted session; other sessions stay free.
      if (sessionId) {
        if (busyTasks.has(sessionId)) return
      } else {
        if (creating) return
        setCreating(true)
      }
      setMode('auto') // any new turn closes a half-open write-flow step (form/confirm)
      // The plan-booking flow deliberately survives here: ordinary user turns ARE its
      // passenger collection (the agent asks, the operator pastes). App clears it on
      // cancel/confirm/plan-vanish instead.
      // An attachment-only send (empty text) is allowed (like rebyte): the bubble shows just the
      // thumbnail, and the server supplies a neutral wire-prompt stand-in for the manager. So we
      // pass the user's text through verbatim (possibly empty) — the empty UI text keeps the bubble
      // image-only and matches on reload (I0).
      let tid = sessionId
      try {
        // Attachments were already uploaded by the composer (eager, on paste/drop). Build the
        // optimistic bubble with the SAME toAttachment helper the reload path uses (I0); the relay
        // refs that ride on the turn are the same metadata, narrowed to {id, filename}.
        const attachments: Attachment[] | undefined = atts?.length ? atts.map(toAttachment) : undefined
        const refs = atts?.map((a) => ({ id: a.fileId, filename: a.filename }))
        let pid: string
        if (!tid) {
          const epochBefore = store.get(navEpochAtom)
          const r = await createTask(text, refs)
          tid = r.taskId
          pid = r.promptId
          // Only adopt the new task as the current view if the user hasn't navigated
          // to another (or a fresh) session while createTask was in flight. Either
          // way the task still runs in the background and shows in the session list.
          if (store.get(navEpochAtom) === epochBefore) setTaskId(r.taskId)
          void qc.invalidateQueries({ queryKey: queryKeys.sessions() })
        } else {
          const r = await followup(tid, text, refs)
          pid = r.promptId
        }
        const ttid = tid
        // Stamp the optimistic turn so its bubble shows a time immediately (ISO → parseTs passes
        // it through). The on-done refetch later replaces this with the server's created_at/completed_at.
        addTurn({ taskId: ttid, prompt: { id: pid, prompt: text, frames: [], attachments, created_at: new Date().toISOString() } })
        // Open the live stream (busy + frame append + on-done refetch). Shared with the
        // reload-reattach path (useConversation) via lib/stream.ts so it's never doubled.
        attachStream(qc, ttid, pid)
      } catch (e) {
        console.error(e)
        if (tid) markBusy({ taskId: tid, on: false })
      } finally {
        // taskId is now set and the task marked busy, so releasing the new-session
        // guard can't cause a double-create — busyTasks covers it from here.
        setCreating(false)
      }
    },
    [taskId, busyTasks, creating, qc, setTaskId, setMode, setCreating, addTurn, markBusy],
  )
}

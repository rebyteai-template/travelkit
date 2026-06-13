import { useCallback } from 'react'
import { getDefaultStore, useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { createTask, followup } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'
import { attachStream } from '../lib/stream.ts'
import { flowModeAtom, creatingAtom, navEpochAtom, taskIdAtom } from '../store/ui.ts'
import { addTurnAtom, busyTasksAtom, markBusyAtom } from '../store/conversation.ts'

// The Provider-less default store — lets us read live atom values AFTER an await
// (closures captured stale values at call time).
const store = getDefaultStore()

/**
 * Returns `send(text)` — the one turn-driver. New session → createTask, otherwise
 * followup; then optimistically add the turn, mark THIS task busy, and stream
 * frames into the jotai store. On done it clears that task's busy and refetches
 * sessions + this task's content so the server snapshot catches up.
 *
 * The busy/creating guards are per-session, so a running task never blocks sending
 * from a different or brand-new session (this is the multi-task fix).
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
    async (text: string) => {
      const sessionId = taskId
      // Re-entry guard scoped to the targeted session; other sessions stay free.
      if (sessionId) {
        if (busyTasks.has(sessionId)) return
      } else {
        if (creating) return
        setCreating(true)
      }
      setMode('auto') // any new turn closes a half-open write-flow step (form/confirm)
      let tid = sessionId
      try {
        let pid: string
        if (!tid) {
          const epochBefore = store.get(navEpochAtom)
          const r = await createTask(text)
          tid = r.taskId
          pid = r.promptId
          // Only adopt the new task as the current view if the user hasn't navigated
          // to another (or a fresh) session while createTask was in flight. Either
          // way the task still runs in the background and shows in the session list.
          if (store.get(navEpochAtom) === epochBefore) setTaskId(r.taskId)
          void qc.invalidateQueries({ queryKey: queryKeys.sessions() })
        } else {
          const r = await followup(tid, text)
          pid = r.promptId
        }
        const ttid = tid
        addTurn({ taskId: ttid, prompt: { id: pid, prompt: text, frames: [] } })
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

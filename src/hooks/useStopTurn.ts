import { useCallback } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { cancelPrompt } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'
import { taskIdAtom } from '../store/ui.ts'
import { currentBusyAtom, currentTurnsAtom, markBusyAtom } from '../store/conversation.ts'

/**
 * Returns `stop()` for the open session's in-flight turn, or undefined when there is nothing
 * cancelable — idle, or the brand-new-session window where createTask hasn't returned a promptId
 * yet (the composer shows a disabled stop button then; the window is one POST wide).
 *
 * On server ack it clears busy itself instead of waiting for the SSE `done`: a turn parked in
 * waiting_for_answer has NO open stream (stream.ts closes on `waiting`), so nothing else would
 * ever clear it. When a stream IS live, its later `done` cleanup is idempotent on top of this.
 * A failed cancel request leaves busy alone — the turn really is still running.
 */
export function useStopTurn(): (() => void) | undefined {
  const qc = useQueryClient()
  const taskId = useAtomValue(taskIdAtom)
  const turns = useAtomValue(currentTurnsAtom)
  const busy = useAtomValue(currentBusyAtom)
  const markBusy = useSetAtom(markBusyAtom)
  const lastId = turns.at(-1)?.id

  const stop = useCallback(() => {
    if (!taskId || !lastId) return
    void cancelPrompt(lastId)
      .then(() => {
        markBusy({ taskId, on: false })
        void qc.invalidateQueries({ queryKey: queryKeys.taskContent(taskId) })
        void qc.invalidateQueries({ queryKey: queryKeys.sessions() })
      })
      .catch((e) => console.error('cancel failed', e))
  }, [qc, taskId, lastId, markBusy])

  return busy && taskId && lastId ? stop : undefined
}

import { useEffect, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useQueryClient } from '@tanstack/react-query'
import { derive } from '../frames.ts'
import { taskIdAtom } from '../store/ui.ts'
import { currentBusyAtom, currentTurnsAtom, hydrateTurnsAtom } from '../store/conversation.ts'
import { attachStream } from '../lib/stream.ts'
import { useTaskContent } from './useTaskContent.ts'

/**
 * Orchestrates the open session: fetches the server snapshot (React Query),
 * hydrates it into the jotai conversation store, and derives the chat view from
 * the live working copy. Components read only `{ view, busy }`.
 *
 * Server state (RQ) and live stream state (jotai) meet here and nowhere else.
 */
export function useConversation() {
  const qc = useQueryClient()
  const taskId = useAtomValue(taskIdAtom)
  const { data } = useTaskContent(taskId)
  const hydrate = useSetAtom(hydrateTurnsAtom)
  const turns = useAtomValue(currentTurnsAtom)
  const busy = useAtomValue(currentBusyAtom)

  useEffect(() => {
    if (taskId && data?.prompts) hydrate({ taskId, prompts: data.prompts })
  }, [taskId, data, hydrate])

  // Reload / deep-link reattach: if the latest turn is still running server-side (the user
  // refreshed mid-turn, or the long SSE got dropped), re-join its stream from the frames we just
  // loaded — so progress + the "正在处理…" indicator resume and the answer lands without a manual
  // refresh, and the per-task busy guard is restored. attachStream is idempotent per promptId, so
  // this never doubles send()'s own stream for a turn started in this same tab.
  useEffect(() => {
    const prompts = data?.prompts
    if (!taskId || !prompts?.length) return
    const last = prompts[prompts.length - 1]
    if (!last || last.status !== 'running') return
    const fromSeq = last.frames.reduce((m, f) => (f.seq > m ? f.seq : m), 0)
    attachStream(qc, taskId, last.id, fromSeq)
  }, [taskId, data, qc])

  const view = useMemo(() => derive(turns), [turns])
  return { view, busy }
}

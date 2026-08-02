import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getDebugConfig, saveDebugConfig, type DebugConfig } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** The GLOBAL debug config (skill ref + manager prompt) shared by all users. Only fetched when the
 *  panel is mounted (App gates it on debugAtom). Not persisted (see queryKeys) → always fresh. */
export function useDebugConfig() {
  return useQuery({ queryKey: queryKeys.debugConfig(), queryFn: getDebugConfig })
}

/** Save the global config (admin only; 403 otherwise). On success it writes the saved values into
 *  the cache immediately — so the panel's "dirty" flag clears at once and the button settles to
 *  已保存 with no refetch flicker — then invalidates to reconcile with the server. */
export function useSaveDebugConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: saveDebugConfig,
    onSuccess: (_res, patch) => {
      qc.setQueryData(queryKeys.debugConfig(), (old?: DebugConfig) =>
        old ? { ...old, skillRef: patch.skillRef, systemPrompt: patch.systemPrompt, routeMode: patch.routeMode } : old)
      void qc.invalidateQueries({ queryKey: queryKeys.debugConfig() })
    },
  })
}

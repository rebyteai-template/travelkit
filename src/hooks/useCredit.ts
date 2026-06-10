import { useQuery } from '@tanstack/react-query'
import { getCredit } from '../api.ts'
import { queryKeys } from '../lib/queryKeys.ts'

/** Org credit status for the low-balance banner. Credit is only burned by running turns, so
 *  this is event-driven, not polled: fetched once on mount and invalidated after each turn
 *  (useSendMessage). The long staleTime also collapses the mount/focus refetches into the
 *  cache, so an idle tab makes no request. `enabled` gates it behind a valid embed (skip on 401). */
export function useCredit(enabled = true) {
  return useQuery({
    queryKey: queryKeys.credit(),
    queryFn: getCredit,
    enabled,
    staleTime: 5 * 60_000,
  })
}

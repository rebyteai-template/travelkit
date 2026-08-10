import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { listReferencePrices, saveReferencePrice, type ReferencePrice } from '../api.ts'
import { queryKeys, queryEnabled } from '../lib/queryKeys.ts'

/** The Ctrip figures recorded for one task, indexed by planId for the table.
 *  Disabled until a task is selected, same as useTaskContent. */
export function useReferencePrices(taskId: string | null) {
  const query = useQuery({
    queryKey: queryKeys.referencePrices(taskId ?? ''),
    queryFn: () => listReferencePrices(taskId as string),
    enabled: queryEnabled.referencePrices(taskId),
  })

  const byPlan: Record<string, ReferencePrice> = {}
  for (const price of query.data ?? []) byPlan[price.planId] = price
  return { byPlan, isLoading: query.isLoading }
}

/** Record one plan's Ctrip figure. Refetches the task's list on success rather than patching the
 *  cache: the server normalizes amount/currency/capturedAt, so the stored row is the truth and a
 *  hand-rolled optimistic entry could disagree with it. */
export function useSaveReferencePrice(taskId: string | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      planId: string
      amount: number
      currency: string
      source: 'manual' | 'ctrip-extension'
      sourceUrl?: string | null
      capturedAt?: string
      raw?: unknown
    }) => {
      const { planId, ...price } = input
      return saveReferencePrice(taskId as string, planId, price)
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.referencePrices(taskId ?? '') })
    },
  })
}

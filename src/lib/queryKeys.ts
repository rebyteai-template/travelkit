/**
 * Centralised query-key factory (cctools convention, packages/shared/hooks/
 * query-keys.ts). Every key is built here and returns an `as const` tuple; the
 * head string is what `shouldDehydrateQuery` uses to allow/deny persistence.
 * Never inline a key array in a component — go through this object.
 */
export const queryKeys = {
  me: () => ['me'] as const,
  credit: () => ['credit'] as const,
  sessions: () => ['sessions'] as const,
  taskContent: (taskId: string) => ['taskContent', taskId] as const,
  debugConfig: () => ['debugConfig'] as const,
  referencePrices: (taskId: string) => ['referencePrices', taskId] as const,
}

/** Enable conditions for queries whose params may be absent. */
const hasTask = (taskId: string | null | undefined) => !!taskId
export const queryEnabled = {
  taskContent: hasTask,
  referencePrices: hasTask,
}

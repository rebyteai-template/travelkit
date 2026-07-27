import type { AgentActivityRun } from '../agent-activity.ts'
import { parseTs } from '../lib/time.ts'

function durationLabel(run: AgentActivityRun): string {
  const startedAt = parseTs(run.startedAt)
  const completedAt = parseTs(run.completedAt)
  if (!startedAt || !completedAt) return ''
  const seconds = Math.max(1, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder ? `${minutes}m${remainder}s` : `${minutes}m`
}

function activeLabel(run: AgentActivityRun): string {
  if (run.phase === 'connecting') return '正在连接实时航班数据…'
  if (run.phase === 'searching') return '正在搜索符合条件的航班…'
  if (run.phase === 'comparing') {
    return run.candidateCount !== undefined
      ? `已找到 ${run.candidateCount} 个候选，正在比较价格和时间…`
      : '正在比较航班价格和时间…'
  }
  if (run.phase === 'verifying') return '正在核验候选方案的实时价格…'
  if (run.phase === 'recommending') return '正在整理推荐方案…'
  return '正在确认行程条件…'
}

function completedLabel(run: AgentActivityRun): string {
  const facts: string[] = []
  if (run.candidateCount === 0) {
    facts.push('未找到符合条件的航班')
  } else if (run.candidateCount !== undefined) {
    facts.push(`已比较 ${run.candidateCount} 个航班`)
  } else {
    facts.push('行程处理完成')
  }
  if (run.verifiedCount) facts.push(`核验 ${run.verifiedCount} 个方案`)
  const duration = durationLabel(run)
  if (duration) facts.push(`用时 ${duration}`)
  return facts.join(' · ')
}

export function AgentStatus({ run }: { run: AgentActivityRun }) {
  if (run.state === 'waiting') return null

  if (run.state === 'active') {
    return (
      <div className="agent-status is-active" role="status" aria-live="polite">
        <span className="agent-status-spinner" aria-hidden="true" />
        <span>{activeLabel(run)}</span>
      </div>
    )
  }

  return (
    <div
      className={`agent-status is-${run.state}`}
      role={run.state === 'error' ? 'alert' : 'status'}
    >
      <span className="agent-status-mark" aria-hidden="true">
        {run.state === 'error' ? '!' : '✓'}
      </span>
      <span>{run.state === 'error' ? '行程处理未完成' : completedLabel(run)}</span>
    </div>
  )
}

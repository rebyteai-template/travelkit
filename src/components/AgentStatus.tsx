import { useState } from 'react'
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
  if (run.phase === 'book-verifying') return '正在下单前重新验价…'
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

/** Copy-the-run-id affordance on the completed status line. Hidden until the row is hovered;
 *  a click copies the raw run id (what a user/PM hands back to report a problem) and briefly
 *  confirms. Not a link: the embedded workbench user has no rebyte dashboard login to click
 *  through with — the id itself is the debugging handle. */
/** Copy `text`, working in BOTH the top frame and an embedded iframe.
 *
 *  travelkit runs inside the TripDesk iframe in production, where the async Clipboard API
 *  is usually blocked (the embedder rarely grants the `clipboard-write` permission policy).
 *  So try the legacy execCommand path FIRST — it runs synchronously inside the click's user
 *  activation and does not need that policy — and fall back to the async API only when
 *  execCommand is unavailable (some browsers disable it). Returns whether a copy actually
 *  happened, so the UI never claims success it did not achieve. */
function copyText(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    if (ok) return true
  } catch {
    // fall through to the async path
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => undefined)
    return true
  }
  return false
}

function CopyRunId({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (copyText(runId)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <button
      type="button"
      className="run-id-copy"
      onClick={copy}
      title={copied ? '已复制运行编号' : `复制运行编号（报障用）\n${runId}`}
      aria-label="复制运行编号"
    >
      {copied ? (
        <span className="run-id-copied" aria-hidden="true">✓ 已复制</span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  )
}

export function AgentStatus({ run, runId }: { run: AgentActivityRun; runId?: string }) {
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
      {runId ? <CopyRunId runId={runId} /> : null}
    </div>
  )
}

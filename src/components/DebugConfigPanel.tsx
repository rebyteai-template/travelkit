import { useState, type ReactNode } from 'react'
import { useDebugConfig, useSaveDebugConfig } from '../hooks/useDebugConfig.ts'
import { useNewSandbox } from '../hooks/useNewSandbox.ts'
import type { DebugConfig } from '../api.ts'

/** One text override: a labelled textarea, with 填入默认 / 清空 and a hint. Presentational — the
 *  parent owns the edited value. Empty value = use the server default (shown as placeholder). */
function OverrideField(props: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  def: string
  rows: number
  disabled: boolean
  hint: ReactNode
}) {
  return (
    <>
      <label className="debug-label" htmlFor={props.id}>{props.label}</label>
      <textarea
        id={props.id}
        className="debug-input"
        value={props.value}
        placeholder={props.def}
        onChange={(e) => props.onChange(e.target.value)}
        rows={props.rows}
        spellCheck={false}
        disabled={props.disabled}
      />
      <div className="debug-actions">
        <button className="debug-ghost" onClick={() => props.onChange(props.def)} disabled={props.disabled}>填入默认</button>
        <button className="debug-ghost" onClick={() => props.onChange('')} disabled={props.disabled || !props.value.trim()}>清空</button>
      </div>
      <p className="debug-hint">{props.value.trim() ? '当前用自定义值。' : '留空 = 用默认。'} {props.hint}</p>
    </>
  )
}

/** The editable config body — mounted only once `data` is loaded, so it seeds its form state at mount
 *  (no effect, no nullable union). A background refetch updates `data` (→ `dirty` recomputes) without
 *  clobbering in-progress edits, and after a save the echoed values match, so no re-seed is needed. */
function ConfigForm({ data }: { data: DebugConfig }) {
  const save = useSaveDebugConfig()
  const [form, setForm] = useState(() => ({ skillRef: data.skillRef, systemPrompt: data.systemPrompt, routeMode: data.routeMode }))
  const admin = data.isAdmin
  const dirty = form.skillRef !== data.skillRef || form.systemPrompt !== data.systemPrompt || form.routeMode !== data.routeMode
  const mcpDirect = form.routeMode === 'mcp'

  return (
    <>
      <div className="debug-label">机票路由</div>
      <div className="debug-actions">
        <button
          className={mcpDirect ? 'debug-ghost' : 'debug-btn'}
          onClick={() => setForm({ ...form, routeMode: '' })}
          disabled={!admin}
        >
          沙箱 VM + Skill
        </button>
        <button
          className={mcpDirect ? 'debug-btn' : 'debug-ghost'}
          onClick={() => setForm({ ...form, routeMode: 'mcp' })}
          disabled={!admin}
        >
          直连 MCP 工具
        </button>
      </div>
      <p className="debug-hint">
        {mcpDirect
          ? '直连：首轮不开 VM，manager 直接调 flight_recommend / flight_recommendation_get（路由约定随首轮 prompt 下发）。'
          : '现状路径：首轮开每租户沙箱 VM 并安装 skill，机票委派沙箱执行。'}
        {' '}所有 OP 共用，<b>下个新会话</b>生效。
      </p>

      <div className="debug-sep" />

      <OverrideField
        id="skill-ref"
        label="Skill GitHub 地址"
        value={form.skillRef}
        onChange={(v) => setForm({ ...form, skillRef: v })}
        def={data.defaults.skillRef}
        rows={3}
        disabled={!admin}
        hint={<>贴 GitHub URL(repo 或 skill 目录,不用加 <code>github:</code> 前缀);所有 OP 共用,各自<b>下个新会话</b>生效。</>}
      />

      <div className="debug-sep" />

      <OverrideField
        id="sys-prompt"
        label="Manager 系统提示词"
        value={form.systemPrompt}
        onChange={(v) => setForm({ ...form, systemPrompt: v })}
        def={data.defaults.systemPrompt}
        rows={8}
        disabled={!admin}
        hint={<>前线 manager 领域提示词（路由 / 防编造）；<b>下个新会话</b>生效。</>}
      />

      <button
        className="debug-btn"
        onClick={() => save.mutate(form)}
        disabled={!admin || !dirty || save.isPending}
      >
        {save.isPending ? '保存中…' : dirty ? '保存（对所有 OP 生效）' : '已保存'}
      </button>
      {!admin && <p className="debug-hint">你不是管理员（uid 不在 ADMIN_UIDS），只能查看。</p>}
      {save.isError && <p className="debug-hint">保存失败：{(save.error as Error).message}</p>}
    </>
  )
}

/**
 * Right-side debug config panel — revealed by the 10× brand tap (App gates it on debugAtom).
 * Mirrors rebyte-app-kit's SettingsPanel card. The skill ref + manager prompt are ONE GLOBAL config
 * shared by every OP (server-stored in `kv`, read by the worker at task creation) — editing here
 * changes it for everyone, so saving is admin-gated (uid ∈ ADMIN_UIDS); non-admins get read-only.
 * The "new VM" button is per-caller (only affects your own sandbox).
 */
export function DebugConfigPanel() {
  const cfg = useDebugConfig()
  const newVm = useNewSandbox()

  const vmLabel = newVm.isPending
    ? '新建中…'
    : newVm.isError
      ? '❌ 失败，点击重试'
      : newVm.isSuccess
        ? `✅ 已就绪${newVm.data?.sandboxId ? ' · ' + newVm.data.sandboxId.slice(0, 8) : ''}`
        : '为当前账号新建 VM'

  return (
    <aside className="debug-panel" aria-label="调试配置">
      <div className="debug-card">
        <div className="debug-head">
          <span className="debug-title">全局调试配置</span>
          <span className="debug-badge">{cfg.data && !cfg.data.isAdmin ? '只读' : 'DEV'}</span>
        </div>

        {cfg.isLoading && <p className="debug-hint">加载中…</p>}
        {cfg.isError && <p className="debug-hint">读取配置失败，请刷新重试。</p>}
        {cfg.data && <ConfigForm data={cfg.data} />}

        <div className="debug-sep" />

        <div className="debug-label">沙箱 VM（仅你自己）</div>
        <button
          className="debug-btn"
          onClick={() => newVm.mutate()}
          disabled={newVm.isPending}
          title="为当前用户新建一个沙箱 VM（旧的弃用）"
        >
          {vmLabel}
        </button>
        <p className="debug-hint">新 VM 在你<b>下个新会话</b>绑定；只影响你自己，不影响别的 OP。</p>
      </div>
    </aside>
  )
}

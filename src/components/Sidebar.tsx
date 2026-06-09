import type { ReactNode } from 'react'
import type { SessionSummary } from '../api.ts'

/** ChatGPT-style left rail: brand + "new chat" button up top, scrollable history
 *  below, account/theme footer. Static column on desktop; a slide-in drawer on
 *  mobile (toggled by the mobile bar's hamburger, dismissed by the backdrop).
 *  `children` is an optional slot under the new-chat button — App uses it for the
 *  hidden debug control so sandbox plumbing stays out of this presentational rail. */
export function Sidebar({
  email,
  sessions,
  currentId,
  onSelect,
  onNew,
  open,
  onClose,
  theme,
  onToggleTheme,
  onTapBrand,
  children,
}: {
  email: string
  sessions: SessionSummary[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  open: boolean
  onClose: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  onTapBrand: () => void
  children?: ReactNode
}) {
  return (
    <>
      {open && <div className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand" onClick={onTapBrand}>Kitty</span>
        </div>

        <button className="sidebar-new" onClick={onNew}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
          </svg>
          <span>新会话</span>
        </button>

        {children}

        <div className="sidebar-head">会话</div>
        <div className="sidebar-list">
          {sessions.length === 0 && <div className="sidebar-empty">还没有会话</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`session${s.id === currentId ? ' active' : ''}`}
              onClick={() => onSelect(s.id)}
              title={s.title}
            >
              <span className="session-title">{s.title || '新会话'}</span>
              <span className="session-meta">{s.created_at.slice(5, 16)}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          {email && <span className="sidebar-user" title={email}>{email}</span>}
          <button
            className="theme-toggle ghost"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            title={theme === 'dark' ? '浅色' : '深色'}
          >
            {theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
            )}
          </button>
        </div>
      </aside>
    </>
  )
}

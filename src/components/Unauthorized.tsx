/**
 * Shown when the app is opened without a valid embed handoff (missing/wrong key, or no uid):
 * /api/app/me returns 401, so we render this instead of a broken workbench. It's the friendly
 * face of the gate — the real protection is the API rejecting the call server-side.
 */
export function Unauthorized() {
  return (
    <div className="unauth">
      <div className="unauth-card">
        <div className="unauth-lock" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h1>无法访问 Kitty</h1>
        <p>此页面需从企业后台内打开。请回到管理后台，在 Kitty 标签页中进入。</p>
        <p className="unauth-sub">若你认为这是误判，请联系系统管理员确认你的访问凭证。</p>
      </div>
    </div>
  )
}

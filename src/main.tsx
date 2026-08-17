import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { QueryPersistGate } from './components/QueryPersistGate.tsx'
import './kami-tokens.css'
import './styles.css'

// A path, deliberately NOT a hash: the hash is the embed handoff's credential channel — api.ts
// reads `uid`/`org`/`token` out of it and immediately `replaceState`s it away, so a hash route
// would be erased the moment the app's modules load. `/ctrip-probe` is a manual bench for the
// Ctrip matcher, served by the dev server's SPA fallback and deliberately unlinked.
const bench = window.location.pathname === '/ctrip-probe'
// Lazy so the bench (and the DOM matcher it pulls in) stays out of every user's app bundle.
const CtripProbePage = lazy(() => import('./components/CtripProbePage.tsx').then((m) => ({ default: m.CtripProbePage })))

// React Query (server state, persisted per tenant) wraps the app; jotai (UI +
// streaming state) uses its default global store, so no Provider is needed.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryPersistGate>
      {bench ? <Suspense fallback={null}><CtripProbePage /></Suspense> : <App />}
    </QueryPersistGate>
  </StrictMode>,
)

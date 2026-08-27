// The polyfill must be initialized before anything touches document.modelContext.
// Note: the ESM entry has NO side effect -- a bare `import` installs nothing, so
// initializeWebMCPPolyfill() must be called explicitly. In a natively-supporting
// browser (Chrome OT, ChatGPT in-app) it defers to the built-in implementation.
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { clearSyncTraces, registerCallCount, registeredToolNames, syncTraces } from './webmcp'

initializeWebMCPPolyfill()

// Diagnostic handle for the browser harness. Read-only: it exposes the
// registration lifecycle trace so a real browser run can prove
// desired -> registered -> removed at every transition. It grants no
// capability, registers no tool and mutates no state.
;(window as unknown as Record<string, unknown>).__wellauthWebmcp = {
  traces: syncTraces,
  clearTraces: clearSyncTraces,
  registerCalls: registerCallCount,
  registered: registeredToolNames,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

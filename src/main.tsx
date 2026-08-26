// The polyfill must be initialized before anything touches document.modelContext.
// Note: the ESM entry has NO side effect -- a bare `import` installs nothing, so
// initializeWebMCPPolyfill() must be called explicitly. In a natively-supporting
// browser (Chrome OT, ChatGPT in-app) it defers to the built-in implementation.
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

initializeWebMCPPolyfill()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

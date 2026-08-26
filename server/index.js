// WellAuth Gate 0 authoritative backend.
// ponytail: node:http instead of Express -- six routes don't need a framework.

import { createServer } from 'node:http'
import * as store from './state.js'

const PORT = Number(process.env.PORT ?? 8787)

const ROUTES = {
  'GET /api/state': () => store.snapshot(),
  'POST /api/reset': () => store.reset(),
  'POST /api/order-context': () => store.getOrderContext(),
  'POST /api/discover-requirements': () => store.discoverRequirements(),
  'POST /api/find-evidence': (body) => store.findEvidence(body.requirementId),
  'POST /api/inspect-evidence': (body) => store.inspectEvidence(body.evidenceId),
  'POST /api/bind-evidence': (body) => store.bindEvidence(body.requirementId, body.evidenceId),
  'POST /api/prepare': () => store.preparePriorAuthorization(),
  'POST /api/approve': (body) => store.approve(body.packetHash),
  'POST /api/submit': () => store.submitPriorAuthorization(),
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) req.destroy() // bounded: fixtures only, nothing large is legitimate
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })
}

const server = createServer(async (req, res) => {
  // Dev-only permissive CORS so the Vite origin can reach this server.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()

  const handler = ROUTES[`${req.method} ${req.url.split('?')[0]}`]
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: 'NOT_FOUND' }))
  }

  const body = req.method === 'POST' ? await readBody(req) : {}
  const result = handler(body)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(result))
})

server.listen(PORT, () => {
  console.log(`WellAuth authoritative backend on http://localhost:${PORT}`)
})
